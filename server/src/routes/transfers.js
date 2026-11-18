import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { config } from '../config.js';
import { parse, forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { can, assetScope, assetCode } from '../lib/roles.js';
import { canonicalQr } from '../lib/qr.js';
import { event } from '../lib/importCommit.js';
import { statusFor } from '../lib/importEngine.js';
import { notifyUsers, notifyRoles, MANAGERS } from '../lib/notify.js';
import { sweepOverdueTransfers } from '../lib/transfers.js';

const router = Router();

const TRANSFER_SELECT = `
  SELECT t.id, t.transfer_no, t.status, t.reason, t.initiated_at, t.accept_by, t.received_at, t.closed_at, t.close_reason,
         (t.status = 'in_transit' AND t.accept_by < now()) AS overdue,
         t.asset_id, a.asset_no, a.reference, a.description, a.asset_type, a.status AS asset_status,
         EXISTS (SELECT 1 FROM asset_qr_codes q WHERE q.asset_id = a.id AND q.active) AS has_qr,
         t.from_facility_id, ff.name AS from_facility, t.to_facility_id, tf.name AS to_facility, tf.facility_type AS to_facility_type,
         t.received_facility_id, rf.name AS received_facility,
         t.sender_id, s.full_name AS sender_name, t.recipient_id, rc.full_name AS recipient_name,
         rb.full_name AS received_by_name, cb.full_name AS closed_by_name,
         tc.via_qr_scan, tc.notes AS receipt_note,
         t.batch_id, tb.batch_no, tb.asset_count AS batch_size
    FROM transfers t
    JOIN assets a ON a.id = t.asset_id
    LEFT JOIN facilities ff ON ff.id = t.from_facility_id
    JOIN facilities tf ON tf.id = t.to_facility_id
    LEFT JOIN facilities rf ON rf.id = t.received_facility_id
    JOIN users s ON s.id = t.sender_id
    JOIN users rc ON rc.id = t.recipient_id
    LEFT JOIN users rb ON rb.id = t.received_by
    LEFT JOIN users cb ON cb.id = t.closed_by
    LEFT JOIN transfer_confirmations tc ON tc.transfer_id = t.id
    LEFT JOIN transfer_batches tb ON tb.id = t.batch_id`;

const tag = (r) => ({ ...r, asset_code: assetCode(r.asset_no) });

/**
 * If the receiving facility has a "team for trays received here", switch the
 * asset to that team. Returns { from, to } team names when it changed.
 */
async function applyReceivingTeam(c, assetId, facilityId) {
  const { rows: [x] } = await c.query(
    `SELECT f.receiving_team_id, nt.name AS new_team, a.team_id, ot.name AS old_team
       FROM facilities f JOIN assets a ON a.id = $1
       LEFT JOIN teams nt ON nt.id = f.receiving_team_id AND nt.active
       LEFT JOIN teams ot ON ot.id = a.team_id
      WHERE f.id = $2`, [assetId, facilityId]);
  if (!x?.receiving_team_id || !x.new_team || x.team_id === x.receiving_team_id) return null;
  await c.query('UPDATE assets SET team_id = $2 WHERE id = $1', [assetId, x.receiving_team_id]);
  return { from: x.old_team, to: x.new_team };
}

// ---------------------------------------------------------------------
// List
// ---------------------------------------------------------------------
const listSchema = z.object({
  box: z.enum(['incoming', 'outgoing', 'mine', 'all']).default('all'),
  status: z.enum(['in_transit', 'overdue', 'received', 'closed', 'any']).default('in_transit'),
  asset_id: z.uuid().optional(),
  facility_id: z.uuid().optional(),
});

router.get('/', async (req, res) => {
  const f = parse(listSchema, req.query);
  const params = [];
  const where = [];
  const me = () => { if (!params.length) params.push(req.user.id); return '$1'; }; // user id is always $1 when used
  if (f.box === 'incoming') where.push(`t.recipient_id = ${me()}`);
  else if (f.box === 'outgoing') where.push(`t.sender_id = ${me()}`);
  else if (f.box === 'mine' || !can.viewAll(req.user)) {
    const scope = assetScope(req.user, 1);
    where.push(`(t.recipient_id = ${me()} OR t.sender_id = $1 OR ${scope.sql})`);
  }
  if (f.status === 'in_transit') where.push(`t.status = 'in_transit'`);
  if (f.status === 'overdue') where.push(`t.status = 'in_transit' AND t.accept_by < now()`);
  if (f.status === 'received') where.push(`t.status = 'received'`);
  if (f.status === 'closed') where.push(`t.status IN ('cancelled','rejected')`);
  if (f.asset_id) { params.push(f.asset_id); where.push(`t.asset_id = $${params.length}`); }
  if (f.facility_id) { params.push(f.facility_id); where.push(`(t.to_facility_id = $${params.length} OR t.from_facility_id = $${params.length})`); }
  const { rows } = await query(
    `${TRANSFER_SELECT} WHERE ${where.length ? where.join(' AND ') : 'TRUE'}
     ORDER BY (t.status = 'in_transit') DESC, t.initiated_at DESC LIMIT 500`, params);
  res.json({ items: rows.map(tag) });
});

// ---------------------------------------------------------------------
// Initiate
// ---------------------------------------------------------------------
const createSchema = z.object({
  asset_id: z.uuid().optional(),
  asset_ids: z.array(z.uuid()).min(1).max(100).optional(),
  to_facility_id: z.uuid(),
  recipient_id: z.uuid(),
  reason: z.string().trim().max(300).optional(),
  // Inventory/management returning trays to a warehouse themselves: record the
  // receipt in the same step instead of making them receive their own transfer.
  receive_now: z.boolean().optional(),
  // Trays whose label was scanned while building the list (recorded on the receipt).
  scanned_asset_ids: z.array(z.uuid()).max(100).optional(),
}).refine((b) => b.asset_id || b.asset_ids, { message: 'Choose at least one asset.', path: ['asset_ids'] });

/**
 * Start transfers for one or more assets in ONE transaction (all or nothing).
 * Several assets are grouped into a shipment (transfer_batches) but each keeps
 * its own transfer, receipt and history. The recipient gets one notification.
 */
router.post('/', async (req, res) => {
  const b = parse(createSchema, req.body);
  const ids = [...new Set(b.asset_ids || [b.asset_id])];
  const created = await tx(async (c) => {
    const { rows: [fac] } = await c.query('SELECT id, name, facility_type FROM facilities WHERE id = $1 AND active', [b.to_facility_id]);
    if (!fac) throw badRequest('Choose an active destination facility.');
    const { rows: [rcpt] } = await c.query(`SELECT id, full_name FROM users WHERE id = $1 AND active AND role <> 'system'`, [b.recipient_id]);
    if (!rcpt) throw badRequest('Choose an active receiving representative.');
    if (b.receive_now) {
      if (!can.viewAll(req.user)) throw forbidden('Only inventory, management and administrators can complete a return in one step.');
      if (fac.facility_type !== 'warehouse') throw badRequest('One-step receipt is only for returns to a warehouse.');
      if (rcpt.id !== req.user.id) throw badRequest('One-step receipt is only when you are the one returning the trays.');
    }
    const scanned = new Set(b.scanned_asset_ids || []);

    // Validate every asset first; report all problems at once.
    const scope = assetScope(req.user, 2);
    const assets = [];
    const problems = [];
    for (const id of ids) {
      const { rows: [a] } = await c.query(
        `SELECT a.*, coalesce((${scope.sql}), false) AS in_scope FROM assets a WHERE a.id = $1 AND a.retired_at IS NULL FOR UPDATE`,
        [id, ...scope.params]);
      if (!a) { problems.push({ asset_id: id, reason: 'Asset not found.' }); continue; }
      const label = `${assetCode(a.asset_no)} · ${a.reference}`;
      if (!a.in_scope) { problems.push({ asset_id: id, reference: a.reference, reason: `${label} belongs to another team. Report it with “Report a problem” if you have it.` }); continue; }
      const { rows: [open] } = await c.query(
        `SELECT t.transfer_no, u.full_name FROM transfers t JOIN users u ON u.id = t.recipient_id WHERE t.asset_id = $1 AND t.status = 'in_transit'`, [a.id]);
      if (open) { problems.push({ asset_id: id, reference: a.reference, reason: `${label} is already in transit to ${open.full_name} (T-${open.transfer_no}). It must be received or cancelled first.` }); continue; }
      // Same place, same person is pointless, except for a warehouse: checking trays
      // back in there must always work (it may also switch their team).
      if (fac.facility_type !== 'warehouse' && fac.id === a.current_facility_id && rcpt.id === (a.custodian_id || a.assigned_rep_id) && a.status !== 'missing') {
        problems.push({ asset_id: id, reference: a.reference, reason: `${label} is already at ${fac.name} with ${rcpt.full_name}.` });
        continue;
      }
      assets.push(a);
    }
    if (problems.length) {
      const msg = problems.length === 1 && ids.length === 1
        ? problems[0].reason.replace(/^AH-\d+ · .*? (belongs|is already)/, 'This asset $1')
        : `${problems.length} of ${ids.length} assets can’t be sent: ${problems.map((x) => x.reason).join(' ')}`;
      const err = ids.length === 1 && /another team/.test(problems[0].reason) ? forbidden(msg) : conflict(msg);
      err.details = { problems };
      throw err;
    }

    let batch = null;
    if (assets.length > 1) {
      ({ rows: [batch] } = await c.query(
        `INSERT INTO transfer_batches (sender_id, recipient_id, to_facility_id, reason, asset_count) VALUES ($1,$2,$3,$4,$5) RETURNING id, batch_no`,
        [req.user.id, rcpt.id, fac.id, b.reason || null, assets.length]));
    }
    const acceptBy = new Date(Date.now() + config.transferAcceptHours * 3600 * 1000);
    const out = [];
    for (const a of assets) {
      const { rows: [t] } = await c.query(
        `INSERT INTO transfers (asset_id, from_facility_id, to_facility_id, sender_id, recipient_id, reason, accept_by, from_status, from_custodian_id, batch_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, transfer_no`,
        [a.id, a.current_facility_id, fac.id, req.user.id, rcpt.id, b.reason || null, acceptBy, a.status, a.custodian_id, batch?.id || null]);
      await c.query(`UPDATE assets SET status = 'in_transit', version = version + 1 WHERE id = $1`, [a.id]);
      await event(c, a.id, 'transfer_initiated', req.user.id, {
        from_facility_id: a.current_facility_id, to_facility_id: fac.id, from_custodian_id: a.custodian_id, to_custodian_id: rcpt.id,
        from_status: a.status, to_status: 'in_transit', transfer_id: t.id,
        details: { transfer_no: t.transfer_no, reason: b.reason || null, ...(batch ? { shipment_no: batch.batch_no, shipment_size: assets.length } : {}) },
      });
      if (b.receive_now) {
        const viaScan = scanned.has(a.id);
        const note = `Returned to the warehouse by ${req.user.full_name}; received in the same step${viaScan ? ' (label scanned)' : ''}.`;
        const newStatus = statusFor(fac.facility_type);
        await c.query(
          `UPDATE transfers SET status = 'received', received_at = now(), received_by = $2, received_facility_id = $3 WHERE id = $1`,
          [t.id, req.user.id, fac.id]);
        await c.query(
          `INSERT INTO transfer_confirmations (transfer_id, confirmed_by, facility_id, via_qr_scan, notes) VALUES ($1,$2,$3,$4,$5)`,
          [t.id, req.user.id, fac.id, viaScan, note]);
        await c.query(
          `UPDATE assets SET status = $2, current_facility_id = $3, custodian_id = $4, last_transferred_at = now(),
                  last_scanned_at = CASE WHEN $5 THEN now() ELSE last_scanned_at END, version = version + 1
            WHERE id = $1`, [a.id, newStatus, fac.id, req.user.id, viaScan]);
        const teamChange = await applyReceivingTeam(c, a.id, fac.id);
        await event(c, a.id, 'transfer_received', req.user.id, {
          from_facility_id: a.current_facility_id, to_facility_id: fac.id, from_custodian_id: a.custodian_id, to_custodian_id: req.user.id,
          from_status: 'in_transit', to_status: newStatus, transfer_id: t.id,
          details: { transfer_no: t.transfer_no, via_qr_scan: viaScan, one_step_return: true, note, ...(teamChange ? { team: teamChange } : {}) },
        });
      }
      out.push({ ...t, asset: a });
    }
    if (rcpt.id !== req.user.id) {
      const one = out[0];
      await notifyUsers(c, [rcpt.id], batch ? {
        kind: 'transfer_incoming', title: `Incoming: ${assets.length} trays from ${req.user.full_name}`,
        body: `Shipment S-${batch.batch_no} to ${fac.name}: ${assets.slice(0, 4).map((a) => a.reference).join(', ')}${assets.length > 4 ? ` and ${assets.length - 4} more` : ''}. Scan each one when it arrives.`,
        link: '/receive', dedupe_key: `incoming-batch:${batch.id}`,
      } : {
        kind: 'transfer_incoming', title: `Incoming: ${one.asset.reference}`,
        body: `${req.user.full_name} is sending ${assetCode(one.asset.asset_no)} to you at ${fac.name}. Scan it when it arrives to confirm receipt.`,
        asset_id: one.asset.id, transfer_id: one.id, link: '/receive', dedupe_key: `incoming:${one.id}`,
      });
    }
    return { ids: out.map((t) => t.id), batch };
  });
  const { rows } = await query(`${TRANSFER_SELECT} WHERE t.id = ANY($1) ORDER BY t.transfer_no`, [created.ids]);
  const transfers = rows.map(tag);
  res.status(201).json({ transfer: transfers[0], transfers, shipment: created.batch });
});

// ---------------------------------------------------------------------
// Confirm receipt (recipient only; must scan the label when one is linked)
// ---------------------------------------------------------------------
const receiveSchema = z.object({
  qr_value: z.string().max(2000).optional(),
  facility_id: z.uuid().optional(),
  note: z.string().trim().max(300).optional(),
});

router.post('/:id/receive', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const b = parse(receiveSchema, req.body);
  await tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'in_transit') throw conflict(`This transfer was already ${t.status.replace('_', ' ')}.`);
    if (t.recipient_id !== req.user.id) throw forbidden('Only the receiving representative can confirm receipt.');
    const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [t.asset_id]);
    const { rows: [qr] } = await c.query('SELECT qr_value FROM asset_qr_codes WHERE asset_id = $1 AND active', [a.id]);
    let viaScan = false;
    if (qr) {
      if (!b.qr_value) throw badRequest('Scan the QR label on the tray to confirm you have it.');
      if (canonicalQr(b.qr_value).toLowerCase() !== qr.qr_value.trim().toLowerCase()) {
        throw badRequest('That label belongs to a different asset. Scan the label on this tray.');
      }
      viaScan = true;
    }
    const facilityId = b.facility_id || t.to_facility_id;
    const { rows: [fac] } = await c.query('SELECT id, name, facility_type FROM facilities WHERE id = $1 AND active', [facilityId]);
    if (!fac) throw badRequest('Choose an active facility.');
    const newStatus = statusFor(fac.facility_type);

    await c.query(
      `UPDATE transfers SET status = 'received', received_at = now(), received_by = $2, received_facility_id = $3 WHERE id = $1`,
      [id, req.user.id, fac.id]);
    await c.query(
      `INSERT INTO transfer_confirmations (transfer_id, confirmed_by, facility_id, via_qr_scan, notes) VALUES ($1,$2,$3,$4,$5)`,
      [id, req.user.id, fac.id, viaScan, b.note || null]);
    await c.query(
      `UPDATE assets SET status = $2, current_facility_id = $3, custodian_id = $4, last_transferred_at = now(),
              last_scanned_at = CASE WHEN $5 THEN now() ELSE last_scanned_at END, version = version + 1
        WHERE id = $1`, [a.id, newStatus, fac.id, req.user.id, viaScan]);
    const teamChange = await applyReceivingTeam(c, a.id, fac.id);
    await event(c, a.id, 'transfer_received', req.user.id, {
      from_facility_id: t.from_facility_id, to_facility_id: fac.id, from_custodian_id: t.from_custodian_id, to_custodian_id: req.user.id,
      from_status: 'in_transit', to_status: newStatus, transfer_id: id,
      details: {
        transfer_no: t.transfer_no, via_qr_scan: viaScan, note: b.note || null, ...(teamChange ? { team: teamChange } : {}),
        ...(fac.id !== t.to_facility_id ? { planned_facility_id: t.to_facility_id, received_elsewhere: true } : {}),
      },
    });
    if (t.sender_id !== req.user.id) {
      await notifyUsers(c, [t.sender_id], {
        kind: 'transfer_update', title: `Received: ${a.reference}`,
        body: `${req.user.full_name} confirmed receipt at ${fac.name}.`,
        asset_id: a.id, transfer_id: id, link: `/assets/${a.id}`, dedupe_key: `received:${id}`,
      });
    }
    if (fac.id !== t.to_facility_id) {
      await notifyRoles(c, MANAGERS, {
        kind: 'location_discrepancy', title: `Received at a different facility: ${a.reference}`,
        body: `T-${t.transfer_no} was confirmed at ${fac.name} instead of the planned destination.`,
        asset_id: a.id, transfer_id: id, link: `/assets/${a.id}`, dedupe_key: `elsewhere:${id}`,
      });
    }
  });
  const { rows: [full] } = await query(`${TRANSFER_SELECT} WHERE t.id = $1`, [id]);
  res.json({ transfer: tag(full) });
});

