import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, makeTeam, makeFacility, makeAsset, loginAs, SYSTEM } from './helpers.js';
import { canonicalQr } from '../src/lib/qr.js';

const H = 'x-requested-with';
const UUID = '7d1e4c2a-9b3f-4e6d-8a1c-2f5b9e0d7c41';
let server, inv, rep, otherRep, trayA, trayB, trayOther, trayNoQr;

before(async () => {
  await resetDb();
  server = app();
  const north = await makeTeam('North');
  const south = await makeTeam('South');
  const fac = await makeFacility('Test Hospital');
  await makeUser('inventory', 'inv@test.local');
  await makeUser('rep', 'rep@test.local', [north]);
  await makeUser('rep', 'south@test.local', [south]);
  trayA = await makeAsset({ reference: 'TRAY A', team_id: north, current_facility_id: fac, status: 'at_facility' });
  trayB = await makeAsset({ reference: 'TRAY B', team_id: north });
  trayNoQr = await makeAsset({ reference: 'TRAY NO QR', team_id: north });
  trayOther = await makeAsset({ reference: 'SOUTH TRAY', team_id: south });
  await pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1,$2,$3), ($4,$5,$3)',
    [trayA.id, UUID, SYSTEM, trayOther.id, 'ARX-RANDOM-STRING-001']);
  inv = await loginAs(request, server, 'inv@test.local');
  rep = await loginAs(request, server, 'rep@test.local');
  otherRep = await loginAs(request, server, 'south@test.local');
});
after(() => pool.end());

const scan = (agent, value, source) => agent.post('/api/qr/scan').set(H, 'fetch').send({ value, source });

test('canonical form of scanned payloads', () => {
  assert.equal(canonicalQr(`  ${UUID.toUpperCase()}\r\n`), UUID);
  assert.equal(canonicalQr(`https://example.com/asset/${UUID.toUpperCase()}?x=1`), UUID);
  assert.equal(canonicalQr('ARX-Random-001'), 'ARX-Random-001');
  assert.throws(() => canonicalQr('   '), /empty/);
  assert.throws(() => canonicalQr('x'.repeat(600)), /too long/);
});

test('scanning a linked code returns the asset, records the scan, and de-duplicates rapid repeats', async () => {
  const r1 = await scan(rep, UUID.toUpperCase());
  assert.equal(r1.status, 200);
  assert.equal(r1.body.status, 'matched');
  assert.equal(r1.body.asset.reference, 'TRAY A');
  assert.equal(r1.body.asset.in_scope, true);
  assert.equal(r1.body.previousScanAt, null);
  const r2 = await scan(rep, `https://labels.example/${UUID}`, 'manual');
  assert.equal(r2.body.asset.id, trayA.id);
  assert.ok(r2.body.previousScanAt, 'second scan reports the first');
  const ev = await pool.query(`SELECT count(*)::int AS n FROM asset_events WHERE asset_id = $1 AND event_type = 'scanned'`, [trayA.id]);
  assert.equal(ev.rows[0].n, 1, 'one ledger entry for repeated reads within 2 minutes');
  const log = await pool.query(`SELECT result, source FROM scan_log WHERE asset_id = $1 ORDER BY id`, [trayA.id]);
  assert.deepEqual(log.rows, [{ result: 'matched', source: 'camera' }, { result: 'matched', source: 'manual' }]);
  await assert.rejects(pool.query('DELETE FROM scan_log'), /permanent/);
});

test('a rep scanning another team’s tray sees what it is, flagged as out of scope', async () => {
  const r = await scan(rep, 'arx-random-string-001');
  assert.equal(r.body.status, 'matched');
  assert.equal(r.body.asset.reference, 'SOUTH TRAY');
  assert.equal(r.body.asset.in_scope, false);
  assert.equal(r.body.permissions.linkQr, false);
});

test('unknown codes are logged and reported as unlinked', async () => {
  const r = await scan(rep, 'NEW-LABEL-XYZ');
  assert.equal(r.body.status, 'unknown');
  assert.equal(r.body.qr_value, 'NEW-LABEL-XYZ');
  assert.equal(r.body.pendingRequest, null);
  const log = await pool.query(`SELECT count(*)::int AS n FROM scan_log WHERE result = 'unknown'`);
  assert.equal(log.rows[0].n, 1);
});

