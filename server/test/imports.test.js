import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import ExcelJS from 'exceljs';
import { pool, resetDb, app, makeUser, loginAs } from './helpers.js';

// Synthetic sheets with the same 19 headers and text-typed values as the real
// kit reports. All names below are fictional.
const HEADERS = ['Reference', 'Type', 'Description', 'Agency', 'Warehouse', 'Location', 'Lot', 'Consignment Fee', 'Return Date',
  'Items', 'Flags', 'Notes', 'Set Utilization Factor', 'Definition Value', 'Total Cases Last 12 Months', 'Top HCP',
  'Top HCP Sales', 'Top HCP Cases', 'Days Since Last Case'];

const row = (o) => ({
  Type: 'Tray', Description: 'Test Instruments', Agency: 'TEST AGENCY', Warehouse: 'TEAM ALPHA', Location: 'Test Main HQ',
  'Consignment Fee': '$0.00', Items: '40', Flags: 'Full', 'Set Utilization Factor': '0.0', 'Definition Value': '$0.00', ...o,
});

const BASE = [
  row({ Reference: 'TST-INSTR #1A', Lot: 'AR-1000S BATCH# 20000001 SN# 11' }),
  row({ Reference: 'TST-INSTR #1B', Lot: 'AR-1000S BATCH# 20000001 SN# 11' }), // sibling tray, same set serial
  row({ Reference: 'TST-INSTR #2', Lot: 'AR-1000S BATCH# 20000002 SN# 12', Location: 'TEST GENERAL HOSPITAL', Warehouse: 'TEAM BRAVO' }),
  row({ Reference: 'TST-IMPLANTS #1', Type: 'Tub', Lot: 'TST-IMPLANTS #1', Notes: 'Lot# 555555', 'Total Cases Last 12 Months': '10',
    'Definition Value': '$100,000.00', 'Top HCP': 'Surgeon, Test' }),
];
const SECOND = [
  BASE[3], // exact duplicate of a row in the first file
  row({ Reference: 'TST-IMPLANTS #2', Type: 'Tub', Lot: 'TST-IMPLANTS #2', Location: 'TEST SURGERY CENTER' }),
];

async function xlsx(rows, { title } = {}) {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  if (title) ws.addRow([title]); // report title row above the header
  ws.addRow(HEADERS);
  for (const r of rows) ws.addRow(HEADERS.map((h) => r[h] ?? null));
  return Buffer.from(await wb.xlsx.writeBuffer());
}
const csv = (rows) => Buffer.from([HEADERS.join(','), ...rows.map((r) => HEADERS.map((h) => JSON.stringify(r[h] ?? '')).join(','))].join('\n'));

let server, admin, firstFile;
const H = 'x-requested-with';

async function uploadAndPreview(files, teams) {
  let req = admin.post('/api/imports').set(H, 'fetch');
  for (const [name, buf] of files) req = req.attach('files', buf, name);
  if (teams) req = req.field('teams', JSON.stringify(teams));
  const up = await req;
  assert.equal(up.status, 201, JSON.stringify(up.body));
  const prev = await admin.get(`/api/imports/batches/${up.body.batchId}`);
  assert.equal(prev.status, 200);
  return { batchId: up.body.batchId, ...prev.body };
}
const commit = (id) => admin.post(`/api/imports/batches/${id}/commit`).set(H, 'fetch');
const count = async (sql, p) => (await pool.query(sql, p)).rows[0].n;

before(async () => {
  await resetDb();
  server = app();
  await makeUser('admin', 'admin@test.local');
  await makeUser('rep', 'rep@test.local');
  admin = await loginAs(request, server, 'admin@test.local');
});
after(() => pool.end());

test('reps cannot import', async () => {
  const rep = await loginAs(request, server, 'rep@test.local');
  const r = await rep.post('/api/imports').set(H, 'fetch').attach('files', await xlsx(BASE), 'a.xlsx');
  assert.equal(r.status, 403);
  assert.equal((await rep.get('/api/conflicts')).status, 403);
});

test('rejects legacy .xls with instructions, and files without a Reference header', async () => {
  const xls = Buffer.concat([Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]), Buffer.alloc(512)]);
  let r = await admin.post('/api/imports').set(H, 'fetch').attach('files', xls, 'old.xls');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Save As/);
  r = await admin.post('/api/imports').set(H, 'fetch').attach('files', Buffer.from('a,b,c\n1,2,3'), 'x.csv');
  assert.equal(r.status, 400);
  assert.match(r.body.error, /Reference/);
});

