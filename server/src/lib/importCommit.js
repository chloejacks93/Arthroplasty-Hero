// Applies an analysed import batch to the database in ONE transaction.
import { tx } from '../db.js';
import { conflict as httpConflict, badRequest } from './errors.js';
import { loadIndex, resolveMapping, analyze, SNAPSHOT_FIELDS, IDENT_FIELDS, UTILIZATION_FIELDS, PROVENANCE_FIELDS, statusFor } from './importEngine.js';
import { normName } from './importFields.js';

const IMPORT_LOCK = 74210002;

export async function loadBatch(db, batchId, { forUpdate = false } = {}) {
  const { rows: [batch] } = await db.query(
    `SELECT b.*, u.full_name AS uploaded_by_name FROM import_batches b JOIN users u ON u.id = b.uploaded_by
      WHERE b.id = $1 ${forUpdate ? 'FOR UPDATE OF b' : ''}`, [batchId]);
  if (!batch) return null;
  const { rows: files } = await db.query(
    `SELECT i.id, i.filename, i.file_sha256, i.sheet_name, i.team_id, t.name AS team_name, i.row_count, i.status,
            i.new_count, i.updated_count, i.duplicate_count, i.conflict_count, i.review_count, i.header_map
       FROM imports i LEFT JOIN teams t ON t.id = i.team_id
      WHERE i.batch_id = $1 ORDER BY i.uploaded_at, i.filename`, [batchId]);
  const { rows } = await db.query(
    `SELECT r.id, r.import_id, r.row_number, r.normalized, r.decision, r.decision_target, r.details, r.action,
            r.match_method, r.matched_asset_id, r.resulting_asset_id, r.warnings
       FROM import_rows r JOIN imports i ON i.id = r.import_id
      WHERE i.batch_id = $1`, [batchId]);
  return { batch, files, rows };
}

export async function analyzeBatch(db, loaded) {
  const index = await loadIndex(db);
  const mapping = resolveMapping({ rows: loaded.rows, files: loaded.files, saved: loaded.batch.mapping, index });
  const analysis = analyze({ rows: loaded.rows, files: loaded.files, mapping, index });
  return { index, mapping, analysis };
}