test('linking rules: permission, one code per asset, one asset per code, replace needs a reason', async () => {
  const link = (agent, body) => agent.post('/api/qr/link').set(H, 'fetch').send(body);
  assert.equal((await link(rep, { asset_id: trayB.id, value: 'CODE-B' })).status, 403);

  const ok = await link(inv, { asset_id: trayB.id, value: 'CODE-B' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.asset.qr_value, 'CODE-B');

  const taken = await link(inv, { asset_id: trayNoQr.id, value: 'code-b' });
  assert.equal(taken.status, 409);
  assert.match(taken.body.error, /already linked to AH-\d+ · TRAY B/);

  const has = await link(inv, { asset_id: trayB.id, value: 'CODE-B2' });
  assert.equal(has.status, 409);
  assert.match(has.body.error, /already has a QR code/);
  assert.equal((await link(inv, { asset_id: trayB.id, value: 'CODE-B2', replace: true })).status, 400);
  const rep2 = await link(inv, { asset_id: trayB.id, value: 'CODE-B2', replace: true, reason: 'Label damaged' });
  assert.equal(rep2.status, 200);
  const codes = await pool.query('SELECT qr_value, active, unlink_reason FROM asset_qr_codes WHERE asset_id = $1 ORDER BY linked_at', [trayB.id]);
  assert.deepEqual(codes.rows, [
    { qr_value: 'CODE-B', active: false, unlink_reason: 'Label damaged' },
    { qr_value: 'CODE-B2', active: true, unlink_reason: null },
  ]);
  // The old code is free again and now scans as unknown.
  assert.equal((await scan(inv, 'CODE-B')).body.status, 'unknown');
  const ev = await pool.query(`SELECT event_type FROM asset_events WHERE asset_id = $1 ORDER BY id`, [trayB.id]);
  assert.deepEqual(ev.rows.map((e) => e.event_type), ['qr_linked', 'qr_unlinked', 'qr_linked']);

  // Unlink requires a reason
  assert.equal((await inv.post('/api/qr/unlink').set(H, 'fetch').send({ asset_id: trayB.id })).status, 400);
  assert.equal((await inv.post('/api/qr/unlink').set(H, 'fetch').send({ asset_id: trayB.id, reason: 'Retiring label' })).status, 200);
});

test('rep proposes a match for an unknown label; inventory approves; pending request is shown to the next scanner', async () => {
  const req1 = await rep.post('/api/qr/requests').set(H, 'fetch').send({ value: 'NEW-LABEL-XYZ', asset_id: trayNoQr.id, note: 'Found at OR 4' });
  assert.equal(req1.status, 201);
  const dup = await otherRep.post('/api/qr/requests').set(H, 'fetch').send({ value: 'new-label-xyz', asset_id: trayB.id });
  assert.equal(dup.status, 409, 'one pending request per code');
  const seen = await scan(otherRep, 'NEW-LABEL-XYZ');
  assert.equal(seen.body.pendingRequest.reference, 'TRAY NO QR');

  assert.equal((await rep.get('/api/qr/requests')).status, 403);
  const list = await inv.get('/api/qr/requests');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].note, 'Found at OR 4');
  const notif = await pool.query(`SELECT count(*)::int AS n FROM notifications WHERE kind = 'qr_link_request'`);
  assert.equal(notif.rows[0].n, 1, 'inventory user notified');

  assert.equal((await inv.post(`/api/qr/requests/${req1.body.id}/approve`).set(H, 'fetch').send({})).status, 200);
  assert.equal((await inv.post(`/api/qr/requests/${req1.body.id}/approve`).set(H, 'fetch').send({})).status, 409);
  const after = await scan(rep, 'NEW-LABEL-XYZ');
  assert.equal(after.body.status, 'matched');
  assert.equal(after.body.asset.reference, 'TRAY NO QR');
  // Requests for an already linked code are refused
  assert.equal((await rep.post('/api/qr/requests').set(H, 'fetch').send({ value: 'NEW-LABEL-XYZ', asset_id: trayB.id })).status, 409);
});

test('reject keeps the code unlinked', async () => {
  const r = await rep.post('/api/qr/requests').set(H, 'fetch').send({ value: 'ANOTHER-LABEL', asset_id: trayB.id });
  assert.equal((await inv.post(`/api/qr/requests/${r.body.id}/reject`).set(H, 'fetch').send({ note: 'Wrong tray' })).status, 200);
  assert.equal((await scan(inv, 'ANOTHER-LABEL')).body.status, 'unknown');
  const hist = await inv.get('/api/qr/requests?status=rejected');
  assert.equal(hist.body.items[0].decision_note, 'Wrong tray');
});

test('registry filter: assets with and without a linked QR', async () => {
  const none = await inv.get('/api/assets?qr=none');
  const linked = await inv.get('/api/assets?qr=linked');
  assert.equal(none.body.total + linked.body.total, 4);
  assert.ok(none.body.items.every((a) => !a.qr_value));
  assert.ok(linked.body.items.every((a) => a.qr_value));
  const meta = await inv.get('/api/meta');
  assert.equal(meta.body.permissions.linkQr, true);
  assert.equal(typeof meta.body.counts.pendingQrRequests, 'number');
});

test('unlinked list: progress, scoping, filters', async () => {
  const all = await inv.get('/api/assets/unlinked');
  assert.equal(all.status, 200);
  const { summary, items } = all.body;
  assert.equal(summary.total, summary.linked + summary.unlinked);
  assert.equal(items.length, summary.unlinked);
  assert.ok(items.every((a) => a.asset_code && a.reference));
  const linkedIds = (await pool.query('SELECT asset_id FROM asset_qr_codes WHERE active')).rows.map((r) => r.asset_id);
  assert.ok(items.every((a) => !linkedIds.includes(a.id)), 'only assets without an active label');
  // Reps only see their scope
  const repView = await rep.get('/api/assets/unlinked');
  assert.ok(repView.body.items.every((a) => a.team_name === 'North' || a.team_name === null));
  assert.ok(repView.body.summary.total <= summary.total);
  // Search filter
  const q = await inv.get('/api/assets/unlinked?q=tray%20b');
  assert.ok(q.body.items.every((a) => /tray b/i.test(a.reference)));
});
