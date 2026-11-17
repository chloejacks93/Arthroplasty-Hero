// =====================================================================
// Import engine
// ---------------------------------------------------------------------
// analyze() is a pure function: given the uploaded rows, the batch mapping,
// review decisions and a snapshot of the database, it decides what every row
// would do. The preview screen and the commit both call it, so what the user
// approves is exactly what gets written.
//
// Matching priority (never by name alone):
//   1. Existing QR UUID
//   2. Catalog + serial AND the same Reference  (a serial identifies an
//      instrument SET that can span several trays, so it is never enough alone)
//   3. Reference + Lot, exactly
//   4. Reference only  -> needs a human decision (merge / create new / skip)
//
// Field policy when a row matches an existing asset:
//   * Live custody fields (current facility, team, assigned rep) are never
//     silently overwritten: a difference becomes a conflict for review.
//     Empty live fields are filled.
//   * Reference (asset name) is never changed by an import.
//   * Descriptive / utilisation fields take the newest spreadsheet value.
//   * Two files in the same batch that disagree produce a conflict; the first
//     file's value is kept until someone resolves it.
// =====================================================================
import { normName, serialKey, refLotKey, guessFacilityType, FIELD_LABEL } from './importFields.js';

export const SNAPSHOT_FIELDS = [
  'description', 'source_type', 'asset_type', 'agency', 'source_warehouse', 'source_location',
  'consignment_fee', 'return_date', 'items_count', 'flags', 'notes',
  'set_utilization_factor', 'definition_value', 'total_cases_12m', 'top_hcp', 'top_hcp_sales',
  'top_hcp_cases', 'days_since_last_case',
];
export const IDENT_FIELDS = ['lot', 'catalog_number', 'batch_number', 'serial_number'];
export const UTILIZATION_FIELDS = ['set_utilization_factor', 'definition_value', 'total_cases_12m', 'top_hcp',
  'top_hcp_sales', 'top_hcp_cases', 'days_since_last_case'];
// Fields recorded in per-field provenance.
export const PROVENANCE_FIELDS = ['reference', ...IDENT_FIELDS, ...SNAPSHOT_FIELDS.filter((f) => f !== 'asset_type'), 'qr_value', 'rep_name', 'team_name'];

const same = (a, b) => {
  const na = a === undefined || a === '' ? null : a;
  const nb = b === undefined || b === '' ? null : b;
  if (na === null || nb === null) return na === nb;
  if (typeof na === 'number' || typeof nb === 'number') return Number(na) === Number(nb);
  return String(na).replace(/\s+/g, ' ').trim() === String(nb).replace(/\s+/g, ' ').trim();
};
const display = (v) => (v === null || v === undefined ? null : String(v));

// ---------------------------------------------------------------------
// Database snapshot
// ---------------------------------------------------------------------
export async function loadIndex(db) {
  const [assets, qrs, teams, facilities, users, aliases] = await Promise.all([
    db.query(`SELECT id, asset_no, reference, lot, catalog_number, batch_number, serial_number, team_id,
                     current_facility_id, assigned_rep_id, status, ${SNAPSHOT_FIELDS.join(', ')}
                FROM assets WHERE retired_at IS NULL`),
    db.query(`SELECT asset_id, qr_value FROM asset_qr_codes WHERE active`),
    db.query(`SELECT id, name, active FROM teams`),
    db.query(`SELECT id, name, facility_type, active FROM facilities`),
    db.query(`SELECT id, full_name FROM users WHERE active AND role <> 'system'`),
    db.query(`SELECT kind, alias_norm, target_id FROM name_aliases`),
  ]);
  return {
    assets: assets.rows,
    qrs: qrs.rows,
    teams: teams.rows,
    facilities: facilities.rows,
    users: users.rows,
    aliases: aliases.rows,
  };
}

// ---------------------------------------------------------------------
// Mapping of spreadsheet text values to teams and facilities
// ---------------------------------------------------------------------
/**
 * Returns the effective mapping: saved choices merged over suggestions.
 *   teams[norm]      = { source, team_id } | { source, create: { name } } | { source, ignore: true }
 *   locations[norm]  = { source, facility_id } | { source, create: { name, facility_type } } | { source, ignore: true }
 */
