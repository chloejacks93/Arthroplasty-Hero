import { Router } from 'express';
import { z } from 'zod';
import { query, tx } from '../db.js';
import { parse, forbidden, notFound, conflict, badRequest } from '../lib/errors.js';
import { can, assetScope, assetCode } from '../lib/roles.js';
import { canonicalQr } from '../lib/qr.js';
import { event } from '../lib/importCommit.js';

const router = Router();

// Same user scanning the same asset again within this window does not add
// another ledger entry (prevents noise from repeated camera reads).
const SCAN_DEDUPE_MINUTES = 2;

async function assetSummary(db, assetId, user) {
  const scope = assetScope(user, 2);
  const { rows: [a] } = await db.query(
    `SELECT a.id, a.asset_no, a.reference, a.description, a.asset_type, a.status, a.lot, a.last_scanned_at,
            f.name AS facility_name, f.facility_type, r.full_name AS rep_name, c.full_name AS custodian_name,
            tm.name AS team_name, q.qr_value, coalesce((${scope.sql}), false) AS in_scope
       FROM assets a
       LEFT JOIN facilities f ON f.id = a.current_facility_id
       LEFT JOIN users r ON r.id = a.assigned_rep_id
       LEFT JOIN users c ON c.id = a.custodian_id
       LEFT JOIN teams tm ON tm.id = a.team_id
       LEFT JOIN asset_qr_codes q ON q.asset_id = a.id AND q.active
      WHERE a.id = $1`, [assetId, ...scope.params]);
  return a ? { ...a, asset_code: assetCode(a.asset_no) } : null;
}

// ---------------------------------------------------------------------
// Scan: resolve a QR payload to an asset and record the scan.
// A person physically holding a tray may always see what it is, even if it
// belongs to another team; `in_scope` tells the client whether the full
// record is available to them.
// ---------------------------------------------------------------------
const scanSchema = z.object({ value: z.string().max(2000), source: z.enum(['camera', 'manual']).default('camera') });

router.post('/scan', async (req, res) => {
  const { value, source } = parse(scanSchema, req.body);
  const qr = canonicalQr(value);
  const result = await tx(async (c) => {
    const { rows: [link] } = await c.query(
      `SELECT asset_id FROM asset_qr_codes WHERE active AND lower(btrim(qr_value)) = lower(btrim($1))`, [qr]);
    if (!link) {
      await c.query(`INSERT INTO scan_log (qr_value, user_id, result, source) VALUES ($1, $2, 'unknown', $3)`, [qr, req.user.id, source]);
      const { rows: [pending] } = await c.query(
        `SELECT r.id, r.requested_at, u.full_name AS requested_by_name, a.reference, a.asset_no
           FROM qr_link_requests r JOIN users u ON u.id = r.requested_by JOIN assets a ON a.id = r.asset_id
          WHERE r.status = 'pending' AND lower(btrim(r.qr_value)) = lower(btrim($1))`, [qr]);
      return {
        status: 'unknown', qr_value: qr,
        pendingRequest: pending ? { ...pending, asset_code: assetCode(pending.asset_no) } : null,
      };
    }
    const before = await assetSummary(c, link.asset_id, req.user);
    await c.query(`INSERT INTO scan_log (qr_value, asset_id, user_id, result, source) VALUES ($1, $2, $3, 'matched', $4)`,
      [qr, link.asset_id, req.user.id, source]);
    await c.query('UPDATE assets SET last_scanned_at = now() WHERE id = $1', [link.asset_id]);
    const { rowCount: recent } = await c.query(
      `SELECT 1 FROM asset_events WHERE asset_id = $1 AND actor_id = $2 AND event_type = 'scanned'
          AND occurred_at > now() - make_interval(mins => $3) LIMIT 1`, [link.asset_id, req.user.id, SCAN_DEDUPE_MINUTES]);
    if (!recent) {
      await event(c, link.asset_id, 'scanned', req.user.id, { details: { source } });
    }
    return { status: 'matched', qr_value: qr, asset: before, previousScanAt: before.last_scanned_at };
  });
  res.json({ ...result, permissions: { linkQr: can.linkQr(req.user) } });
});

// ---------------------------------------------------------------------
// Link / unlink (inventory, management, admin)
// ---------------------------------------------------------------------
const linkSchema = z.object({
  asset_id: z.uuid(),
  value: z.string().max(2000),
  replace: z.boolean().default(false),
  reason: z.string().trim().max(300).optional(),
});