test('preview of two overlapping files: duplicates combined, sibling trays kept separate, nothing written yet', async () => {
  firstFile = await xlsx(BASE, { title: 'Kit Report' });
  const p = await uploadAndPreview([['first.xlsx', firstFile], ['second.csv', csv(SECOND)]]);
  assert.equal(p.summary.rows, 6);
  assert.equal(p.summary.new, 5);
  assert.equal(p.summary.duplicate, 1);
  assert.equal(p.summary.review, 0);
  const sib = p.results.find((r) => r.reference === 'TST-INSTR #1B');
  assert.equal(sib.action, 'new', 'shared set serial must not merge separate trays');
  assert.match(sib.notes[0], /Part of set AR-1000S SN 11/);
  assert.deepEqual(Object.values(p.mapping.teams).map((t) => t.source).sort(), ['TEAM ALPHA', 'TEAM BRAVO']);
  assert.equal(p.mapping.locations['TEST MAIN HQ'].create.facility_type, 'warehouse');
  assert.equal(await count('SELECT count(*)::int AS n FROM assets'), 0);

  const c = await commit(p.batchId);
  assert.equal(c.status, 200, JSON.stringify(c.body));
  assert.equal(await count('SELECT count(*)::int AS n FROM assets'), 5);
  assert.equal(await count('SELECT count(*)::int AS n FROM teams'), 2);
  assert.equal(await count('SELECT count(*)::int AS n FROM facilities'), 3);
  assert.equal(await count(`SELECT count(*)::int AS n FROM asset_events WHERE event_type = 'created'`), 5);
  // Provenance: the duplicated asset lists both spreadsheets.
  const { rows } = await pool.query(
    `SELECT DISTINCT i.filename FROM asset_field_sources s JOIN assets a ON a.id = s.asset_id JOIN imports i ON i.id = s.import_id
      WHERE a.reference = 'TST-IMPLANTS #1' ORDER BY 1`);
  assert.deepEqual(rows.map((r) => r.filename), ['first.xlsx', 'second.csv']);
  const hq = await pool.query(`SELECT a.status, f.facility_type FROM assets a JOIN facilities f ON f.id = a.current_facility_id WHERE a.reference = 'TST-INSTR #1A'`);
  assert.deepEqual(hq.rows[0], { status: 'at_warehouse', facility_type: 'warehouse' });
  // Double commit refused
  assert.equal((await commit(p.batchId)).status, 409);
});

test('re-importing the same file creates no duplicates and is flagged as previously imported', async () => {
  const p = await uploadAndPreview([['first.xlsx', firstFile]]); // byte-identical file
  assert.equal(p.summary.new, 0);
  assert.equal(p.summary.duplicate, 4);
  assert.equal(p.files[0].previouslyImported.length, 1);
  await commit(p.batchId);
  assert.equal(await count('SELECT count(*)::int AS n FROM assets'), 5);
});

test('changed location becomes a conflict; live location is not overwritten; other fields update', async () => {
  const moved = BASE.map((r) => (r.Reference === 'TST-IMPLANTS #1'
    ? { ...r, Location: 'TEST GENERAL HOSPITAL', 'Total Cases Last 12 Months': '12' } : r));
  const p = await uploadAndPreview([['moved.xlsx', await xlsx(moved)]]);
  const r = p.results.find((x) => x.reference === 'TST-IMPLANTS #1');
  assert.equal(r.action, 'conflict');
  assert.deepEqual(r.conflicts.map((c) => [c.field, c.severity]), [['current_facility', 'critical']]);
  assert.ok(r.changes.some((c) => c.field === 'total_cases_12m' && c.to === '12'));
  await commit(p.batchId);
  const a = (await pool.query(
    `SELECT a.id, f.name, a.total_cases_12m FROM assets a JOIN facilities f ON f.id = a.current_facility_id WHERE reference = 'TST-IMPLANTS #1'`)).rows[0];
  assert.equal(a.name, 'Test Main HQ');
  assert.equal(a.total_cases_12m, 12);
  const list = await admin.get('/api/conflicts');
  assert.equal(list.body.items.length, 1);

  // Re-importing the same change does not stack a second identical conflict.
  const again = await uploadAndPreview([['moved-again.xlsx', await xlsx(moved)]]);
  await commit(again.batchId);
  assert.equal((await admin.get('/api/conflicts')).body.items.length, 1);

  // Resolve: accept the spreadsheet location.
  const id = list.body.items[0].id;
  const res = await admin.post('/api/conflicts/resolve').set(H, 'fetch').send({ ids: [id], choice: 'use_proposed', note: 'Confirmed' });
  assert.equal(res.status, 200);
  const after = (await pool.query(`SELECT f.name, a.status FROM assets a JOIN facilities f ON f.id = a.current_facility_id WHERE a.id = $1`, [a.id])).rows[0];
  assert.deepEqual(after, { name: 'TEST GENERAL HOSPITAL', status: 'at_facility' });
  const ev = await pool.query(`SELECT event_type FROM asset_events WHERE asset_id = $1 ORDER BY id`, [a.id]);
  assert.deepEqual(ev.rows.map((e) => e.event_type), ['created', 'imported', 'location_corrected', 'conflict_resolved']);
  // Resolving twice is refused.
  assert.equal((await admin.post('/api/conflicts/resolve').set(H, 'fetch').send({ ids: [id], choice: 'keep_current' })).status, 409);
});

