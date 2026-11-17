import { Router } from 'express';
import { query } from '../db.js';
import { can } from '../lib/roles.js';

// Lookup lists used by filters and pickers (active records only), plus
// navigation badge counts for the signed-in user's role.
const router = Router();

router.get('/', async (req, res) => {
  const [teams, facilities, reps, conflicts] = await Promise.all([
    query(`SELECT id, name, code FROM teams WHERE active ORDER BY name`),
    query(`SELECT id, name, facility_type, city, state FROM facilities WHERE active ORDER BY name`),
    query(`SELECT id, full_name, role FROM users WHERE active AND role <> 'system' ORDER BY full_name`),
    can.resolveConflicts(req.user)
      ? query(`SELECT count(*)::int AS n FROM asset_conflicts WHERE status = 'open'`)
      : Promise.resolve({ rows: [{ n: 0 }] }),
  ]);
  res.json({
    teams: teams.rows,
    facilities: facilities.rows,
    users: reps.rows,
    counts: { openConflicts: conflicts.rows[0].n },
    permissions: { importData: can.importData(req.user), resolveConflicts: can.resolveConflicts(req.user) },
  });
});

export default router;
