import crypto from 'node:crypto';

/** Fields that differ between two plain objects, as { field: { from, to } }. */
export function diff(before, after, fields) {
  const out = {};
  for (const f of fields) {
    if (!(f in after)) continue;
    const a = before?.[f] ?? null;
    const b = after[f] ?? null;
    if (JSON.stringify(a) !== JSON.stringify(b)) out[f] = { from: a, to: b };
  }
  return out;
}

export async function audit(db, actorId, entity, entityId, action, changes = {}) {
  await db.query(
    `INSERT INTO admin_audit (actor_id, entity, entity_id, action, changes) VALUES ($1,$2,$3,$4,$5)`,
    [actorId, entity, entityId, action, JSON.stringify(changes)]);
}

// Readable temporary password: 3 groups of 4 from an unambiguous alphabet
// (no 0/O, 1/l/I). ~62 bits of entropy. Shown to the admin once.
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
export function tempPassword() {
  const bytes = crypto.randomBytes(12);
  let s = '';
  for (let i = 0; i < 12; i++) {
    s += ALPHABET[bytes[i] % ALPHABET.length];
    if (i === 3 || i === 7) s += '-';
  }
  return s;
}
