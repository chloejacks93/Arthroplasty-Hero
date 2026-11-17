import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, resetDb, makeAsset, makeFacility, makeUser, SYSTEM } from './helpers.js';
import { migrate } from '../src/migrate.js';

let assetA, assetB, fac1, fac2, rep;

before(async () => {
  await resetDb();
  fac1 = await makeFacility('Facility One');
  fac2 = await makeFacility('Facility Two');
  rep = await makeUser('rep', 'rep@test.local');
  assetA = (await makeAsset({ reference: 'REF-A', lot: 'L1' })).id;
  assetB = (await makeAsset({ reference: 'REF-B', lot: 'L2' })).id;
});
after(() => pool.end());

const rejects = (p, re) => assert.rejects(p, (e) => (re.test(e.message) ? true : assert.fail(e.message)));

test('migrations are idempotent', async () => {
  await migrate({ log: () => {} });
  const { rows } = await pool.query('SELECT count(*)::int AS n FROM schema_migrations');
  assert.ok(rows[0].n >= 1);
});

test('one QR value cannot be linked to two assets (case/whitespace-insensitive)', async () => {
  await pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)',
    [assetA, 'A1B2C3D4-0000-4000-8000-000000000001', SYSTEM]);
  await rejects(
    pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)',
      [assetB, '  a1b2c3d4-0000-4000-8000-000000000001 ', SYSTEM]),
    /asset_qr_value_uq/,
  );
});

test('an asset can have only one active QR link', async () => {
  await rejects(
    pool.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)', [assetA, 'another-qr', SYSTEM]),
    /asset_qr_asset_uq/,
  );
});

test('a set serial may be shared by sibling trays (e.g. #5A/#5B/#5C), so it is not a unique key', async () => {
  await makeAsset({ reference: 'SET #5A', catalog_number: 'AR-9501HS', serial_number: '642' });
  await makeAsset({ reference: 'SET #5B', catalog_number: 'AR-9501HS', serial_number: '642' });
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM assets WHERE serial_number = '642'`);
  assert.equal(rows[0].n, 2);
});

test('asset event ledger is append-only (no UPDATE, DELETE or TRUNCATE)', async () => {
  const { rows } = await pool.query(
    `INSERT INTO asset_events (asset_id, event_type, actor_id, to_facility_id) VALUES ($1, 'created', $2, $3) RETURNING id`,
    [assetA, SYSTEM, fac1]);
  await rejects(pool.query('UPDATE asset_events SET to_facility_id = $1 WHERE id = $2', [fac2, rows[0].id]), /permanent/);
  await rejects(pool.query('DELETE FROM asset_events WHERE id = $1', [rows[0].id]), /permanent/);
  await rejects(pool.query('TRUNCATE asset_events'), /permanent|truncate/i);
});

test('every event requires an accountable user', async () => {
  await rejects(pool.query(`INSERT INTO asset_events (asset_id, event_type) VALUES ($1, 'scanned')`, [assetA]), /actor_id/);
});

test('assets, facilities, users and transfers cannot be hard-deleted', async () => {
  await rejects(pool.query('DELETE FROM assets WHERE id = $1', [assetB]), /not permitted/);
  await rejects(pool.query('DELETE FROM facilities WHERE id = $1', [fac2]), /not permitted/);
  await rejects(pool.query('DELETE FROM users WHERE id = $1', [rep]), /not permitted/);
});

test('an asset can be in only one open transfer, and receipt requires a receiver', async () => {
  const ins = () => pool.query(
    `INSERT INTO transfers (asset_id, from_facility_id, to_facility_id, sender_id, recipient_id) VALUES ($1,$2,$3,$4,$4) RETURNING id`,
    [assetA, fac1, fac2, rep]);
  const t = (await ins()).rows[0].id;
  await rejects(ins(), /transfers_one_open_uq/);
  await rejects(pool.query(`UPDATE transfers SET status = 'received' WHERE id = $1`, [t]), /check/i);
  await rejects(pool.query('DELETE FROM transfers WHERE id = $1', [t]), /not permitted/);
});

test('status and type values are constrained', async () => {
  await rejects(makeAsset({ reference: 'X', status: 'lost_somewhere' }), /check/i);
  await rejects(makeAsset({ reference: 'X', asset_type: 'box' }), /check/i);
});

test('migration runner refuses edited migrations', async () => {
  await pool.query(`UPDATE schema_migrations SET checksum = 'tampered' WHERE filename = '001_core_schema.sql'`);
  await assert.rejects(migrate({ log: () => {} }), /modified after being applied/);
});
