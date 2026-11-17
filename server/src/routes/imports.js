import { Router } from 'express';
import crypto from 'node:crypto';
import multer from 'multer';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, badRequest, notFound, forbidden, conflict } from '../lib/errors.js';
import { can } from '../lib/roles.js';
import { readSpreadsheet } from '../lib/spreadsheet.js';
import { normalizeRow, headerKey, COLUMN_MAP } from '../lib/importFields.js';
import { loadBatch, analyzeBatch, commitBatch } from '../lib/importCommit.js';

const router = Router();

const MAX_FILES = 10;
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024, files: MAX_FILES, fields: 20, fieldSize: 64 * 1024 },
});

const requireImporter = (req, _res, next) => {
  if (!can.importData(req.user)) throw forbidden('Only inventory, management and administrators can import spreadsheets.');
  next();
};
router.use(requireImporter);

// Translate multer's limit errors into friendly 400s.
const receive = (req, res, next) =>
  upload.array('files', MAX_FILES)(req, res, (err) => {
    if (!err) return next();
    if (err.code === 'LIMIT_FILE_SIZE') return next(badRequest('Each file must be 10 MB or smaller.'));
    if (err.code === 'LIMIT_FILE_COUNT' || err.code === 'LIMIT_UNEXPECTED_FILE') return next(badRequest(`Upload up to ${MAX_FILES} files at a time.`));
    return next(badRequest('The upload could not be read.'));
  });

