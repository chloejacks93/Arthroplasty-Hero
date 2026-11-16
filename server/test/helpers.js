// Test harness: real PostgreSQL, fresh schema per test file.
import bcrypt from 'bcryptjs';

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('Set TEST_DATABASE_URL to a disposable database whose name ends in _test.');
}
if (!/_test(\?|$)/.test(process.env.TEST_DATABASE_URL)) {
  throw new Error('Refusing to run: TEST_DATABASE_URL must point at a database whose name ends in _test.');
}
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
process.env.DATABASE_SSL = 'false';
process.env.LOGIN_RATE_LIMIT = '1000';

const { pool } = await import('../src/db.js');
const { migrate } = await import('../src/migrate.js');
const { createApp } = await import('../src/app.js');

export { pool };
export const SYSTEM = '00000000-0000-0000-0000-000000000001';
export const PASSWORD = 'correct-horse-battery';

export async function resetDb() {
  await pool.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate({ log: () => {} });
}

export const app = () => createApp();

const hash = bcrypt.hashSync(PASSWORD, 4);

export async function makeUser(role, email, teamIds = []) {
  const { rows } = await pool.query(
    `INSERT INTO users (email, full_name, role, password_hash) VALUES ($1, $2, $3, $4) RETURNING id`,
    [email, `${role} ${email}`, role, hash],
  );
  for (const t of teamIds) await pool.query('INSERT INTO user_teams VALUES ($1, $2)', [rows[0].id, t]);
  return rows[0].id;
}

export async function makeTeam(name) {
  return (await pool.query('INSERT INTO teams (name) VALUES ($1) RETURNING id', [name])).rows[0].id;
}

export async function makeFacility(name, type = 'hospital') {
  return (await pool.query('INSERT INTO facilities (name, facility_type) VALUES ($1, $2) RETURNING id', [name, type])).rows[0].id;
}

export async function makeAsset(fields) {
  const keys = Object.keys(fields);
  const { rows } = await pool.query(
    `INSERT INTO assets (${keys.join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id, asset_no`,
    Object.values(fields),
  );
  return rows[0];
}

/** Log in through the real endpoint and return a supertest agent carrying the session cookie. */
export async function loginAs(request, server, email) {
  const agent = request.agent(server);
  const res = await agent.post('/api/auth/login').set('x-requested-with', 'fetch').send({ email, password: PASSWORD });
  if (res.status !== 200) throw new Error(`login failed for ${email}: ${res.status} ${JSON.stringify(res.body)}`);
  return agent;
}
