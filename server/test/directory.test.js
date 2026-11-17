import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, makeTeam, makeFacility, makeAsset, loginAs } from './helpers.js';

const H = 'x-requested-with';
let server, admin, mgr, rep, adminId, repId, north, south, wh, hosp, asset;
const one = async (sql, p) => (await pool.query(sql, p)).rows[0];
const send = (agent, method, url, body = {}) => agent[method](url).set(H, 'fetch').send(body);

before(async () => {
  await resetDb();
  server = app();
  north = await makeTeam('North');
  south = await makeTeam('South');
  wh = await makeFacility('HQ Warehouse', 'warehouse');
  hosp = await makeFacility('City Hospital');
  adminId = await makeUser('admin', 'admin@test.local');
  await makeUser('manager', 'mgr@test.local');
  repId = await makeUser('rep', 'rep@test.local', [north]);
  asset = await makeAsset({ reference: 'KIT 1', team_id: north, current_facility_id: hosp, status: 'at_facility', asset_type: 'tray' });
  await makeAsset({ reference: 'KIT 2', team_id: south, current_facility_id: hosp, status: 'missing', asset_type: 'tote' });
  admin = await loginAs(request, server, 'admin@test.local');
  mgr = await loginAs(request, server, 'mgr@test.local');
  rep = await loginAs(request, server, 'rep@test.local');
});
after(() => pool.end());

let newUserId, tempPw;
test('admin creates a user with a one-time temporary password; email must be unique', async () => {
  const r = await send(admin, 'post', '/api/users', { email: 'New.Rep@Test.local', full_name: 'New Rep', role: 'rep', team_ids: [north] });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.match(r.body.temporaryPassword, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.equal(r.body.user.email, 'new.rep@test.local');
  assert.deepEqual(r.body.user.teams.map((t) => t.name), ['North']);
  newUserId = r.body.user.id;
  tempPw = r.body.temporaryPassword;
  assert.equal((await send(admin, 'post', '/api/users', { email: 'new.rep@test.local', full_name: 'Dup', role: 'rep' })).status, 409);
  assert.equal((await send(mgr, 'post', '/api/users', { email: 'x@test.local', full_name: 'X', role: 'rep' })).status, 403, 'managers cannot create users');
  assert.equal((await rep.get('/api/users')).status, 403);
  assert.equal((await mgr.get('/api/users')).status, 200, 'managers can view the directory');
});

test('temporary password must be changed before anything else works', async () => {
  const agent = request.agent(server);
  assert.equal((await agent.post('/api/auth/login').set(H, 'fetch').send({ email: 'new.rep@test.local', password: tempPw })).status, 200);
  const me = await agent.get('/api/auth/me');
  assert.equal(me.body.user.must_change_password, true);
  const blocked = await agent.get('/api/assets');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.details.code, 'password_change_required');
  assert.equal((await send(agent, 'post', '/api/auth/change-password', { currentPassword: tempPw, newPassword: tempPw })).status, 400, 'must differ');
  assert.equal((await send(agent, 'post', '/api/auth/change-password', { currentPassword: tempPw, newPassword: 'a-brand-new-password' })).status, 200);
  assert.equal((await agent.get('/api/assets')).status, 200);
});