// ---------------------------------------------------------------------
// Recipient reports it never arrived -> investigation
// ---------------------------------------------------------------------
const noteSchema = z.object({ note: z.string().trim().min(3, 'is required').max(500) });

router.post('/:id/not-received', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(noteSchema, req.body);
  await tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'in_transit') throw conflict(`This transfer was already ${t.status.replace('_', ' ')}.`);
    if (t.recipient_id !== req.user.id && !can.investigate(req.user)) throw forbidden('Only the receiving representative can report this.');
    const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [t.asset_id]);
    const { rows: [inv] } = await c.query(
      `INSERT INTO investigations (asset_id, kind, facility_id, reported_by, description, asset_status_before, transfer_id)
       VALUES ($1, 'missing', $2, $3, $4, $5, $6) RETURNING id, case_ref`,
      [a.id, t.to_facility_id, req.user.id, `Transfer T-${t.transfer_no} reported not received: ${note}`, t.from_status, id]);
    await c.query(`INSERT INTO investigation_events (investigation_id, actor_id, action, to_status, note) VALUES ($1,$2,'reported','open',$3)`,
      [inv.id, req.user.id, note]);
    await c.query(
      `UPDATE transfers SET status = 'rejected', closed_at = now(), closed_by = $2, close_reason = $3, investigation_id = $4 WHERE id = $1`,
      [id, req.user.id, note, inv.id]);
    await c.query(`UPDATE assets SET status = 'under_investigation', version = version + 1 WHERE id = $1`, [a.id]);
    await event(c, a.id, 'transfer_rejected', req.user.id, {
      from_status: 'in_transit', to_status: 'under_investigation', transfer_id: id, investigation_id: inv.id,
      details: { transfer_no: t.transfer_no, note },
    });
    await event(c, a.id, 'problem_reported', req.user.id, {
      investigation_id: inv.id, transfer_id: id, details: { kind: 'missing', case_ref: inv.case_ref, source: 'transfer not received' },
    });
    const n = {
      kind: 'asset_missing', title: `Not received: ${a.reference}`,
      body: `${req.user.full_name} reports T-${t.transfer_no} never arrived. Investigation #${inv.case_ref} opened.`,
      asset_id: a.id, transfer_id: id, link: `/investigations/${inv.id}`, dedupe_key: `notreceived:${id}`,
    };
    await notifyUsers(c, [t.sender_id], n);
    await notifyRoles(c, MANAGERS, n, { except: [t.sender_id, req.user.id] });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Cancel (sender or management, before receipt)
