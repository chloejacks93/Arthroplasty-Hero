export const ROLES = ['admin', 'manager', 'inventory', 'rep'];

// Roles with organisation-wide visibility.
export const ORG_WIDE = new Set(['admin', 'manager', 'inventory']);

export const can = {
  viewAll: (u) => ORG_WIDE.has(u.role),
  administer: (u) => u.role === 'admin',
  importData: (u) => ['admin', 'manager', 'inventory'].includes(u.role),
  resolveConflicts: (u) => ['admin', 'manager', 'inventory'].includes(u.role),
  linkQr: (u) => ['admin', 'manager', 'inventory'].includes(u.role),
  investigate: (u) => ['admin', 'manager', 'inventory'].includes(u.role),
};

/**
 * SQL predicate restricting `assets a` to what the user may see.
 * Reps see assets in their teams, assigned to them, in their custody,
 * or in an open transfer they are sending or receiving.
 * Placeholders start at $<offset>.
 */
export function assetScope(user, offset = 1) {
  if (can.viewAll(user)) return { sql: 'TRUE', params: [] };
  const p = `$${offset}`;
  return {
    sql: `(a.assigned_rep_id = ${p} OR a.custodian_id = ${p}
           OR a.team_id IN (SELECT team_id FROM user_teams WHERE user_id = ${p})
           OR EXISTS (SELECT 1 FROM transfers t WHERE t.asset_id = a.id AND t.status = 'in_transit'
                      AND (t.recipient_id = ${p} OR t.sender_id = ${p})))`,
    params: [user.id],
  };
}

export const assetCode = (n) => (n == null ? null : `AH-${String(n).padStart(6, '0')}`);
