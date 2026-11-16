import pg from 'pg';
import { config } from './config.js';

// NUMERIC -> JS number (fees / factors are well within double precision),
// DATE -> 'YYYY-MM-DD' string (avoids timezone shifting), BIGINT identity -> number.
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(1082, (v) => v);
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  ssl: config.databaseSsl ? { rejectUnauthorized: false } : false,
  max: Number(process.env.PG_POOL_MAX || 10),
});

pool.on('error', (err) => {
  console.error('[db] idle client error', err.message);
});

export const query = (text, params) => pool.query(text, params);

/** Run fn(client) inside a transaction; rolls back on any thrown error. */
export async function tx(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
