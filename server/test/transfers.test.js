import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, makeTeam, makeFacility, makeAsset, loginAs, SYSTEM } from './helpers.js';
import { sweepOverdueTransfers } from '../src/lib/transfers.js';

const H = 'x-requested-with';
let server, wh, h1, h2, repA, repB, mgr, A, B, S, M, X, Y, SOUTH;

const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const post = (agent, url, body = {}) => agent.post(url).set(H, 'fetch').send(body);

before(async () => {
  await resetDb();
  server = app();
  const north = await makeTeam('North');
  const south = await makeTeam('South');
  wh = await makeFacility('Main Warehouse', 'warehouse');
  h1 = await makeFacility('Hospital One');
  h2 = await makeFacility('Hospital Two');
  repA = await makeUser('rep', 'a@test.local', [north]);
  repB = await makeUser('rep', 'b@test.local', [north]);
  await makeUser('rep', 's@test.local', [south]);
  mgr = await makeUser('manager', 'm@test.local');
  X = await makeAsset({ reference: 'TRAY X', team_id: north, current_facility_id: wh, status: 'at_warehouse', custodian_id: repA });
  Y = await makeAsset({ reference: 'TRAY Y', team_id: north, current_facility_id: h1, status: 'at_facility' });
  SOUTH = await makeAsset({ reference: 'SOUTH TOTE', team_id: south, current_facility_id: h2, status: 'at_facility' });
  await pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)', [X.id, 'qr-x-label', SYSTEM]);
  A = await loginAs(request, server, 'a@test.local');
  B = await loginAs(request, server, 'b@test.local');
  S = await loginAs(request, server, 's@test.local');
  M = await loginAs(request, server, 'm@test.local');
});
after(() => pool.end());