test('editing, team membership and audit trail', async () => {
  const r = await send(admin, 'patch', `/api/users/${newUserId}`, { title: 'Associate Rep', team_ids: [north, south] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.user.teams.map((t) => t.name), ['North', 'South']);
  const h = await admin.get(`/api/users/${newUserId}/history`);
  assert.deepEqual(h.body.items.map((x) => x.action), ['updated', 'created']);
  assert.ok(h.body.items[0].changes.team_ids);
  await assert.rejects(pool.query('DELETE FROM admin_audit'), /permanent/);
});

test('deactivation guards: self, last admin, open incoming transfers; deactivation signs the user out', async () => {
  assert.equal((await send(admin, 'patch', `/api/users/${adminId}`, { active: false })).status, 400, 'not yourself');
  // Second admin cannot remove the only other admin's role if it leaves zero admins
  const mgrRow = await one(`SELECT id FROM users WHERE email = 'mgr@test.local'`);
  assert.equal((await send(admin, 'patch', `/api/users/${adminId}`, { role: 'manager' })).status, 400);

  const t = await one(
    `INSERT INTO transfers (asset_id, from_facility_id, to_facility_id, sender_id, recipient_id, accept_by)
     VALUES ($1,$2,$3,$4,$5, now() + interval '1 day') RETURNING id`, [asset.id, hosp, wh, adminId, repId]);
  const blocked = await send(admin, 'patch', `/api/users/${repId}`, { active: false });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /in transit to them/);
  await pool.query(`UPDATE transfers SET status = 'cancelled', closed_at = now(), closed_by = $2 WHERE id = $1`, [t.id, adminId]);

  assert.equal((await send(admin, 'patch', `/api/users/${repId}`, { active: false })).status, 200);
  assert.equal((await rep.get('/api/auth/me')).status, 401, 'signed out everywhere');
  assert.equal((await request(server).post('/api/auth/login').set(H, 'fetch').send({ email: 'rep@test.local', password: 'correct-horse-battery' })).status, 401);
  assert.equal((await send(admin, 'patch', `/api/users/${repId}`, { active: true })).status, 200);
  rep = await loginAs(request, server, 'rep@test.local'); // old session was revoked
  assert.ok(mgrRow.id);
});

test('password reset issues a new temporary password and forces a change', async () => {
  const r = await send(admin, 'post', `/api/users/${newUserId}/reset-password`);
  assert.equal(r.status, 200);
  const u = await one('SELECT must_change_password FROM users WHERE id = $1', [newUserId]);
  assert.equal(u.must_change_password, true);
  assert.equal((await one(`SELECT count(*)::int AS n FROM admin_audit WHERE entity_id = $1 AND action = 'password_reset'`, [newUserId])).n, 1);
});

test('teams: create, rename, unique names, counts, deactivate hides from pickers', async () => {
  const c = await send(admin, 'post', '/api/teams', { name: 'Metro' });
  assert.equal(c.status, 201);
  assert.equal((await send(admin, 'post', '/api/teams', { name: ' metro ' })).status, 409);
  assert.equal((await send(mgr, 'post', '/api/teams', { name: 'X' })).status, 403);
  const list = await mgr.get('/api/teams');
  const n = list.body.items.find((t) => t.name === 'North');
  assert.equal(n.assets, 1);
  assert.equal(n.trays, 1);
  assert.equal((await send(admin, 'patch', `/api/teams/${c.body.team.id}`, { active: false })).status, 200);
  const meta = await admin.get('/api/meta');
  assert.ok(!meta.body.teams.some((t) => t.name === 'Metro'));
  assert.deepEqual((await rep.get('/api/teams')).body.items.map((t) => t.name), ['North'], 'reps see their own teams');
});