async function linkInTx(c, { assetId, qr, replace, reason, user, requestId = null }) {
  const { rows: [asset] } = await c.query('SELECT id, asset_no, reference FROM assets WHERE id = $1 AND retired_at IS NULL FOR UPDATE', [assetId]);
  if (!asset) throw notFound('Asset not found.');
  const { rows: [taken] } = await c.query(
    `SELECT q.asset_id, a.asset_no, a.reference FROM asset_qr_codes q JOIN assets a ON a.id = q.asset_id
      WHERE q.active AND lower(btrim(q.qr_value)) = lower(btrim($1))`, [qr]);
  if (taken && taken.asset_id === assetId) return { alreadyLinked: true };
  if (taken) {
    throw conflict(`This QR code is already linked to ${assetCode(taken.asset_no)} · ${taken.reference}. A code can only belong to one asset.`,
      { asset_id: taken.asset_id });
  }
  const { rows: [current] } = await c.query('SELECT id, qr_value FROM asset_qr_codes WHERE asset_id = $1 AND active', [assetId]);
  if (current && !replace) {
    throw conflict(`${assetCode(asset.asset_no)} already has a QR code (${current.qr_value}). Choose Replace to swap it.`, { current: current.qr_value });
  }
  if (current) {
    if (!reason) throw badRequest('Give a reason for replacing the existing QR code.');
    await c.query(
      `UPDATE asset_qr_codes SET active = false, unlinked_by = $2, unlinked_at = now(), unlink_reason = $3 WHERE id = $1`,
      [current.id, user.id, reason]);
    await event(c, assetId, 'qr_unlinked', user.id, { details: { qr_value: current.qr_value, reason } });
  }
  await c.query('INSERT INTO asset_qr_codes (asset_id, qr_value, linked_by) VALUES ($1, $2, $3)', [assetId, qr, user.id]);
  await event(c, assetId, 'qr_linked', user.id, { details: { qr_value: qr, replaced: current?.qr_value || null, request_id: requestId } });
  // Any other pending request for this code is now settled.
  await c.query(
    `UPDATE qr_link_requests SET status = CASE WHEN asset_id = $2 THEN 'approved' ELSE 'rejected' END,
            decided_by = $3, decided_at = now(),
            decision_note = coalesce(decision_note, CASE WHEN asset_id = $2 THEN 'Linked' ELSE 'Code linked to a different asset' END)
      WHERE status = 'pending' AND lower(btrim(qr_value)) = lower(btrim($1))`, [qr, assetId, user.id]);
  return { alreadyLinked: false };
}

router.post('/link', async (req, res) => {
  if (!can.linkQr(req.user)) throw forbidden('Only inventory, management and administrators can link QR codes. Send a link request instead.');
  const b = parse(linkSchema, req.body);
  const qr = canonicalQr(b.value);
  const r = await tx((c) => linkInTx(c, { assetId: b.asset_id, qr, replace: b.replace, reason: b.reason, user: req.user }));
  res.json({ ok: true, ...r, asset: await assetSummary({ query }, b.asset_id, req.user) });
});

const unlinkSchema = z.object({ asset_id: z.uuid(), reason: z.string().trim().min(3, 'is required').max(300) });

router.post('/unlink', async (req, res) => {
  if (!can.linkQr(req.user)) throw forbidden();
  const { asset_id: assetId, reason } = parse(unlinkSchema, req.body);
  await tx(async (c) => {
    const { rows: [cur] } = await c.query('SELECT id, qr_value FROM asset_qr_codes WHERE asset_id = $1 AND active FOR UPDATE', [assetId]);
    if (!cur) throw badRequest('This asset has no linked QR code.');
    await c.query(`UPDATE asset_qr_codes SET active = false, unlinked_by = $2, unlinked_at = now(), unlink_reason = $3 WHERE id = $1`,
      [cur.id, req.user.id, reason]);
    await event(c, assetId, 'qr_unlinked', req.user.id, { details: { qr_value: cur.qr_value, reason } });
  });
  res.json({ ok: true });
});

// ---------------------------------------------------------------------
// Link requests (any signed-in user can propose; linkers decide)
// ---------------------------------------------------------------------
const requestSchema = z.object({ value: z.string().max(2000), asset_id: z.uuid(), note: z.string().trim().max(500).optional() });

