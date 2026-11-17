import { badRequest } from './errors.js';

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Canonical form of a scanned QR payload.
 *  - Arthrex labels encode a UUID or another random string; it is stored as-is
 *    (trimmed). Matching is case-insensitive at the database level.
 *  - If a label encodes a URL that contains a UUID, the UUID is the identifier.
 *  - Bare UUIDs are lower-cased so the same code always looks the same.
 */
export function canonicalQr(raw) {
  if (typeof raw !== 'string') throw badRequest('Scan a QR code or enter its value.');
  // Strip control characters some scanners append (CR/LF, tabs).
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!s) throw badRequest('The QR code was empty.');
  if (s.length > 512) throw badRequest('That code is too long to be an asset QR code.');
  const uuid = s.match(UUID_RE);
  if (uuid && uuid[0].length === s.length) return s.toLowerCase();
  if (uuid && /^https?:\/\//i.test(s)) return uuid[0].toLowerCase();
  return s;
}
