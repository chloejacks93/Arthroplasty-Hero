import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, makeTeam, makeFacility, makeAsset, loginAs, SYSTEM, PASSWORD } from './helpers.js';

let server, teamN, teamS, facN, facS, repN, assetN, assetS, assetMine;

before(async () => {
  await resetDb();
  server = app();
  teamN = await makeTeam('North');
  teamS = await makeTeam('South');
  facN = await makeFacility('North Hospital');
  facS = await makeFacility('South Hospital');
  await makeUser('admin', 'admin@test.local');
  await makeUser('manager', 'manager@test.local');
  repN = await makeUser('rep', 'rep.north@test.local', [teamN]);
  await makeUser('rep', 'rep.south@test.local', [teamS]);
  assetN = await makeAsset({ reference: 'NORTH-TRAY', team_id: teamN, current_facility_id: facN, status: 'at_facility', lot: 'LN1' });
  assetS = await makeAsset({ reference: 'SOUTH-TOTE', asset_type: 'tote', team_id: teamS, current_facility_id: facS, status: 'missing' });
  // South-team asset that is personally assigned to the north rep — must be visible to them.
  assetMine = await makeAsset({ reference: 'SOUTH-BUT-MINE', team_id: teamS, assigned_rep_id: repN, status: 'at_facility' });
  await pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)',
    [assetN.id, '9f1c2e7a-1111-4a2b-9c3d-abcdefabcdef', SYSTEM]);
  await pool.query(`INSERT INTO asset_events (asset_id, event_type, actor_id, to_facility_id) VALUES ($1,'created',$2,$3)`,
    [assetN.id, SYSTEM, facN]);
});
after(() => pool.end());

test('health check responds without auth', async () => {
  const r = await request(server).get('/healthz');
  assert.equal(r.status, 200);
});

test('API rejects unauthenticated requests', async () => {
  for (const url of ['/api/assets', '/api/dashboard', '/api/meta', '/api/auth/me']) {
    assert.equal((await request(server).get(url)).status, 401, url);
  }
});

test('state-changing requests without the client header are blocked (CSRF guard)', async () => {
  const r = await request(server).post('/api/auth/login').send({ email: 'admin@test.local', password: PASSWORD });
  assert.equal(r.status, 403);
});

test('wrong password is rejected with a generic message', async () => {
  const r = await request(server).post('/api/auth/login').set('x-requested-with', 'fetch')
    .send({ email: 'admin@test.local', password: 'nope-nope-nope' });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /Incorrect email or password/);
  const unknown = await request(server).post('/api/auth/login').set('x-requested-with', 'fetch')
    .send({ email: 'ghost@test.local', password: 'nope-nope-nope' });
  assert.equal(unknown.body.error, r.body.error);
});

test('account locks after 5 failed attempts, even with the right password', async () => {
  await makeUser('rep', 'lockme@test.local');
  for (let i = 0; i < 5; i++) {
    await request(server).post('/api/auth/login').set('x-requested-with', 'fetch').send({ email: 'lockme@test.local', password: 'wrong-wrong' });
  }
  const r = await request(server).post('/api/auth/login').set('x-requested-with', 'fetch').send({ email: 'lockme@test.local', password: PASSWORD });
  assert.equal(r.status, 401);
  assert.match(r.body.error, /locked/);
});

test('session cookie is httpOnly and logout invalidates it server-side', async () => {
  const agent = request.agent(server);
  const r = await agent.post('/api/auth/login').set('x-requested-with', 'fetch').send({ email: 'manager@test.local', password: PASSWORD });
  assert.match(r.headers['set-cookie'][0], /HttpOnly/i);
  assert.match(r.headers['set-cookie'][0], /SameSite=Lax/i);
  assert.equal((await agent.get('/api/auth/me')).status, 200);
  await agent.post('/api/auth/logout').set('x-requested-with', 'fetch');
  assert.equal((await agent.get('/api/auth/me')).status, 401);
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'manager@test.local'`);
  assert.equal(rows[0].n, 0);
});

test('system user can never sign in', async () => {
  const r = await request(server).post('/api/auth/login').set('x-requested-with', 'fetch')
    .send({ email: 'system@asset-control.local', password: 'anything-at-all' });
  assert.equal(r.status, 401);
});

test('manager sees every asset', async () => {
  const agent = await loginAs(request, server, 'manager@test.local');
  const r = await agent.get('/api/assets');
  assert.equal(r.status, 200);
  assert.equal(r.body.total, 3);
});

test('rep sees only their team assets plus assets assigned to them', async () => {
  const agent = await loginAs(request, server, 'rep.north@test.local');
  const r = await agent.get('/api/assets');
  const refs = r.body.items.map((a) => a.reference).sort();
  assert.deepEqual(refs, ['NORTH-TRAY', 'SOUTH-BUT-MINE']);
  // Direct access to another team's asset is refused.
  assert.equal((await agent.get(`/api/assets/${assetS.id}`)).status, 404);
  assert.equal((await agent.get(`/api/assets/${assetMine.id}`)).status, 200);
  // Dashboard counts are scoped too.
  const d = await agent.get('/api/dashboard');
  assert.equal(d.body.kpis.total, 2);
  assert.equal(d.body.kpis.missing, 0);
});

test('search matches QR UUID, asset code and lot; filters and sorting work', async () => {
  const agent = await loginAs(request, server, 'admin@test.local');
  const byQr = await agent.get('/api/assets?q=9F1C2E7A-1111');
  assert.deepEqual(byQr.body.items.map((a) => a.reference), ['NORTH-TRAY']);
  const byCode = await agent.get(`/api/assets?q=AH-${String(assetS.asset_no).padStart(6, '0')}`);
  assert.deepEqual(byCode.body.items.map((a) => a.reference), ['SOUTH-TOTE']);
  const byLot = await agent.get('/api/assets?q=ln1');
  assert.equal(byLot.body.items.length, 1);
  const missing = await agent.get('/api/assets?status=missing');
  assert.deepEqual(missing.body.items.map((a) => a.reference), ['SOUTH-TOTE']);
  const sorted = await agent.get('/api/assets?sort=reference&dir=desc');
  assert.deepEqual(sorted.body.items.map((a) => a.reference), ['SOUTH-TOTE', 'SOUTH-BUT-MINE', 'NORTH-TRAY']);
  // LIKE wildcards in user input are treated literally.
  assert.equal((await agent.get('/api/assets?q=%25')).body.total, 0);
});

test('invalid query parameters return 400, not 500', async () => {
  const agent = await loginAs(request, server, 'admin@test.local');
  assert.equal((await agent.get('/api/assets?sort=password_hash')).status, 400);
  assert.equal((await agent.get('/api/assets?status=bogus')).status, 400);
  assert.equal((await agent.get('/api/assets/not-a-uuid')).status, 400);
});

test('asset detail returns record, QR and permanent history', async () => {
  const agent = await loginAs(request, server, 'admin@test.local');
  const r = await agent.get(`/api/assets/${assetN.id}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.asset.qr_value, '9f1c2e7a-1111-4a2b-9c3d-abcdefabcdef');
  assert.equal(r.body.events.length, 1);
  assert.equal(r.body.events[0].event_type, 'created');
  assert.equal(r.body.asset.password_hash, undefined);
});
