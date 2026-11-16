import { Router } from 'express';
import { query } from '../db.js';

// Lookup lists used by filters and pickers. Active records only.
const router = Router();

router.get('/', async (_req, res) => {
  const [teams, facilities, reps] = await Promise.all([
    query(`SELECT id, name, code FROM teams WHERE active ORDER BY name`),
    query(`SELECT id, name, facility_type, city, state FROM facilities WHERE active ORDER BY name`),
    query(`SELECT id, full_name, role FROM users WHERE active AND role <> 'system' ORDER BY full_name`),
  ]);
  res.json({ teams: teams.rows, facilities: facilities.rows, users: reps.rows });
});

export default router;
