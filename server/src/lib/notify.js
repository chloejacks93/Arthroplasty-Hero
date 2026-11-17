// In-app notifications. Respects per-user preferences (notification_preferences
// rows with in_app = false suppress that kind for that user). dedupe_key makes
// repeated sends idempotent per user.
export async function notifyUsers(db, userIds, n) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return 0;
  const { rowCount } = await db.query(
    `INSERT INTO notifications (user_id, kind, title, body, asset_id, transfer_id, link, dedupe_key)
     SELECT u.id, $2, $3, $4, $5, $6, $7, $8
       FROM users u
      WHERE u.id = ANY($1) AND u.active AND u.role <> 'system'
        AND NOT EXISTS (SELECT 1 FROM notification_preferences p WHERE p.user_id = u.id AND p.kind = $2 AND NOT p.in_app)
     ON CONFLICT DO NOTHING`,
    [ids, n.kind, n.title, n.body || null, n.asset_id || null, n.transfer_id || null, n.link || null, n.dedupe_key || null]);
  return rowCount;
}

export async function notifyRoles(db, roles, n, { except = [] } = {}) {
  const { rows } = await db.query(`SELECT id FROM users WHERE active AND role = ANY($1)`, [roles]);
  return notifyUsers(db, rows.map((r) => r.id).filter((id) => !except.includes(id)), n);
}

export const MANAGERS = ['admin', 'manager', 'inventory'];