test('same Reference with different Lot needs a human decision before commit', async () => {
  const relabeled = [{ ...BASE[2], Lot: 'AR-1000S BATCH# 29999999 SN# 99' }];
  const p = await uploadAndPreview([['relabel.xlsx', await xlsx(relabeled)]]);
  const r = p.results[0];
  assert.equal(r.action, 'review');
  assert.equal(r.candidates.length, 1);
  const blocked = await commit(p.batchId);
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /needs a decision/);

  // "Different asset" -> creates a separate record
  let d = await admin.put(`/api/imports/batches/${p.batchId}/decisions`).set(H, 'fetch')
    .send({ decisions: [{ rowId: r.rowId, decision: 'create_new' }] });
  assert.equal(d.status, 200);
  let prev = await admin.get(`/api/imports/batches/${p.batchId}`);
  assert.equal(prev.body.results[0].action, 'new');

  // Change mind: "Same asset" -> merge, lot difference becomes a conflict (asset name/lot not silently changed)
  d = await admin.put(`/api/imports/batches/${p.batchId}/decisions`).set(H, 'fetch')
    .send({ decisions: [{ rowId: r.rowId, decision: 'merge', target: r.candidates[0].id }] });
  prev = await admin.get(`/api/imports/batches/${p.batchId}`);
  assert.equal(prev.body.results[0].action, 'conflict');
  assert.ok(prev.body.results[0].conflicts.some((c) => c.field === 'lot'));
  assert.equal((await commit(p.batchId)).status, 200);
  assert.equal(await count('SELECT count(*)::int AS n FROM assets'), 5);
});

test('mapping a location variant to an existing facility is remembered for the next import', async () => {
  const variant = [{ ...BASE[2], Location: 'TEST GENERAL HOSP' }];
  const p = await uploadAndPreview([['variant.xlsx', await xlsx(variant)]]);
  assert.ok(p.mapping.locations['TEST GENERAL HOSP'].create);
  const hospital = p.options.facilities.find((f) => f.name === 'TEST GENERAL HOSPITAL');
  const m = await admin.put(`/api/imports/batches/${p.batchId}/mapping`).set(H, 'fetch')
    .send({ locations: { 'TEST GENERAL HOSP': { facility_id: hospital.id } } });
  assert.equal(m.status, 200);
  const prev = await admin.get(`/api/imports/batches/${p.batchId}`);
  // Same facility now; only the raw Location text differs (kept as "as imported" text), no conflict.
  assert.equal(prev.body.results[0].action, 'update');
  assert.deepEqual(prev.body.results[0].conflicts, []);
  assert.deepEqual(prev.body.results[0].changes.map((c) => c.field), ['source_location']);
  await commit(p.batchId);
  const next = await uploadAndPreview([['variant2.xlsx', await xlsx(variant)]]);
  assert.equal(next.mapping.locations['TEST GENERAL HOSP'].facility_id, hospital.id);
  await admin.post(`/api/imports/batches/${next.batchId}/cancel`).set(H, 'fetch');
});

test('per-file team selection overrides the Warehouse column', async () => {
  const team = (await pool.query(`INSERT INTO teams (name) VALUES ('Team Override') RETURNING id`)).rows[0].id;
  const p = await uploadAndPreview([['team.xlsx', await xlsx([row({ Reference: 'TST-NEW #9', Lot: 'TST-NEW #9' })])]], [team]);
  assert.equal(Object.keys(p.mapping.teams).length, 0);
  await commit(p.batchId);
  const t = await pool.query(`SELECT team_id FROM assets WHERE reference = 'TST-NEW #9'`);
  assert.equal(t.rows[0].team_id, team);
});

test('history lists every file with counts, and the master export opens in Excel format', async () => {
  const h = await admin.get('/api/imports');
  assert.ok(h.body.items.length >= 8);
  const first = h.body.items.find((i) => i.filename === 'first.xlsx' && i.new_count === 4);
  assert.ok(first, 'first import recorded with 4 new assets');
  assert.equal(first.uploaded_by_name, 'admin admin@test.local');

  const ex = await admin.get('/api/exports/assets.xlsx').buffer(true).parse((res, cb) => {
    const chunks = [];
    res.on('data', (c) => chunks.push(c));
    res.on('end', () => cb(null, Buffer.concat(chunks)));
  });
  assert.equal(ex.status, 200);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(ex.body);
  const ws = wb.getWorksheet('Master Assets');
  assert.equal(ws.rowCount - 1, await count('SELECT count(*)::int AS n FROM assets'));
  const headers = ws.getRow(1).values.slice(1);
  for (const h of ['Asset ID', 'QR UUID', 'Reference', 'Current Facility', 'Lot', 'Consignment Fee', 'Top HCP', 'Days Since Last Case', 'Source Spreadsheets']) {
    assert.ok(headers.includes(h), h);
  }
});
