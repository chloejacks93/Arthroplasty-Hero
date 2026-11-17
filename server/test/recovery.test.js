import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app, makeUser, PASSWORD } from './helpers.js';
import { applyAdminRecovery } from '../src/recovery.js';

const H = 'x-requested-with';
let server;
const login = (email, password) => request(server).post('/api/auth/login').set(H, 'fetch').send({ email, password });

before(async () => {
  await resetDb();
  server = app();
  await makeUser('admin', 'owner@test.local');
  await makeUser('rep', 'rep@test.local');
});
after(() => pool.end());

test('lockout after 5 failures; once expired, a single typo does not re-lock', async () => {
  for (let i = 0; i < 5; i++) await login('owner@test.local', 'wrong-password-x');
  assert.match((await login('owner@test.local', PASSWORD)).body.error, /locked/);
  await pool.query(`UPDATE users SET locked_until = now() - interval '1 second' WHERE email = 'owner@test.local'`);
  assert.match((await login('owner@test.local', 'one-more-typo')).body.error, /Incorrect/, 'typo after expiry is just incorrect');
  assert.equal((await login('owner@test.local', PASSWORD)).status, 200, 'not re-locked');
});

test('recovery password unlocks a locked-out administrator once, never logs it, and forces a change', async () => {
  for (let i = 0; i < 5; i++) await login('owner@test.local', 'wrong-password-x');
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await applyAdminRecovery({ email: 'owner@test.local', password: 'short', log }), null);
  assert.equal(await applyAdminRecovery({ email: 'rep@test.local', password: 'recover-me-123', log }), null, 'only administrators');
  assert.equal(await applyAdminRecovery({ email: 'nobody@test.local', password: 'recover-me-123', log }), null);

  const r = await applyAdminRecovery({ email: 'Owner@Test.local', password: 'recover-me-123', log });
  assert.equal(r.email, 'owner@test.local');
  assert.ok(lines.every((l) => !l.includes('recover-me-123')), 'never logged');

  const agent = request.agent(server);
  assert.equal((await agent.post('/api/auth/login').set(H, 'fetch').send({ email: 'owner@test.local', password: 'recover-me-123' })).status, 200);
  assert.equal((await agent.get('/api/assets')).status, 403, 'must choose a new password first');
  assert.equal((await agent.post('/api/auth/change-password').set(H, 'fetch').send({ currentPassword: 'recover-me-123', newPassword: 'owners-new-password' })).status, 200);

  // Restarting with the setting still present does not reset it again.
  lines.length = 0;
  assert.equal(await applyAdminRecovery({ email: 'owner@test.local', password: 'recover-me-123', log }), null);
  assert.match(lines[0], /already used to sign in/);
  assert.equal((await login('owner@test.local', 'owners-new-password')).status, 200);
  const a = await pool.query(`SELECT count(*)::int AS n FROM admin_audit WHERE changes->>'source' = 'ADMIN_RECOVERY_PASSWORD'`);
  assert.equal(a.rows[0].n, 1);
});

test('recovery value with pasted whitespace works, re-applies until used, and wins over INITIAL_ADMIN_PASSWORD', async () => {
  await resetDb();
  await makeUser('admin', 'boss@test.local');
  await pool.query(`UPDATE users SET last_login_at = NULL WHERE email = 'boss@test.local'`);
  const { ensureInitialAdmin } = await import('../src/bootstrap.js');
  const log = () => {};
  process.env.ADMIN_RECOVERY_PASSWORD = '  pasted-value-123\n';
  try {
    // Simulate two restarts before the owner signs in, with INITIAL_ADMIN_PASSWORD also still set.
    for (let i = 0; i < 2; i++) {
      await ensureInitialAdmin({ email: 'boss@test.local', password: 'initial-value-123', log });
      await applyAdminRecovery({ email: 'boss@test.local', log });
    }
    assert.equal((await login('boss@test.local', 'initial-value-123')).status, 401, 'initial setting no longer overrides');
    assert.equal((await login('boss@test.local', 'pasted-value-123')).status, 200, 'trimmed recovery value works');
  } finally {
    delete process.env.ADMIN_RECOVERY_PASSWORD;
  }
});