// ---------------------------------------------------------------------
router.post('/:id/cancel', async (req, res) => {
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(noteSchema, req.body);
  await tx(async (c) => {
    const { rows: [t] } = await c.query('SELECT * FROM transfers WHERE id = $1 FOR UPDATE', [id]);
    if (!t) throw notFound('Transfer not found.');
    if (t.status !== 'in_transit') throw conflict(`This transfer was already ${t.status.replace('_', ' ')}.`);
    if (t.sender_id !== req.user.id && !can.investigate(req.user)) throw forbidden('Only the sender or management can cancel a transfer.');
    const { rows: [a] } = await c.query('SELECT * FROM assets WHERE id = $1 FOR UPDATE', [t.asset_id]);
    const restore = t.from_status && t.from_status !== 'in_transit' ? t.from_status : 'at_facility';
    await c.query(`UPDATE transfers SET status = 'cancelled', closed_at = now(), closed_by = $2, close_reason = $3 WHERE id = $1`, [id, req.user.id, note]);
    await c.query(`UPDATE assets SET status = $2, version = version + 1 WHERE id = $1`, [a.id, restore]);
    await event(c, a.id, 'transfer_cancelled', req.user.id, {
      from_status: 'in_transit', to_status: restore, transfer_id: id, details: { transfer_no: t.transfer_no, reason: note },
    });
    await notifyUsers(c, [t.recipient_id, t.sender_id].filter((u) => u !== req.user.id), {
      kind: 'transfer_update', title: `Transfer cancelled: ${a.reference}`,
      body: `${req.user.full_name} cancelled T-${t.transfer_no}: ${note}`,
      asset_id: a.id, transfer_id: id, link: `/assets/${a.id}`, dedupe_key: `cancelled:${id}`,
    });
  });
  res.json({ ok: true });
});

// Management can trigger the overdue sweep (it also runs automatically).
router.post('/sweep-overdue', async (req, res) => {
  if (!can.investigate(req.user)) throw forbidden();
  res.json({ overdue: await sweepOverdueTransfers({ query }) });
});

export default router;
