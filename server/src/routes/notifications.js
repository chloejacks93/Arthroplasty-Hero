import { Router } from 'express';
import { z } from 'zod';
import { query } from '../db.js';
import { parse } from '../lib/errors.js';

// Minimal in-app inbox. Preferences, e-mail and push arrive in Phase 7.
const router = Router();

router.get('/', async (req, res) => {
  const { rows } = await query(
    `SELECT id, kind, title, body, link, asset_id, transfer_id, created_at, read_at
       FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.user.id]);
  const { rows: [c] } = await query('SELECT count(*)::int AS n FROM notifications WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  res.json({ items: rows, unread: c.n });
});

const readSchema = z.object({ ids: z.array(z.uuid()).max(200).optional(), all: z.boolean().optional() });

router.post('/read', async (req, res) => {
  const b = parse(readSchema, req.body);
  if (b.all) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL', [req.user.id]);
  else if (b.ids?.length) await query('UPDATE notifications SET read_at = now() WHERE user_id = $1 AND id = ANY($2) AND read_at IS NULL', [req.user.id, b.ids]);
  res.json({ ok: true });
});

export default router;
