import { createHmac, timingSafeEqual } from 'node:crypto';

function encode(value) { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function decode(value) { return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')); }

export function issueLegacyClaim({ legacyUserId, email, secret, now = Date.now(), ttlMs = 10 * 60 * 1000 } = {}) {
  if (!legacyUserId || !email || !secret) throw new Error('legacy claim fields are required');
  const payload = encode({ sub: String(legacyUserId), email: String(email).toLowerCase(), exp: now + ttlMs }); const signature = createHmac('sha256', secret).update(payload).digest('base64url'); return `${payload}.${signature}`;
}

export function verifyLegacyClaim(token, { legacyUserId, email, secret, now = Date.now() } = {}) {
  try {
    const [payload, signature] = String(token).split('.'); const expected = createHmac('sha256', secret).update(payload).digest(); const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const value = decode(payload); return value.sub === String(legacyUserId) && value.email === String(email).toLowerCase() && value.exp > now ? value : false;
  } catch { return false; }
}

export function mergeLegacyBalance(targetUser, legacyRecord) {
  if (!targetUser || !legacyRecord) throw new Error('users are required');
  if (legacyRecord.migrationApplied) return targetUser;
  targetUser.beans = Number(targetUser.beans ?? 0) + Math.max(0, Number(legacyRecord.maxBalance ?? 0)); targetUser.migrationApplied = true; return targetUser;
}
