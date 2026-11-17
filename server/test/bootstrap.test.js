import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app } from './helpers.js';
import { ensureInitialAdmin } from '../src/bootstrap.js';

beforeEach(resetDb);
after(() => pool.end());

const login = (email, password) => request(app()).post('/api/auth/login').set('x-requested-with', 'fetch').send({ email, password });

test('first start creates one administrator with a temporary password; later starts do nothing', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await ensureInitialAdmin({ email: '', log }), null);
  assert.match(lines.at(-1), /not set/);
  assert.equal(await ensureInitialAdmin({ email: 'not-an-email', log }), null);

  const r = await ensureInitialAdmin({ email: ' Owner@Example.com ', name: 'Owner Name', password: '', log });
  assert.equal(r.email, 'owner@example.com');
  assert.match(r.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.ok(lines.some((l) => l.includes(r.password)), 'password printed once to the log');
  const u = (await pool.query(`SELECT role, must_change_password, full_name FROM users WHERE email = 'owner@example.com'`)).rows[0];
  assert.deepEqual(u, { role: 'admin', must_change_password: true, full_name: 'Owner Name' });

  lines.length = 0;
  assert.equal(await ensureInitialAdmin({ email: 'owner@example.com', password: '', log }), null);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /already exist/);
  assert.ok(!lines[0].includes(r.password));
  assert.equal((await login('owner@example.com', r.password)).status, 200);
});

test('INITIAL_ADMIN_PASSWORD: used at creation, and recovers a missed log only while never signed in', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  // Created with an auto password (log missed)...
  const first = await ensureInitialAdmin({ email: 'owner@example.com', password: '', log });
  // ...owner sets INITIAL_ADMIN_PASSWORD and redeploys.
  lines.length = 0;
  const r = await ensureInitialAdmin({ email: 'owner@example.com', password: 'chosen-by-owner-1', log });
  assert.equal(r.action, 'password_set');
  assert.ok(lines.every((l) => !l.includes('chosen-by-owner-1')), 'chosen password never logged');
  assert.equal((await login('owner@example.com', first.password)).status, 401, 'old temporary password no longer works');
  assert.equal((await login('owner@example.com', 'chosen-by-owner-1')).status, 200);

  // After a sign-in the setting can no longer change the account.
  const again = await ensureInitialAdmin({ email: 'owner@example.com', password: 'attacker-password-1', log });
  assert.equal(again, null);
  assert.match(lines.at(-1), /ignored/);
  assert.equal((await login('owner@example.com', 'attacker-password-1')).status, 401);
});

test('INITIAL_ADMIN_PASSWORD on a fresh database creates the admin with that password; short values are ignored', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  const r = await ensureInitialAdmin({ email: 'owner@example.com', password: 'my-own-password-1', log });
  assert.equal(r.action, 'created');
  assert.equal(r.password, null);
  assert.ok(lines.every((l) => !l.includes('my-own-password-1')));
  const res = await login('owner@example.com', 'my-own-password-1');
  assert.equal(res.status, 200);
  const short = [];
  await resetDb();
  const r2 = await ensureInitialAdmin({ email: 'owner@example.com', password: 'short', log: (l) => short.push(l) });
  assert.match(short[0], /shorter than 10/);
  assert.ok(r2.password, 'falls back to a generated temporary password');
});