export function resolveMapping({ rows, files, saved = {}, index }) {
  const fileTeam = new Map(files.map((f) => [f.id, f.team_id]));
  const teamValues = new Map();
  const locValues = new Map();
  for (const r of rows) {
    const f = r.normalized.fields;
    if (!fileTeam.get(r.import_id)) {
      const t = f.team_name ?? f.source_warehouse;
      if (t) teamValues.set(normName(t), teamValues.get(normName(t)) || { source: t, count: 0 });
      if (t) teamValues.get(normName(t)).count++;
    }
    if (f.source_location) {
      const k = normName(f.source_location);
      if (!locValues.has(k)) locValues.set(k, { source: f.source_location, count: 0 });
      locValues.get(k).count++;
    }
  }
  const teamByName = new Map(index.teams.map((t) => [normName(t.name), t]));
  const facByName = new Map(index.facilities.map((x) => [normName(x.name), x]));
  const alias = (kind, k) => index.aliases.find((a) => a.kind === kind && a.alias_norm === k)?.target_id;

  const teams = {};
  for (const [k, { source, count }] of teamValues) {
    const s = saved.teams?.[k];
    const validSaved = s && (s.ignore || s.create || index.teams.some((t) => t.id === s.team_id));
    if (validSaved) teams[k] = { ...s, source, count };
    else {
      const id = teamByName.get(k)?.id || alias('team', k);
      teams[k] = id ? { source, count, team_id: id, suggested: true } : { source, count, create: { name: source }, suggested: true };
    }
  }
  const locations = {};
  for (const [k, { source, count }] of locValues) {
    const s = saved.locations?.[k];
    const validSaved = s && (s.ignore || s.create || index.facilities.some((x) => x.id === s.facility_id));
    if (validSaved) locations[k] = { ...s, source, count };
    else {
      const id = facByName.get(k)?.id || alias('facility', k);
      locations[k] = id
        ? { source, count, facility_id: id, suggested: true }
        : { source, count, create: { name: source, facility_type: guessFacilityType(source) }, suggested: true };
    }
  }
  return { teams, locations };
}

// ---------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------
/**
 * @param rows  [{ id, import_id, row_number, normalized: { fields, extra, warnings }, decision, decision_target, details }]
 * @param files [{ id, filename, team_id }] in upload order
 */
