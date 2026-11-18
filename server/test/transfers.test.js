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

test('multi-tray shipment: one action, one notification, all-or-nothing, received tray by tray', async () => {
  const north = (await one(`SELECT id FROM teams WHERE name = 'North'`)).id;
  const ids = [];
  for (const ref of ['SHIP A', 'SHIP B', 'SHIP C']) {
    ids.push((await one(
      `INSERT INTO assets (reference, team_id, current_facility_id, status) VALUES ($1, $2, $3, 'at_warehouse') RETURNING id`,
      [ref, north, wh])).id);
  }
  await pool.query(`INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, 'qr-ship-a', $2)`, [ids[0], SYSTEM]);

  // One bad asset (another team's) blocks the whole shipment and is named.
  const bad = await post(A, '/api/transfers', { asset_ids: [...ids, SOUTH.id], to_facility_id: h2, recipient_id: repB });
  assert.equal(bad.status, 409);
  assert.match(bad.body.error, /1 of 4 assets can’t be sent/);
  assert.equal(bad.body.details.problems[0].reference, 'SOUTH TOTE');
  assert.equal((await one(`SELECT count(*)::int AS n FROM transfers WHERE asset_id = ANY($1)`, [ids])).n, 0, 'nothing started');

  const before = (await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [repB])).n;
  const r = await post(A, '/api/transfers', { asset_ids: ids, to_facility_id: h2, recipient_id: repB, reason: 'Case coverage' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.transfers.length, 3);
  assert.ok(r.body.shipment.batch_no);
  assert.ok(r.body.transfers.every((t) => t.batch_no === r.body.shipment.batch_no && t.batch_size === 3));
  const notes = await pool.query(`SELECT title FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 5`, [repB]);
  assert.equal((await one(`SELECT count(*)::int AS n FROM notifications WHERE user_id = $1`, [repB])).n - before, 1, 'one notification for the shipment');
  assert.match(notes.rows[0].title, /3 trays/);
  assert.equal((await one(`SELECT count(*)::int AS n FROM assets WHERE id = ANY($1) AND status = 'in_transit'`, [ids])).n, 3);

  // Each tray is confirmed on its own (label required where linked).
  const tA = r.body.transfers.find((t) => t.asset_id === ids[0]);
  const tB = r.body.transfers.find((t) => t.asset_id === ids[1]);
  assert.equal((await post(B, `/api/transfers/${tA.id}/receive`, {})).status, 400, 'label still required');
  assert.equal((await post(B, `/api/transfers/${tA.id}/receive`, { qr_value: 'qr-ship-a' })).status, 200);
  assert.equal((await post(B, `/api/transfers/${tB.id}/receive`, {})).status, 200, 'no label linked -> allowed');
  const inbox = await B.get('/api/transfers?box=incoming');
  const left = inbox.body.items.filter((t) => t.batch_no === r.body.shipment.batch_no);
  assert.equal(left.length, 1, 'one tray of the shipment still incoming');
  // Duplicate ids are de-duplicated; empty list rejected.
  assert.equal((await post(A, '/api/transfers', { asset_ids: [], to_facility_id: h2, recipient_id: repB })).status, 400);
});

test('one-step warehouse return: inventory/management returning trays themselves need not receive them again', async () => {
  const north = (await one(`SELECT id FROM teams WHERE name = 'North'`)).id;
  const ids = [];
  for (const ref of ['RET 1', 'RET 2']) {
    ids.push((await one(
      `INSERT INTO assets (reference, team_id, current_facility_id, status, custodian_id) VALUES ($1, $2, $3, 'at_facility', $4) RETURNING id`,
      [ref, north, h1, repA])).id);
  }
  // Reps can't; destination must be a warehouse; recipient must be the sender.
  assert.equal((await post(A, '/api/transfers', { asset_ids: ids, to_facility_id: wh, recipient_id: repA, receive_now: true })).status, 403);
  assert.equal((await post(M, '/api/transfers', { asset_ids: ids, to_facility_id: h2, recipient_id: mgr, receive_now: true })).status, 400);
  assert.equal((await post(M, '/api/transfers', { asset_ids: ids, to_facility_id: wh, recipient_id: repA, receive_now: true })).status, 400);
  assert.equal((await one(`SELECT count(*)::int AS n FROM transfers WHERE asset_id = ANY($1)`, [ids])).n, 0);

  const r = await post(M, '/api/transfers', { asset_ids: ids, to_facility_id: wh, recipient_id: mgr, receive_now: true, scanned_asset_ids: [ids[0]] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.transfers.every((t) => t.status === 'received' && t.received_facility === 'Main Warehouse'));
  const assets = (await pool.query(`SELECT status, current_facility_id, custodian_id FROM assets WHERE id = ANY($1)`, [ids])).rows;
  assert.ok(assets.every((a) => a.status === 'at_warehouse' && a.current_facility_id === wh && a.custodian_id === mgr));
  const conf = (await pool.query(`SELECT c.via_qr_scan, c.notes FROM transfer_confirmations c JOIN transfers t ON t.id = c.transfer_id WHERE t.asset_id = ANY($1) ORDER BY t.transfer_no`, [ids])).rows;
  assert.deepEqual(conf.map((c) => c.via_qr_scan), [true, false]);
  assert.match(conf[0].notes, /received in the same step/);
  const ev = (await pool.query(`SELECT event_type, details FROM asset_events WHERE asset_id = $1 ORDER BY id`, [ids[0]])).rows;
  assert.deepEqual(ev.map((e) => e.event_type), ['transfer_initiated', 'transfer_received']);
  assert.equal(ev[1].details.one_step_return, true);
  assert.equal((await M.get('/api/transfers?box=incoming')).body.items.length, 0, 'nothing left to receive');
});
