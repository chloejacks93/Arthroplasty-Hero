// Create (or reset the password of) an administrator.
// Usage:
//   ADMIN_EMAIL=you@company.com ADMIN_NAME="Your Name" ADMIN_PASSWORD='…' npm run create-admin
// On Render: run once from the service Shell. The password is never logged.
import bcrypt from 'bcryptjs';
import { pool } from '../src/db.js';
import { migrate } from '../src/migrate.js';

const email = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const name = (process.env.ADMIN_NAME || '').trim();
const password = process.env.ADMIN_PASSWORD || '';

if (!email.includes('@') || !name || password.length < 10) {
  console.error('Set ADMIN_EMAIL, ADMIN_NAME and ADMIN_PASSWORD (min 10 characters).');
  process.exit(1);
}

await migrate({ log: () => {} });
const hash = await bcrypt.hash(password, 12);
const { rows } = await pool.query(
  `INSERT INTO users (email, full_name, role, password_hash)
   VALUES ($1, $2, 'admin', $3)
   ON CONFLICT (lower(email)) DO UPDATE
     SET password_hash = EXCLUDED.password_hash, role = 'admin', active = true, failed_logins = 0, locked_until = NULL
   RETURNING id, (xmax = 0) AS created`,
  [email, name, hash],
);
console.log(rows[0].created ? `Administrator created: ${email}` : `Administrator updated: ${email}`);
await pool.end();