export function analyze({ rows, files, mapping, index }) {
  const fileOrder = new Map(files.map((f, i) => [f.id, i]));
  const fileById = new Map(files.map((f) => [f.id, f]));
  const ordered = [...rows].sort((a, b) => fileOrder.get(a.import_id) - fileOrder.get(b.import_id) || a.row_number - b.row_number);

  const teamName = new Map(index.teams.map((t) => [t.id, t.name]));
  const facName = new Map(index.facilities.map((f) => [f.id, f.name]));
  const facType = new Map(index.facilities.map((f) => [f.id, f.facility_type]));
  const userByName = new Map(index.users.map((u) => [normName(u.full_name), u]));
  const userName = new Map(index.users.map((u) => [u.id, u.full_name]));

  // Lookup structures over existing assets; new assets created by earlier rows
  // in this batch are added as "virtual" records so later rows match them.
  const byQr = new Map();
  const bySerialRef = new Map();
  const byRefLot = new Map();
  const byRef = new Map();
  const bySerial = new Map();
  const qrOfAsset = new Map(index.qrs.map((q) => [q.asset_id, q.qr_value]));
  const addToIndex = (rec) => {
    const f = rec.fields;
    if (rec.qr) byQr.set(normName(rec.qr), rec);
    const sk = serialKey(f);
    if (sk) {
      bySerialRef.set(`${sk}|${normName(f.reference)}`, rec);
      if (!bySerial.has(sk)) bySerial.set(sk, []);
      bySerial.get(sk).push(rec);
    }
    byRefLot.set(refLotKey(f), rec);
    const rk = normName(f.reference);
    if (!byRef.has(rk)) byRef.set(rk, []);
    byRef.get(rk).push(rec);
  };
  for (const a of index.assets) {
    addToIndex({
      existing: true, id: a.id, asset_no: a.asset_no, fields: a, qr: qrOfAsset.get(a.id) || null,
      facility_ref: a.current_facility_id, team_ref: a.team_id, rep_ref: a.assigned_rep_id,
    });
  }

  const facilityTarget = (f) => {
    if (!f.source_location) return null;
    const m = mapping.locations[normName(f.source_location)];
    if (!m || m.ignore) return null;
    return m.facility_id || `new:facility:${normName(f.source_location)}`;
  };
  const teamTarget = (f, file) => {
    if (file.team_id) return file.team_id;
    const v = f.team_name ?? f.source_warehouse;
    if (!v) return null;
    const m = mapping.teams[normName(v)];
    if (!m || m.ignore) return null;
    return m.team_id || `new:team:${normName(v)}`;
  };
  const refLabel = (kind, ref) => {
    if (!ref) return null;
    if (ref.startsWith('new:')) {
      const k = ref.split(':').slice(2).join(':');
      return kind === 'facility' ? mapping.locations[k]?.create?.name : mapping.teams[k]?.create?.name;
    }
    return kind === 'facility' ? facName.get(ref) : kind === 'team' ? teamName.get(ref) : userName.get(ref);
  };
  const facilityTypeOf = (ref) => {
    if (!ref) return null;
    if (ref.startsWith('new:')) return mapping.locations[ref.split(':').slice(2).join(':')]?.create?.facility_type;
    return facType.get(ref);
  };

  const results = [];
  for (const row of ordered) {
    const file = fileById.get(row.import_id);
    const { fields, warnings = [] } = row.normalized;
    const res = {
      rowId: row.id, importId: row.import_id, filename: file.filename, rowNumber: row.row_number,
      reference: fields.reference || null, description: fields.description || null,
      action: null, method: null, target: null, changes: [], conflicts: [], candidates: [],
      warnings: [...warnings], notes: [], decision: row.decision || null,
      facility_ref: facilityTarget(fields), team_ref: teamTarget(fields, file), rep_ref: null,
    };
    results.push(res);

    if (!fields.reference) { res.action = 'error'; continue; }
    if (row.decision === 'skip') { res.action = 'skip'; continue; }

    if (fields.rep_name) {
      const u = userByName.get(normName(fields.rep_name));
      if (u) res.rep_ref = u.id;
      else res.warnings.push(`Representative "${fields.rep_name}" is not a user yet; not assigned.`);
    }

    // Sibling trays of the same instrument set (shared serial, different reference)
    const sk = serialKey(fields);
    if (sk) {
      const sibs = (bySerial.get(sk) || []).filter((s) => normName(s.fields.reference) !== normName(fields.reference));
      if (sibs.length) res.notes.push(`Part of set ${fields.catalog_number} SN ${fields.serial_number} with ${[...new Set(sibs.map((s) => s.fields.reference))].join(', ')}.`);
    }

    // ---- Matching -------------------------------------------------------
    let match = null;
    if (fields.qr_value && byQr.has(normName(fields.qr_value))) { match = byQr.get(normName(fields.qr_value)); res.method = 'qr'; }
    if (!match && sk && bySerialRef.has(`${sk}|${normName(fields.reference)}`)) { match = bySerialRef.get(`${sk}|${normName(fields.reference)}`); res.method = 'serial'; }
    if (!match && byRefLot.has(refLotKey(fields))) {
      const m = byRefLot.get(refLotKey(fields));
      const mk = serialKey(m.fields);
      const contradicts = sk && mk && sk !== mk; // same name + lot text, different serial
      if (!contradicts || row.decision === 'merge') {
        match = m;
        res.method = 'reference_lot';
      } else if (row.decision !== 'create_new') {
        res.action = 'review';
        res.method = 'name_only';
        res.candidates = [candidateOf(m)];
        res.notes.push(`Same Reference and Lot as ${m.virtual ? 'another row' : 'an existing asset'} but a different serial (${m.fields.catalog_number} SN ${m.fields.serial_number}).`);
        continue;
      }
    }
    if (!match && row.decision !== 'create_new') {
      const cands = byRef.get(normName(fields.reference)) || [];
      if (cands.length) {
        res.candidates = cands.map(candidateOf);
        if (row.decision === 'merge') {
          const want = row.decision_target || row.details?.merge_row;
          match = cands.find((c) => c.id === want || c.rowId === want) || cands[0];
          res.method = 'name_only';
        } else {
          res.method = 'name_only';
          res.action = 'review';
          continue;
        }
      }
    }

    // ---- New asset --------------------------------------------------------
    if (!match) {
      res.action = 'new';
      res.method = res.method || 'none';
      const rec = {
        virtual: true, rowId: row.id, fields: { ...fields }, qr: fields.qr_value || null,
        facility_ref: res.facility_ref, team_ref: res.team_ref, rep_ref: res.rep_ref, filename: file.filename,
      };
      if (fields.qr_value && byQr.has(normName(fields.qr_value))) rec.qr = null;
      if (!res.facility_ref) res.warnings.push('No mapped location: the asset will be created as Under Investigation until located.');
      res.status = statusFor(res.facility_ref ? facilityTypeOf(res.facility_ref) : null);
      addToIndex(rec);
      continue;
    }

    // ---- Existing (or in-batch) asset: compare fields ---------------------
    res.target = candidateOf(match);
    const cur = match.fields;
    const inBatch = !!match.virtual;
    const sourceOfCurrent = inBatch ? match.filename : 'live record';

    if (!same(cur.reference, fields.reference)) {
      res.conflicts.push(conflict('reference', cur.reference, fields.reference, 'normal', sourceOfCurrent));
    }
    for (const fld of SNAPSHOT_FIELDS) {
      if (fields[fld] === undefined || fields[fld] === null) continue;
      if (same(cur[fld], fields[fld])) continue;
      if (inBatch && cur[fld] !== null && cur[fld] !== undefined) {
        res.conflicts.push(conflict(fld, cur[fld], fields[fld], 'normal', sourceOfCurrent));
      } else {
        res.changes.push({ field: fld, label: FIELD_LABEL[fld] || fld, from: display(cur[fld]), to: display(fields[fld]) });
        cur[fld] = fields[fld];
      }
    }
    for (const fld of IDENT_FIELDS) {
      if (fields[fld] == null || same(cur[fld], fields[fld])) continue;
      if (cur[fld] == null || cur[fld] === '') {
        res.changes.push({ field: fld, label: FIELD_LABEL[fld] || fld, from: null, to: display(fields[fld]) });
        cur[fld] = fields[fld];
      } else {
        res.conflicts.push(conflict(fld, cur[fld], fields[fld], 'normal', sourceOfCurrent));
      }
    }
    if (fields.qr_value && !byQr.has(normName(fields.qr_value))) {
      if (!match.qr) {
        res.changes.push({ field: 'qr_value', label: 'QR UUID', from: null, to: fields.qr_value });
        match.qr = fields.qr_value;
        byQr.set(normName(fields.qr_value), match);
      } else {
        res.conflicts.push(conflict('qr_value', match.qr, fields.qr_value, 'normal', sourceOfCurrent));
      }
    }
    // Live custody fields
    for (const [fld, kind, refKey] of [['current_facility', 'facility', 'facility_ref'], ['team', 'team', 'team_ref'], ['assigned_rep', 'user', 'rep_ref']]) {
      const proposed = res[refKey];
      if (!proposed) continue;
      const current = match[refKey];
      if (current === proposed) continue;
      if (!current) {
        res.changes.push({ field: fld, label: FIELD_LABEL[fld], from: null, to: refLabel(kind, proposed), ref: proposed });
        match[refKey] = proposed;
      } else {
        res.conflicts.push({
          ...conflict(fld, refLabel(kind, current), refLabel(kind, proposed), 'critical', sourceOfCurrent),
          current_ref: current, proposed_ref: proposed,
        });
      }
    }

    res.action = res.conflicts.length ? 'conflict' : res.changes.length ? 'update' : 'duplicate';
  }

  // ---- Summary ------------------------------------------------------------
  const empty = () => ({ rows: 0, new: 0, update: 0, duplicate: 0, conflict: 0, review: 0, skip: 0, error: 0, conflicts: 0, warnings: 0 });
  const summary = empty();
  const perFile = Object.fromEntries(files.map((f) => [f.id, empty()]));
  for (const r of results) {
    for (const s of [summary, perFile[r.importId]]) {
      s.rows++;
      s[r.action]++;
      s.conflicts += r.conflicts.length;
      if (r.warnings.length) s.warnings++;
    }
  }
  summary.assetsAfter = index.assets.length + summary.new;
  return { results, summary, perFile };

  function candidateOf(rec) {
    return rec.virtual
      ? { rowId: rec.rowId, reference: rec.fields.reference, lot: rec.fields.lot, inBatch: true, filename: rec.filename }
      : { id: rec.id, asset_no: rec.asset_no, reference: rec.fields.reference, lot: rec.fields.lot, facility: facName.get(rec.facility_ref) || null };
  }
}

function conflict(field, current, proposed, severity, currentSource) {
  return { field, label: FIELD_LABEL[field] || field, current: display(current), proposed: display(proposed), severity, currentSource };
}

export function statusFor(facilityType) {
  if (!facilityType) return 'under_investigation';
  return facilityType === 'warehouse' ? 'at_warehouse' : 'at_facility';
}