let t1;
test('initiate: asset goes In Transit, location/custodian unchanged until receipt, recipient notified', async () => {
  assert.equal((await post(S, '/api/transfers', { asset_id: X.id, to_facility_id: h1, recipient_id: repB })).status, 403, 'other team cannot transfer');
  const r = await post(A, '/api/transfers', { asset_id: X.id, to_facility_id: h1, recipient_id: repB, reason: 'Case coverage' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  t1 = r.body.transfer;
  assert.equal(t1.status, 'in_transit');
  assert.equal(t1.from_facility, 'Main Warehouse');
  assert.equal(t1.to_facility, 'Hospital One');
  const a = await one('SELECT status, current_facility_id, custodian_id FROM assets WHERE id = $1', [X.id]);
  assert.deepEqual(a, { status: 'in_transit', current_facility_id: wh, custodian_id: repA });
  const n = await one(`SELECT title, link FROM notifications WHERE user_id = $1 AND kind = 'transfer_incoming'`, [repB]);
  assert.equal(n.title, 'Incoming: TRAY X');
  const ev = await one(`SELECT transfer_id, from_status, to_status FROM asset_events WHERE asset_id = $1 AND event_type = 'transfer_initiated'`, [X.id]);
  assert.deepEqual(ev, { transfer_id: t1.id, from_status: 'at_warehouse', to_status: 'in_transit' });
  const dup = await post(A, '/api/transfers', { asset_id: X.id, to_facility_id: h2, recipient_id: repB });
  assert.equal(dup.status, 409);
  assert.match(dup.body.error, /already in transit/);
});

test('scan shows the open transfer and whether the scanner is the recipient', async () => {
  const r = await post(B, '/api/qr/scan', { value: 'QR-X-LABEL' });
  assert.equal(r.body.openTransfer.id, t1.id);
  assert.equal(r.body.openTransfer.isRecipient, true);
  assert.equal((await post(A, '/api/qr/scan', { value: 'qr-x-label' })).body.openTransfer.isRecipient, false);
});

test('receipt: only the recipient, only by scanning the right label', async () => {
  assert.equal((await post(A, `/api/transfers/${t1.id}/receive`, { qr_value: 'qr-x-label' })).status, 403);
  assert.equal((await post(M, `/api/transfers/${t1.id}/receive`, { qr_value: 'qr-x-label' })).status, 403, 'managers cannot confirm for someone else');
  const noScan = await post(B, `/api/transfers/${t1.id}/receive`, {});
  assert.equal(noScan.status, 400);
  assert.match(noScan.body.error, /Scan the QR label/);
  assert.equal((await post(B, `/api/transfers/${t1.id}/receive`, { qr_value: 'some-other-label' })).status, 400);
  const ok = await post(B, `/api/transfers/${t1.id}/receive`, { qr_value: ' QR-X-LABEL ' });
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.transfer.status, 'received');
  assert.equal(ok.body.transfer.via_qr_scan, true);
  const a = await one('SELECT status, current_facility_id, custodian_id, last_transferred_at IS NOT NULL AS moved FROM assets WHERE id = $1', [X.id]);
  assert.deepEqual(a, { status: 'at_facility', current_facility_id: h1, custodian_id: repB, moved: true });
  assert.equal((await post(B, `/api/transfers/${t1.id}/receive`, { qr_value: 'qr-x-label' })).status, 409, 'cannot confirm twice');
  const sender = await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'transfer_update'`, [repA]);
  assert.equal(sender.n, 1);
  await assert.rejects(pool.query('UPDATE transfer_confirmations SET via_qr_scan = false'), /permanent/);
  await assert.rejects(pool.query('DELETE FROM transfers'), /not permitted/);
});

test('assets without a linked label can be confirmed without scanning (recorded as such)', async () => {
  const r = await post(B, '/api/transfers', { asset_id: Y.id, to_facility_id: wh, recipient_id: repA });
  assert.equal(r.status, 201);
  const ok = await post(A, `/api/transfers/${r.body.transfer.id}/receive`, { note: 'Picked up from sterile processing' });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.transfer.via_qr_scan, false);
  assert.equal((await one('SELECT status FROM assets WHERE id = $1', [Y.id])).status, 'at_warehouse');
});

test('cancel restores the previous status; only sender or management; reason required', async () => {
  const r = await post(B, '/api/transfers', { asset_id: X.id, to_facility_id: h2, recipient_id: repA });
  const id = r.body.transfer.id;
  assert.equal((await post(A, `/api/transfers/${id}/cancel`, { note: 'not mine' })).status, 403);
  assert.equal((await post(B, `/api/transfers/${id}/cancel`, {})).status, 400);
  assert.equal((await post(B, `/api/transfers/${id}/cancel`, { note: 'Case moved to next week' })).status, 200);
  const a = await one('SELECT status, current_facility_id FROM assets WHERE id = $1', [X.id]);
  assert.deepEqual(a, { status: 'at_facility', current_facility_id: h1 });
  assert.equal((await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND kind = 'transfer_update'`, [repA])).n, 2);
});

test('“not received” closes the transfer, flags the asset and opens an investigation', async () => {
  const r = await post(B, '/api/transfers', { asset_id: X.id, to_facility_id: h2, recipient_id: repA });
  const id = r.body.transfer.id;
  assert.equal((await post(A, `/api/transfers/${id}/not-received`, { note: 'Never arrived at Hospital Two' })).status, 200);
  const t = await one('SELECT status, investigation_id FROM transfers WHERE id = $1', [id]);
  assert.equal(t.status, 'rejected');
  const inv = await one('SELECT kind, status, transfer_id FROM investigations WHERE id = $1', [t.investigation_id]);
  assert.deepEqual(inv, { kind: 'missing', status: 'open', transfer_id: id });
  assert.equal((await one('SELECT status FROM assets WHERE id = $1', [X.id])).status, 'under_investigation');
  assert.ok(await one(`SELECT 1 AS ok FROM notifications WHERE user_id = $1 AND kind = 'asset_missing'`, [repB]));
  assert.ok(await one(`SELECT 1 AS ok FROM notifications WHERE user_id = $1 AND kind = 'asset_missing'`, [mgr]));

  // Manager finds it and resolves, correcting the location.
  const r2 = await post(M, `/api/investigations/${t.investigation_id}/update`, { action: 'resolve', note: 'Found in OR storage at Hospital Two', correct_facility_id: h2 });
  assert.equal(r2.status, 200);
  const a = await one('SELECT status, current_facility_id FROM assets WHERE id = $1', [X.id]);
  assert.deepEqual(a, { status: 'at_facility', current_facility_id: h2 });
  const evs = (await pool.query(`SELECT event_type FROM asset_events WHERE asset_id = $1 ORDER BY id DESC LIMIT 3`, [X.id])).rows.map((e) => e.event_type);
  assert.deepEqual(evs, ['investigation_updated', 'location_corrected', 'problem_reported']);
});

