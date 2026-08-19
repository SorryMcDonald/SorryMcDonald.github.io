import { createHash, randomBytes, randomUUID } from 'node:crypto';

export const SESSION_COOKIE = 'zhajinhua_session';
export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function hashSessionToken(token) {
  return createHash('sha256').update(token).digest('hex');
}

export function createSessionToken() {
  return randomBytes(32).toString('base64url');
}

export function sessionRecord(userId, token = createSessionToken(), now = new Date()) {
  return {
    id: randomUUID(), userId, token, tokenHash: hashSessionToken(token),
    expiresAt: new Date(now.getTime() + SESSION_TTL_MS)
  };
}

export function setSessionCookie(reply, token, secure = process.env.NODE_ENV === 'production') {
  reply.setCookie(SESSION_COOKIE, token, {
    httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: Math.floor(SESSION_TTL_MS / 1000)
  });
}

export function clearSessionCookie(reply, secure = process.env.NODE_ENV === 'production') {
  reply.clearCookie(SESSION_COOKIE, { httpOnly: true, secure, sameSite: 'lax', path: '/' });
}
