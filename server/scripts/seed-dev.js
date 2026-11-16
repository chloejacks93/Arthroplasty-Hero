// DEVELOPMENT ONLY — populates an empty local database with clearly-labelled
// SAMPLE data so the interface can be exercised before real spreadsheets are
// imported. Refuses to run in production or against a database that already
// has assets.
import bcrypt from 'bcryptjs';
import { pool, tx } from '../src/db.js';
import { migrate } from '../src/migrate.js';

if (process.env.NODE_ENV === 'production') {
  console.error('seed-dev refuses to run with NODE_ENV=production.');
  process.exit(1);
}

await migrate({ log: () => {} });
const { rows: existing } = await pool.query('SELECT count(*)::int AS n FROM assets');
if (existing[0].n > 0) {
  console.error('Database already contains assets; seed skipped.');
  process.exit(0);
}

const SYSTEM = '00000000-0000-0000-0000-000000000001';
const pw = await bcrypt.hash(process.env.SEED_PASSWORD || 'sample-password-123', 10);

// Small deterministic PRNG so screenshots/tests are reproducible.
let s = 42;
const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
const pick = (arr) => arr[Math.floor(rnd() * arr.length)];

await tx(async (c) => {
  const ins = async (sql, params) => (await c.query(sql, params)).rows[0];

  const teams = [];
  for (const [name, code] of [['Sample Team North', 'N'], ['Sample Team South', 'S'], ['Sample Team Metro', 'M']]) {
    teams.push(await ins('INSERT INTO teams (name, code) VALUES ($1,$2) RETURNING id, name', [name, code]));
  }

  const facilitiesSpec = [
    ['Sample Central Warehouse', 'warehouse', 'Columbus', 'OH'],
    ['Sample Regional Warehouse', 'warehouse', 'Cincinnati', 'OH'],
    ['Sample Northside Medical Center', 'hospital', 'Columbus', 'OH'],
    ['Sample Riverside General Hospital', 'hospital', 'Dayton', 'OH'],
    ['Sample Lakeview Orthopedic Hospital', 'hospital', 'Toledo', 'OH'],
    ['Sample Parkway Surgery Center', 'surgery_center', 'Dublin', 'OH'],
    ['Sample Summit Joint Institute', 'surgery_center', 'Akron', 'OH'],
    ['Sample Valley Regional Medical', 'hospital', 'Canton', 'OH'],
  ];
  const facilities = [];
  for (const [name, type, city, state] of facilitiesSpec) {
    facilities.push(await ins(
      'INSERT INTO facilities (name, facility_type, city, state) VALUES ($1,$2,$3,$4) RETURNING id, name, facility_type',
      [name, type, city, state]));
  }
  const warehouses = facilities.filter((f) => f.facility_type === 'warehouse');
  const sites = facilities.filter((f) => f.facility_type !== 'warehouse');

  const people = [
    ['admin@sample.local', 'Sample Administrator', 'admin', null],
    ['manager@sample.local', 'Sample Regional Manager', 'manager', null],
    ['inventory@sample.local', 'Sample Inventory Lead', 'inventory', null],
    ['rep.north@sample.local', 'Jordan Ellis (Sample)', 'rep', 0],
    ['rep.north2@sample.local', 'Morgan Price (Sample)', 'rep', 0],
    ['rep.south@sample.local', 'Taylor Brooks (Sample)', 'rep', 1],
    ['rep.metro@sample.local', 'Casey Reed (Sample)', 'rep', 2],
  ];
  const users = [];
  for (const [email, name, role, teamIdx] of people) {
    const u = await ins('INSERT INTO users (email, full_name, role, password_hash) VALUES ($1,$2,$3,$4) RETURNING id, role',
      [email, name, role, pw]);
    if (teamIdx !== null) await c.query('INSERT INTO user_teams VALUES ($1,$2)', [u.id, teams[teamIdx].id]);
    users.push({ ...u, teamIdx });
  }
  const reps = users.filter((u) => u.role === 'rep');

  const catalog = [
    ['Shoulder Arthroplasty Instrument Tray', 'tray', 'Instrument'],
    ['Humeral Stem Implant Tote', 'tote', 'Implant'],
    ['Glenoid Preparation Tray', 'tray', 'Instrument'],
    ['Reverse Shoulder Implant Tote', 'tote', 'Implant'],
    ['Knee Arthroplasty Instrument Tray', 'tray', 'Instrument'],
    ['Tibial Insert Implant Tote', 'tote', 'Implant'],
    ['Revision Instrument Set', 'instrument_set', 'Instrument'],
    ['Baseplate & Glenosphere Implant Set', 'implant_set', 'Implant'],
  ];
  const statuses = ['at_facility', 'at_facility', 'at_facility', 'at_facility', 'at_warehouse', 'at_warehouse',
    'in_transit', 'assigned_to_case', 'overdue', 'missing', 'under_investigation', 'awaiting_receipt'];

  for (let i = 0; i < 84; i++) {
    const [name, type, srcType] = catalog[i % catalog.length];
    const rep = pick(reps);
    const team = teams[rep.teamIdx];
    const status = i < 12 ? statuses[i] : pick(statuses.slice(0, 6));
    const wh = pick(warehouses);
    const fac = status === 'at_warehouse' ? wh : pick(sites);
    const ref = `SMPL-${String(1000 + i * 7)}`;
    const a = await ins(
      `INSERT INTO assets (reference, description, asset_type, source_type, team_id, warehouse_id, current_facility_id,
                           assigned_rep_id, custodian_id, status, lot, consignment_fee, return_date, items_count,
                           set_utilization_factor, total_cases_12m, days_since_last_case, top_hcp, agency,
                           last_scanned_at, last_transferred_at, notes)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,'Sample Agency',
               now() - make_interval(hours => $18), now() - make_interval(days => $19), 'Sample record for local testing')
       RETURNING id`,
      [ref, `${name} ${(i % 3) + 1}`, type, srcType, team.id, wh.id, fac.id, rep.id, status,
        `L${24000 + i}`, Math.round(rnd() * 900 + 100), status === 'overdue' ? '2026-10-15' : null,
        Math.floor(rnd() * 40 + 8), Number((rnd() * 1.2).toFixed(2)), Math.floor(rnd() * 60),
        Math.floor(rnd() * 120), `Dr. Sample ${String.fromCharCode(65 + (i % 6))}`, Math.floor(rnd() * 200),
        Math.floor(rnd() * 40)]);
    if (i % 5 !== 4) {
      await c.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, gen_random_uuid()::text, $2)',
        [a.id, SYSTEM]);
    }
    await c.query(
      `INSERT INTO asset_events (asset_id, event_type, actor_id, to_facility_id, to_custodian_id, to_status, details, occurred_at)
       VALUES ($1,'created',$2,$3,$4,$5,'{"source":"sample seed"}', now() - interval '30 days')`,
      [a.id, SYSTEM, fac.id, rep.id, status]);
  }
});
console.log('Sample data created. Sign in with admin@sample.local (password from SEED_PASSWORD or the default in this script).');
await pool.end();