router.post('/requests', async (req, res) => {
  const b = parse(requestSchema, req.body);
  const qr = canonicalQr(b.value);
  const id = await tx(async (c) => {
    const { rowCount: linked } = await c.query(`SELECT 1 FROM asset_qr_codes WHERE active AND lower(btrim(qr_value)) = lower(btrim($1))`, [qr]);
    if (linked) throw conflict('This QR code is already linked to an asset. Scan it again to see which.');
    const { rows: [a] } = await c.query('SELECT id FROM assets WHERE id = $1 AND retired_at IS NULL', [b.asset_id]);
    if (!a) throw notFound('Asset not found.');
    const { rows: [r] } = await c.query(
      `INSERT INTO qr_link_requests (qr_value, asset_id, requested_by, note) VALUES ($1, $2, $3, $4) RETURNING id`,
      [qr, b.asset_id, req.user.id, b.note || null]);
    await c.query(
      `INSERT INTO notifications (user_id, kind, title, body, asset_id, link, dedupe_key)
       SELECT id, 'qr_link_request', 'QR link request to confirm', $1, $2, '/qr-requests', $3
         FROM users WHERE active AND role IN ('admin','manager','inventory')
       ON CONFLICT DO NOTHING`,
      [`${req.user.full_name} matched an unlinked QR code to an asset.`, b.asset_id, `qrreq:${r.id}`]);
    return r.id;
  });
  res.status(201).json({ ok: true, id });
});

router.get('/requests', async (req, res) => {
  if (!can.linkQr(req.user)) throw forbidden();
  const status = parse(z.enum(['pending', 'approved', 'rejected', 'all']).default('pending'), req.query.status);
  const { rows } = await query(
    `SELECT r.id, r.qr_value, r.asset_id, a.asset_no, a.reference, a.description, r.note, r.status, r.requested_at,
            ru.full_name AS requested_by_name, r.decided_at, du.full_name AS decided_by_name, r.decision_note,
            (SELECT q.qr_value FROM asset_qr_codes q WHERE q.asset_id = a.id AND q.active) AS asset_current_qr
       FROM qr_link_requests r
       JOIN assets a ON a.id = r.asset_id
       JOIN users ru ON ru.id = r.requested_by
       LEFT JOIN users du ON du.id = r.decided_by
      ${status === 'all' ? '' : 'WHERE r.status = $1'}
      ORDER BY (r.status = 'pending') DESC, r.requested_at DESC LIMIT 500`, status === 'all' ? [] : [status]);
  res.json({ items: rows.map((r) => ({ ...r, asset_code: assetCode(r.asset_no) })) });
});

const decideSchema = z.object({ note: z.string().trim().max(300).optional(), replace: z.boolean().default(false) });

router.post('/requests/:id/approve', async (req, res) => {
  if (!can.linkQr(req.user)) throw forbidden();
  const id = parse(z.uuid(), req.params.id);
  const { note, replace } = parse(decideSchema, req.body);
  await tx(async (c) => {
    const { rows: [r] } = await c.query('SELECT * FROM qr_link_requests WHERE id = $1 FOR UPDATE', [id]);
    if (!r) throw notFound('Request not found.');
    if (r.status !== 'pending') throw conflict(`This request was already ${r.status}.`);
    if (note) await c.query('UPDATE qr_link_requests SET decision_note = $2 WHERE id = $1', [id, note]);
    await linkInTx(c, { assetId: r.asset_id, qr: r.qr_value, replace, reason: replace ? `Replaced via link request${note ? `: ${note}` : ''}` : undefined, user: req.user, requestId: id });
  });
  res.json({ ok: true });
});

router.post('/requests/:id/reject', async (req, res) => {
  if (!can.linkQr(req.user)) throw forbidden();
  const id = parse(z.uuid(), req.params.id);
  const { note } = parse(decideSchema, req.body);
  const { rowCount } = await query(
    `UPDATE qr_link_requests SET status = 'rejected', decided_by = $2, decided_at = now(), decision_note = $3
      WHERE id = $1 AND status = 'pending'`, [id, req.user.id, note || null]);
  if (!rowCount) throw conflict('This request is no longer pending.');
  res.json({ ok: true });
});

export default router;