test('overdue transfers send one reminder per day to recipient, sender and managers', async () => {
  const r = await post(A, '/api/transfers', { asset_id: Y.id, to_facility_id: h1, recipient_id: repB });
  await pool.query(`UPDATE transfers SET accept_by = now() - interval '1 hour' WHERE id = $1`, [r.body.transfer.id]);
  assert.equal(await sweepOverdueTransfers(pool), 1);
  assert.equal(await sweepOverdueTransfers(pool), 0, 'no repeat within 20 hours');
  const n = await pool.query(`SELECT user_id FROM notifications WHERE kind = 'transfer_overdue' ORDER BY user_id`);
  assert.deepEqual(n.rows.map((x) => x.user_id).sort(), [repA, repB, mgr].sort());
  const list = await M.get('/api/transfers?status=overdue');
  assert.equal(list.body.items.length, 1);
  assert.equal(list.body.items[0].overdue, true);
});

test('transfer lists respect visibility', async () => {
  assert.equal((await S.get('/api/transfers?status=any')).body.items.length, 0);
  assert.ok((await M.get('/api/transfers?status=any')).body.items.length >= 5);
  const inbox = await B.get('/api/transfers?box=incoming');
  assert.equal(inbox.body.items.length, 1);
  const meta = await B.get('/api/meta');
  assert.equal(meta.body.counts.incomingTransfers, 1);
  assert.ok(meta.body.counts.unreadNotifications >= 1);
});

test('report a problem: anyone can report; status follows the kind; only management investigates', async () => {
  assert.equal((await post(S, '/api/investigations', { asset_id: SOUTH.id, kind: 'damaged' })).status, 400, 'description required');
  const d = await post(S, '/api/investigations', { asset_id: SOUTH.id, kind: 'damaged', description: 'Lid latch broken' });
  assert.equal(d.status, 201);
  assert.equal((await one('SELECT status FROM assets WHERE id = $1', [SOUTH.id])).status, 'at_facility', 'damaged does not change location status');
  const m = await post(A, '/api/investigations', { asset_id: SOUTH.id, kind: 'unauthorized_movement', facility_id: h1, description: 'Found at Hospital One, no transfer' });
  assert.equal(m.status, 201);
  assert.equal((await one('SELECT status FROM assets WHERE id = $1', [SOUTH.id])).status, 'under_investigation');
  assert.equal((await post(A, `/api/investigations/${m.body.id}/update`, { action: 'resolve', note: 'x' })).status, 403);
  // Reporter sees their own reports only
  assert.equal((await S.get('/api/investigations')).body.items.length, 1);
  assert.equal((await S.get(`/api/investigations/${m.body.id}`)).status, 404);
  // Manager resolves without moving it: status restored
  assert.equal((await post(M, `/api/investigations/${m.body.id}/update`, { action: 'assign_self' })).status, 200);
  assert.equal((await post(M, `/api/investigations/${m.body.id}/update`, { action: 'resolve', note: 'Loaned by agreement; returned' })).status, 200);
  assert.equal((await one('SELECT status FROM assets WHERE id = $1', [SOUTH.id])).status, 'at_facility');
  const detail = await M.get(`/api/investigations/${m.body.id}`);
  assert.deepEqual(detail.body.events.map((e) => e.action), ['reported', 'assigned', 'resolved']);
  assert.equal((await post(M, `/api/investigations/${m.body.id}/update`, { action: 'resolve', note: 'again' })).status, 409);
  await assert.rejects(pool.query('DELETE FROM investigation_events'), /permanent/);
});