// ---------------------------------------------------------------------
// Upload → preview batch (nothing is written to assets yet)
// ---------------------------------------------------------------------
router.post('/', receive, async (req, res) => {
  const files = req.files || [];
  if (!files.length) throw badRequest('Choose at least one spreadsheet.');
  let teamIds = [];
  if (req.body.teams) {
    try { teamIds = JSON.parse(req.body.teams); } catch { throw badRequest('Invalid team selection.'); }
  }
  teamIds = parse(z.array(z.union([z.uuid(), z.literal(''), z.null()])).max(MAX_FILES), teamIds);
  const chosenTeams = teamIds.filter(Boolean);
  if (chosenTeams.length) {
    const { rows } = await query('SELECT id FROM teams WHERE id = ANY($1) AND active', [chosenTeams]);
    if (rows.length !== new Set(chosenTeams).size) throw badRequest('One of the selected teams does not exist.');
  }

  // Parse everything first so a bad file rejects the whole upload cleanly.
  const parsed = [];
  for (const [i, f] of files.entries()) {
    const filename = Buffer.from(f.originalname, 'latin1').toString('utf8').replace(/[\\/]/g, '_').slice(0, 200);
    const sheet = await readSpreadsheet(f.buffer, filename);
    if (!sheet.rows.length) throw badRequest(`"${filename}" has a header row but no data rows.`);
    const headerMap = Object.fromEntries(sheet.headers.map((h) => [h, COLUMN_MAP[headerKey(h)]?.field || null]));
    parsed.push({
      filename,
      sha: crypto.createHash('sha256').update(f.buffer).digest('hex'),
      sheet,
      headerMap,
      teamId: teamIds[i] || null,
    });
  }

  const batchId = await tx(async (c) => {
    const { rows: [b] } = await c.query('INSERT INTO import_batches (uploaded_by) VALUES ($1) RETURNING id', [req.user.id]);
    for (const p of parsed) {
      const { rows: [imp] } = await c.query(
        `INSERT INTO imports (batch_id, filename, file_sha256, sheet_name, team_id, uploaded_by, header_map, row_count)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [b.id, p.filename, p.sha, p.sheet.sheetName, p.teamId, req.user.id, JSON.stringify(p.headerMap), p.sheet.rows.length]);
      // Bulk insert rows in chunks.
      const rows = p.sheet.rows.map((r) => {
        const n = normalizeRow(r.raw);
        return [imp.id, r.rowNumber, JSON.stringify(r.raw), JSON.stringify(n), JSON.stringify(n.warnings)];
      });
      for (let i = 0; i < rows.length; i += 500) {
        const chunk = rows.slice(i, i + 500);
        const vals = [];
        const ph = chunk.map((r, j) => {
          vals.push(...r);
          const o = j * 5;
          return `($${o + 1},$${o + 2},$${o + 3},$${o + 4},'review',$${o + 5})`;
        });
        await c.query(`INSERT INTO import_rows (import_id, row_number, raw, normalized, action, warnings) VALUES ${ph.join(',')}`, vals);
      }
    }
    return b.id;
  });
  res.status(201).json({ batchId });
});

// ---------------------------------------------------------------------
// History
// ---------------------------------------------------------------------
router.get('/', async (_req, res) => {
  const { rows } = await query(
    `SELECT i.id, i.batch_id, i.filename, i.uploaded_at, i.status, i.row_count, i.new_count, i.updated_count,
            i.duplicate_count, i.conflict_count, i.review_count, u.full_name AS uploaded_by_name, t.name AS team_name,
            b.committed_at,
            (SELECT count(*)::int FROM asset_conflicts ac WHERE ac.import_id = i.id AND ac.status = 'open') AS open_conflicts
       FROM imports i
       JOIN import_batches b ON b.id = i.batch_id
       JOIN users u ON u.id = i.uploaded_by
       LEFT JOIN teams t ON t.id = i.team_id
      ORDER BY i.uploaded_at DESC, i.filename
      LIMIT 500`);
  res.json({ items: rows });
});

// ---------------------------------------------------------------------
// Batch detail: mapping + row-by-row analysis
// ---------------------------------------------------------------------
router.get('/batches/:id', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const loaded = await loadBatch({ query }, id);
  if (!loaded) throw notFound('Import not found.');
  const { batch, files } = loaded;

  const [teams, facilities, previous] = await Promise.all([
    query('SELECT id, name FROM teams WHERE active ORDER BY name'),
    query('SELECT id, name, facility_type FROM facilities WHERE active ORDER BY name'),
    query(
      `SELECT i.file_sha256, i.filename, b.committed_at FROM imports i JOIN import_batches b ON b.id = i.batch_id
        WHERE b.status = 'committed' AND i.file_sha256 = ANY($1) AND b.id <> $2`,
      [files.map((f) => f.file_sha256), id]),
  ]);

  let mapping = null;
  let results;
  let summary;
  let perFile;
  if (batch.status === 'preview') {
    const a = await analyzeBatch({ query }, loaded);
    mapping = a.mapping;
    ({ results, summary, perFile } = a.analysis);
  } else {
    // Committed / cancelled batches show what was recorded.
    const fname = new Map(files.map((f) => [f.id, f.filename]));
    results = loaded.rows
      .map((r) => ({
        rowId: r.id, importId: r.import_id, filename: fname.get(r.import_id), rowNumber: r.row_number,
        reference: r.normalized.fields.reference || null, description: r.normalized.fields.description || null,
        action: batch.status === 'cancelled' ? 'skip' : r.action, method: r.match_method,
        target: r.details?.target || null, assetId: r.resulting_asset_id,
        changes: r.details?.changes || [], conflicts: r.details?.conflicts || [], notes: r.details?.notes || [],
        candidates: r.details?.candidates || [], warnings: r.warnings || [], decision: r.decision,
      }))
      .sort((a, b) => files.findIndex((f) => f.id === a.importId) - files.findIndex((f) => f.id === b.importId) || a.rowNumber - b.rowNumber);
    summary = batch.result || null;
  }

  res.json({
    batch: { id: batch.id, status: batch.status, created_at: batch.created_at, committed_at: batch.committed_at, uploaded_by_name: batch.uploaded_by_name },
    files: files.map((f) => ({
      ...f,
      perFile: perFile?.[f.id] || null,
      previouslyImported: previous.rows.filter((p) => p.file_sha256 === f.file_sha256).map((p) => ({ filename: p.filename, committed_at: p.committed_at })),
    })),
    mapping,
    options: { teams: teams.rows, facilities: facilities.rows },
    summary,
    results,
  });
});

// ---------------------------------------------------------------------
// Mapping choices
// ---------------------------------------------------------------------
const facilityTypes = ['warehouse', 'hospital', 'surgery_center', 'clinic', 'other'];
const nameStr = z.string().trim().min(1).max(200);
const mappingSchema = z.object({
  teams: z.record(z.string().max(300), z.union([
    z.object({ team_id: z.uuid() }),
    z.object({ create: z.object({ name: nameStr }) }),
    z.object({ ignore: z.literal(true) }),
  ])).default({}),
  locations: z.record(z.string().max(300), z.union([
    z.object({ facility_id: z.uuid() }),
    z.object({ create: z.object({ name: nameStr, facility_type: z.enum(facilityTypes) }) }),
    z.object({ ignore: z.literal(true) }),
  ])).default({}),
});

async function previewBatchOr409(id) {
  const { rows: [b] } = await query('SELECT status FROM import_batches WHERE id = $1', [id]);
  if (!b) throw notFound('Import not found.');
  if (b.status !== 'preview') throw conflict(`This import was already ${b.status}.`);
}

router.put('/batches/:id/mapping', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const body = parse(mappingSchema, req.body);
  await previewBatchOr409(id);
  const { rows: [b] } = await query('SELECT mapping FROM import_batches WHERE id = $1', [id]);
  const merged = {
    teams: { ...(b.mapping.teams || {}), ...body.teams },
    locations: { ...(b.mapping.locations || {}), ...body.locations },
  };
  await query('UPDATE import_batches SET mapping = $2 WHERE id = $1', [id, JSON.stringify(merged)]);
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Review decisions
// ---------------------------------------------------------------------
const decisionSchema = z.object({
  decisions: z.array(z.object({
    rowId: z.uuid(),
    decision: z.enum(['merge', 'create_new', 'skip']).nullable(),
    target: z.uuid().nullable().optional(), // existing asset id or in-batch row id
  })).min(1).max(20000),
});

router.put('/batches/:id/decisions', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { decisions } = parse(decisionSchema, req.body);
  await previewBatchOr409(id);
  await tx(async (c) => {
    for (const d of decisions) {
      let assetTarget = null;
      let rowTarget = null;
      if (d.decision === 'merge' && d.target) {
        const { rowCount } = await c.query('SELECT 1 FROM assets WHERE id = $1', [d.target]);
        if (rowCount) assetTarget = d.target;
        else rowTarget = d.target;
      }
      const { rowCount } = await c.query(
        `UPDATE import_rows r SET decision = $3, decision_target = $4,
                details = CASE WHEN $5::text IS NULL THEN r.details - 'merge_row'
                               ELSE jsonb_set(r.details, '{merge_row}', to_jsonb($5::text), true) END
           FROM imports i WHERE r.id = $1 AND i.id = r.import_id AND i.batch_id = $2`,
        [d.rowId, id, d.decision, assetTarget, rowTarget]);
      if (!rowCount) throw badRequest('A row in this request does not belong to this import.');
    }
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Commit / cancel
// ---------------------------------------------------------------------
router.post('/batches/:id/commit', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const result = await commitBatch(id, req.user);
  res.json({ ok: true, result });
});

router.post('/batches/:id/cancel', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  await tx(async (c) => {
    const { rows: [b] } = await c.query('SELECT status FROM import_batches WHERE id = $1 FOR UPDATE', [id]);
    if (!b) throw notFound('Import not found.');
    if (b.status !== 'preview') throw conflict(`This import was already ${b.status}.`);
    await c.query(`UPDATE import_batches SET status = 'cancelled' WHERE id = $1`, [id]);
    await c.query(`UPDATE imports SET status = 'cancelled' WHERE batch_id = $1`, [id]);
  });
  res.json({ ok: true });
});

export default router;
