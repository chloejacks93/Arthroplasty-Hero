import { notifyUsers, notifyRoles, MANAGERS } from './notify.js';
import { assetCode } from './roles.js';

/**
 * Remind recipients (and senders, and managers) about transfers that are still
 * unconfirmed after their accept-by deadline. Idempotent per transfer per day.
 * Returns the number of overdue transfers found.
 */
export async function sweepOverdueTransfers(db) {
  const { rows } = await db.query(
    `SELECT t.id, t.transfer_no, t.sender_id, t.recipient_id, t.asset_id, t.accept_by, a.asset_no, a.reference,
            tf.name AS to_facility, rc.full_name AS recipient_name
       FROM transfers t
       JOIN assets a ON a.id = t.asset_id
       JOIN facilities tf ON tf.id = t.to_facility_id
       JOIN users rc ON rc.id = t.recipient_id
      WHERE t.status = 'in_transit' AND t.accept_by < now()
        AND (t.last_reminder_at IS NULL OR t.last_reminder_at < now() - interval '20 hours')`);
  for (const t of rows) {
    const day = new Date().toISOString().slice(0, 10);
    const label = `${assetCode(t.asset_no)} · ${t.reference}`;
    await notifyUsers(db, [t.recipient_id], {
      kind: 'transfer_overdue', title: `Confirm receipt: ${t.reference}`,
      body: `${label} is past its receipt deadline. Scan it to confirm, or report it not received.`,
      asset_id: t.asset_id, transfer_id: t.id, link: '/receive', dedupe_key: `overdue:${t.id}:${day}`,
    });
    await notifyUsers(db, [t.sender_id], {
      kind: 'transfer_overdue', title: `Not yet received: ${t.reference}`,
      body: `${t.recipient_name} has not confirmed receipt at ${t.to_facility}.`,
      asset_id: t.asset_id, transfer_id: t.id, link: `/transfers?status=overdue`, dedupe_key: `overdue:${t.id}:${day}`,
    });
    await notifyRoles(db, MANAGERS, {
      kind: 'transfer_overdue', title: `Overdue transfer T-${t.transfer_no}`,
      body: `${label} to ${t.to_facility} (${t.recipient_name}) is unconfirmed past its deadline.`,
      asset_id: t.asset_id, transfer_id: t.id, link: `/transfers?status=overdue`, dedupe_key: `overdue:${t.id}:${day}`,
    }, { except: [t.sender_id, t.recipient_id] });
    await db.query('UPDATE transfers SET last_reminder_at = now() WHERE id = $1', [t.id]);
  }
  return rows.length;
}