test('facilities: directory counts are scoped; detail shows reps and transfers; deactivation guarded', async () => {
  const all = await mgr.get('/api/facilities');
  const h = all.body.items.find((f) => f.name === 'City Hospital');
  assert.equal(h.assets, 2);
  assert.equal(h.exceptions, 1);
  const repView = await rep.get('/api/facilities');
  assert.equal(repView.body.items.find((f) => f.name === 'City Hospital').assets, 1, 'rep counts only their scope');

  await pool.query('UPDATE assets SET assigned_rep_id = $2 WHERE id = $1', [asset.id, repId]);
  const d = await mgr.get(`/api/facilities/${hosp}`);
  assert.equal(d.status, 200);
  assert.equal(d.body.counts.trays, 1);
  assert.equal(d.body.counts.totes, 1);
  assert.equal(d.body.counts.missing, 1);
  assert.deepEqual(d.body.reps.map((r) => r.full_name), ['rep rep@test.local']);

  const blocked = await send(admin, 'patch', `/api/facilities/${hosp}`, { active: false });
  assert.equal(blocked.status, 409);
  assert.match(blocked.body.error, /still has 2 assets/);
  const nf = await send(admin, 'post', '/api/facilities', { name: 'Lakeside ASC', facility_type: 'surgery_center', city: 'Chattanooga', state: 'TN' });
  assert.equal(nf.status, 201);
  assert.equal((await send(admin, 'post', '/api/facilities', { name: 'LAKESIDE ASC', facility_type: 'hospital' })).status, 409);
  assert.equal((await send(admin, 'patch', `/api/facilities/${nf.body.facility.id}`, { phone: '555-0100', active: false })).status, 200);
  assert.equal((await mgr.get('/api/facilities?status=inactive')).body.items.length, 1);
  assert.equal((await send(rep, 'patch', `/api/facilities/${hosp}`, { name: 'X' })).status, 403);
});

test('asset responsibility can be reassigned by management (location cannot), with history', async () => {
  assert.equal((await send(rep, 'patch', `/api/assets/${asset.id}/assignment`, { team_id: south })).status, 403);
  assert.equal((await send(mgr, 'patch', `/api/assets/${asset.id}/assignment`, { warehouse_id: hosp })).status, 400, 'home warehouse must be a warehouse');
  const r = await send(mgr, 'patch', `/api/assets/${asset.id}/assignment`, { assigned_rep_id: newUserId, warehouse_id: wh, note: 'Territory change' });
  assert.equal(r.status, 200);
  const a = await one('SELECT assigned_rep_id, warehouse_id, current_facility_id FROM assets WHERE id = $1', [asset.id]);
  assert.deepEqual(a, { assigned_rep_id: newUserId, warehouse_id: wh, current_facility_id: hosp });
  const ev = await one(`SELECT event_type, details FROM asset_events WHERE asset_id = $1 ORDER BY id DESC LIMIT 1`, [asset.id]);
  assert.equal(ev.event_type, 'reassigned');
  assert.equal(ev.details.assigned_rep_id.to, 'New Rep');
  assert.equal(ev.details.note, 'Territory change');
});

test('bulk assignment: one transaction, history per changed asset, management only', async () => {
  const ids = (await pool.query(`SELECT id FROM assets ORDER BY reference`)).rows.map((r) => r.id);
  assert.equal((await send(rep, 'post', '/api/assets/bulk-assignment', { asset_ids: ids, team_id: south })).status, 403);
  assert.equal((await send(mgr, 'post', '/api/assets/bulk-assignment', { asset_ids: ids })).status, 400, 'must choose something');
  const before = (await one(`SELECT count(*)::int AS n FROM asset_events WHERE event_type = 'reassigned'`)).n;
  const r = await send(mgr, 'post', '/api/assets/bulk-assignment', { asset_ids: ids, assigned_rep_id: repId, note: 'Initial assignment' });
  assert.equal(r.status, 200);
  assert.equal(r.body.changed + r.body.unchanged, ids.length);
  assert.equal((await one(`SELECT count(*)::int AS n FROM assets WHERE assigned_rep_id = $1`, [repId])).n, ids.length);
  assert.equal((await one(`SELECT count(*)::int AS n FROM asset_events WHERE event_type = 'reassigned'`)).n - before, r.body.changed);
  // An invalid id rolls back the whole batch
  const bad = await send(mgr, 'post', '/api/assets/bulk-assignment', { asset_ids: [ids[0], '00000000-0000-4000-8000-000000000000'], assigned_rep_id: null });
  assert.equal(bad.status, 404);
  assert.equal((await one(`SELECT assigned_rep_id FROM assets WHERE id = $1`, [ids[0]])).assigned_rep_id, repId, 'rolled back');
});