export async function commitBatch(batchId, user) {
  return tx(async (c) => {
    await c.query('SELECT pg_advisory_xact_lock($1)', [IMPORT_LOCK]);
    const loaded = await loadBatch(c, batchId, { forUpdate: true });
    if (!loaded) throw badRequest('Import not found.');
    if (loaded.batch.status !== 'preview') throw httpConflict(`This import was already ${loaded.batch.status}.`);

    const { mapping, analysis, index } = await analyzeBatch(c, loaded);
    const pending = analysis.results.filter((r) => r.action === 'review');
    if (pending.length) {
      throw httpConflict(`${pending.length} row${pending.length > 1 ? 's need' : ' needs'} a decision before this import can be approved.`);
    }

    // 1. Create / resolve mapped teams and facilities.
    const refIds = new Map();
    for (const [k, m] of Object.entries(mapping.teams)) {
      if (m.create) {
        const id = await upsertByName(c, 'teams', { name: m.create.name });
        refIds.set(`new:team:${k}`, id);
      } else if (m.team_id && normName(index.teams.find((t) => t.id === m.team_id)?.name) !== k) {
        await saveAlias(c, 'team', k, m.team_id, user.id);
      }
    }
    for (const [k, m] of Object.entries(mapping.locations)) {
      if (m.create) {
        const id = await upsertByName(c, 'facilities', { name: m.create.name, facility_type: m.create.facility_type });
        refIds.set(`new:facility:${k}`, id);
      } else if (m.facility_id && normName(index.facilities.find((f) => f.id === m.facility_id)?.name) !== k) {
        await saveAlias(c, 'facility', k, m.facility_id, user.id);
      }
    }
    const real = (ref) => (ref && ref.startsWith('new:') ? refIds.get(ref) : ref) || null;
    const { rows: facRows } = await c.query('SELECT id, facility_type FROM facilities');
    const facType = new Map(facRows.map((f) => [f.id, f.facility_type]));

    // 2. Apply rows in order.
    const rowById = new Map(loaded.rows.map((r) => [r.id, r]));
    const assetForRow = new Map(); // rowId -> asset id (new assets in this batch)
    const fileById = new Map(loaded.files.map((f) => [f.id, f]));
    const today = new Date().toISOString().slice(0, 10);
    let conflictsCreated = 0;

    for (const r of analysis.results) {
      const row = rowById.get(r.rowId);
      const fields = row.normalized.fields;
      const file = fileById.get(r.importId);
      let assetId = null;

      if (r.action === 'new') {
        const facility = real(r.facility_ref);
        const hasUtil = UTILIZATION_FIELDS.some((f) => fields[f] != null);
        const cols = {
          reference: fields.reference, asset_type: fields.asset_type,
          team_id: real(r.team_ref), current_facility_id: facility, assigned_rep_id: r.rep_ref || null,
          status: statusFor(facility ? facType.get(facility) : null),
          extra: JSON.stringify(row.normalized.extra || {}),
          utilization_as_of: hasUtil ? today : null,
        };
        for (const f of [...SNAPSHOT_FIELDS, ...IDENT_FIELDS]) if (f !== 'asset_type' && fields[f] != null) cols[f] = fields[f];
        const keys = Object.keys(cols);
        const { rows: [a] } = await c.query(
          `INSERT INTO assets (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
          Object.values(cols));
        assetId = a.id;
        assetForRow.set(r.rowId, assetId);
        // analyze() only creates a new asset when this QR is not linked anywhere yet.
        if (fields.qr_value) await linkQr(c, assetId, fields.qr_value, user.id);
        await event(c, assetId, 'created', user.id, {
          to_facility_id: facility, to_custodian_id: null, to_status: cols.status, import_id: r.importId,
          details: { source: 'spreadsheet', filename: file.filename, row: r.rowNumber },
        });
      } else if (['update', 'duplicate', 'conflict'].includes(r.action)) {
        assetId = r.target.id || assetForRow.get(r.target.rowId);
        if (r.changes.length) {
          const sets = [];
          const vals = [assetId];
          const detail = {};
          let facilityChange = null;
          for (const ch of r.changes) {
            detail[ch.field] = { from: ch.from, to: ch.to };
            if (ch.field === 'qr_value') { await linkQr(c, assetId, ch.to, user.id); continue; }
            if (ch.field === 'current_facility') {
              facilityChange = real(ch.ref);
              vals.push(facilityChange); sets.push(`current_facility_id = $${vals.length}`);
              vals.push(statusFor(facType.get(facilityChange)));
              sets.push(`status = CASE WHEN status IN ('under_investigation','at_warehouse','at_facility') THEN $${vals.length} ELSE status END`);
              continue;
            }
            if (ch.field === 'team') { vals.push(real(ch.ref)); sets.push(`team_id = $${vals.length}`); continue; }
            if (ch.field === 'assigned_rep') { vals.push(ch.ref); sets.push(`assigned_rep_id = $${vals.length}`); continue; }
            vals.push(fields[ch.field]); sets.push(`${ch.field} = $${vals.length}`);
          }
          if (r.changes.some((ch) => UTILIZATION_FIELDS.includes(ch.field))) { vals.push(today); sets.push(`utilization_as_of = $${vals.length}`); }
          if (sets.length) await c.query(`UPDATE assets SET ${sets.join(', ')}, version = version + 1 WHERE id = $1`, vals);
          await event(c, assetId, 'imported', user.id, {
            to_facility_id: facilityChange, import_id: r.importId,
            details: { filename: file.filename, row: r.rowNumber, changes: detail },
          });
        }
        for (const cf of r.conflicts) {
          const dupe = await c.query(
            `SELECT 1 FROM asset_conflicts WHERE asset_id = $1 AND field = $2 AND status = 'open'
               AND coalesce(proposed_value,'') = coalesce($3,'')`, [assetId, cf.field, cf.proposed]);
          if (dupe.rowCount) continue;
          await c.query(
            `INSERT INTO asset_conflicts (asset_id, field, current_value, proposed_value, import_id, row_number, severity, current_ref, proposed_ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [assetId, cf.field, cf.current, cf.proposed, r.importId, r.rowNumber, cf.severity, real(cf.current_ref) || null, real(cf.proposed_ref) || null]);
          conflictsCreated++;
        }
      }

      // Provenance: which spreadsheet supplied which value.
      if (assetId) {
        for (const f of PROVENANCE_FIELDS) {
          if (fields[f] == null) continue;
          await c.query(
            `INSERT INTO asset_field_sources (asset_id, field, value, import_id, row_number) VALUES ($1,$2,$3,$4,$5)
             ON CONFLICT (asset_id, field, import_id) DO UPDATE SET value = EXCLUDED.value, row_number = EXCLUDED.row_number`,
            [assetId, f, String(fields[f]), r.importId, r.rowNumber]);
        }
      }

      await c.query(
        `UPDATE import_rows SET action = $2, match_method = $3, matched_asset_id = $4, resulting_asset_id = $5,
                warnings = $6, details = $7 WHERE id = $1`,
        [r.rowId, r.action, r.method || 'none', r.target?.id || null, assetId, JSON.stringify(r.warnings),
          JSON.stringify({ changes: r.changes, conflicts: r.conflicts, notes: r.notes, target: r.target, candidates: r.candidates, decision: r.decision })]);
    }

    // 3. Per-file and batch totals; history.
    for (const f of loaded.files) {
      const s = analysis.perFile[f.id];
      await c.query(
        `UPDATE imports SET status = 'committed', new_count = $2, updated_count = $3, duplicate_count = $4,
                conflict_count = $5, review_count = $6 WHERE id = $1`,
        [f.id, s.new, s.update + s.conflict, s.duplicate, s.conflicts, s.skip]);
    }
    const result = { ...analysis.summary, conflictsCreated };
    await c.query(
      `UPDATE import_batches SET status = 'committed', committed_at = now(), committed_by = $2, result = $3 WHERE id = $1`,
      [batchId, user.id, JSON.stringify(result)]);

    // 4. Tell the people who resolve conflicts.
    if (conflictsCreated) {
      await c.query(
        `INSERT INTO notifications (user_id, kind, title, body, link, dedupe_key)
         SELECT id, 'import_conflict', $1, $2, '/conflicts', $3
           FROM users WHERE active AND role IN ('admin','manager','inventory')
         ON CONFLICT DO NOTHING`,
        [`${conflictsCreated} import conflict${conflictsCreated > 1 ? 's' : ''} to review`,
          `${user.full_name} imported ${loaded.files.map((f) => f.filename).join(', ')}.`, `import:${batchId}`]);
    }
    return result;
  });
}

