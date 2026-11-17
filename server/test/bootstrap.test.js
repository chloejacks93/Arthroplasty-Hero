import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { pool, resetDb, app } from './helpers.js';
import { ensureInitialAdmin } from '../src/bootstrap.js';

before(resetDb);
after(() => pool.end());

test('first start creates one administrator with a temporary password; later starts do nothing', async () => {
  const lines = [];
  const log = (l) => lines.push(l);
  assert.equal(await ensureInitialAdmin({ email: '', log }), null, 'no email configured -> nothing');
  assert.equal(await ensureInitialAdmin({ email: 'not-an-email', log }), null);

  const r = await ensureInitialAdmin({ email: ' Owner@Example.com ', name: 'Owner Name', log });
  assert.equal(r.email, 'owner@example.com');
  assert.match(r.password, /^[a-z2-9]{4}-[a-z2-9]{4}-[a-z2-9]{4}$/);
  assert.ok(lines.some((l) => l.includes(r.password)), 'password printed once to the log');
  const u = (await pool.query(`SELECT role, must_change_password, full_name FROM users WHERE email = 'owner@example.com'`)).rows[0];
  assert.deepEqual(u, { role: 'admin', must_change_password: true, full_name: 'Owner Name' });

  // Restart: an admin exists, so nothing changes and no password is printed.
  lines.length = 0;
  assert.equal(await ensureInitialAdmin({ email: 'owner@example.com', log }), null);
  assert.equal(lines.length, 0);
  assert.equal((await pool.query(`SELECT count(*)::int AS n FROM users WHERE role = 'admin'`)).rows[0].n, 1);

  // The temporary password works but forces a change.
  const agent = request.agent(app());
  assert.equal((await agent.post('/api/auth/login').set('x-requested-with', 'fetch').send({ email: 'owner@example.com', password: r.password })).status, 200);
  assert.equal((await agent.get('/api/assets')).status, 403);
});
