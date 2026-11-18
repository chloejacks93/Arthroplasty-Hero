import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, makeFacility, makeAsset, loginAs, SYSTEM } from './helpers.js';

let server, mgr, rep, wh, asset;
const H = 'x-requested-with';
before(async () => {
  await resetDb();
  server = app();
  wh = await makeFacility('HQ', 'warehouse');
  await makeUser('manager', 'm@test.local');
  await makeUser('rep', 'r@test.local');
  mgr = await loginAs(request, server, 'm@test.local');
  rep = await loginAs(request, server, 'r@test.local');
  // As created by an import row with an unmatched Location
  asset = await makeAsset({ reference: 'VIP TARGETER #9', status: 'under_investigation', source_location: 'SOMEWHERE NEW' });
  await pool.query(`INSERT INTO asset_events (asset_id, event_type, actor_id, to_status, details)
                    VALUES ($1, 'created', $2, 'under_investigation', '{"source":"spreadsheet","filename":"kits_18.xlsx","row":7}')`, [asset.id, SYSTEM]);
});
after(() => pool.end());

test('asset page explains why it is Under Investigation (imported without a location)', async () => {
  const r = await mgr.get(`/api/assets/${asset.id}`);
  assert.deepEqual(r.body.statusReason, { kind: 'no_location', source: 'import', filename: 'kits_18.xlsx', row: 7, source_location: 'SOMEWHERE NEW' });
});

test('management can set a location for an asset that has none; then it is no longer Under Investigation', async () => {
  const send = (agent, body) => agent.post(`/api/assets/${asset.id}/locate`).set(H, 'fetch').send(body);
  assert.equal((await send(rep, { facility_id: wh })).status, 403);
  assert.equal((await send(mgr, { facility_id: wh, note: 'Found on HQ shelf' })).status, 200);
  const a = (await pool.query('SELECT status, current_facility_id FROM assets WHERE id = $1', [asset.id])).rows[0];
  assert.deepEqual(a, { status: 'at_warehouse', current_facility_id: wh });
  assert.equal((await mgr.get(`/api/assets/${asset.id}`)).body.statusReason, null);
  assert.equal((await send(mgr, { facility_id: wh })).status, 400, 'already has a location: use Transfer');
  const ev = (await pool.query(`SELECT event_type FROM asset_events WHERE asset_id = $1 ORDER BY id DESC LIMIT 1`, [asset.id])).rows[0];
  assert.equal(ev.event_type, 'location_corrected');
});