async function upsertByName(c, table, values) {
  const keys = Object.keys(values);
  const ins = await c.query(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')})
     ON CONFLICT ((lower(btrim(name)))) DO NOTHING RETURNING id`, Object.values(values));
  if (ins.rows[0]) return ins.rows[0].id;
  const { rows } = await c.query(`SELECT id FROM ${table} WHERE lower(btrim(name)) = lower(btrim($1))`, [values.name]);
  return rows[0].id;
}

async function saveAlias(c, kind, aliasNorm, targetId, userId) {
  await c.query(
    `INSERT INTO name_aliases (kind, alias_norm, target_id, created_by) VALUES ($1,$2,$3,$4)
     ON CONFLICT (kind, alias_norm) DO UPDATE SET target_id = EXCLUDED.target_id`, [kind, aliasNorm, targetId, userId]);
}

async function linkQr(c, assetId, value, userId) {
  await c.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)', [assetId, value.trim(), userId]);
  await event(c, assetId, 'qr_linked', userId, { details: { qr_value: value.trim(), source: 'spreadsheet' } });
}

export async function event(c, assetId, type, actorId, e = {}) {
  await c.query(
    `INSERT INTO asset_events (asset_id, event_type, actor_id, from_facility_id, to_facility_id, from_custodian_id, to_custodian_id,
                               from_status, to_status, import_id, transfer_id, investigation_id, details)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [assetId, type, actorId, e.from_facility_id || null, e.to_facility_id || null, e.from_custodian_id || null,
      e.to_custodian_id || null, e.from_status || null, e.to_status || null, e.import_id || null,
      e.transfer_id || null, e.investigation_id || null, JSON.stringify(e.details || {})]);
}
