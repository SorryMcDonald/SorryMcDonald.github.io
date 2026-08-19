import { randomUUID } from 'node:crypto';
import cookie from '@fastify/cookie';
import { hashPassword, verifyPassword } from './password.js';
import { clearSessionCookie, createSessionToken, hashSessionToken, SESSION_COOKIE, sessionRecord, setSessionCookie } from './session.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const STARTING_BEANS = 100_000;

function normalizeEmail(email) { return String(email ?? '').trim().toLowerCase(); }
function normalizeNickname(nickname) { return String(nickname ?? '').trim(); }
function httpError(statusCode, message) { const error = new Error(message); error.statusCode = statusCode; return error; }

function mapUser(row) {
  if (!row) return null;
  return { id: row.id, email: row.email, nickname: row.nickname, beans: Number(row.beans ?? 0), wins: Number(row.wins ?? row.win_count ?? 0), losses: Number(row.losses ?? row.loss_count ?? 0), musicEnabled: row.music_enabled ?? row.musicEnabled ?? true, effectsEnabled: row.effects_enabled ?? row.effectsEnabled ?? true, motionMode: row.animation_mode ?? row.motion_mode ?? row.motionMode ?? 'light' };
}

async function dbQuery(db, text, values = []) { return db.query(text, values); }

export function registerAuthRoutes(app, options = {}) {
  const db = options.db;
  const store = options.store ?? { users: new Map(), sessions: new Map() };
  app.register(cookie);

  async function findByEmail(email) {
    if (db?.query) {
      const result = await dbQuery(db, 'SELECT * FROM users WHERE lower(email) = lower($1) LIMIT 1', [email]);
      return result.rows[0] ?? null;
    }
    return [...store.users.values()].find((user) => user.email === email) ?? null;
  }
  async function findByNickname(nickname) {
    if (db?.query) {
      const result = await dbQuery(db, 'SELECT * FROM users WHERE nickname = $1 LIMIT 1', [nickname]);
      return result.rows[0] ?? null;
    }
    return [...store.users.values()].find((user) => user.nickname === nickname) ?? null;
  }
  async function createUser(input) {
    if (db?.query) {
      const result = await dbQuery(db, `INSERT INTO users (email, password_hash, nickname, beans)
        VALUES ($1, $2, $3, $4) RETURNING *`, [input.email, input.passwordHash, input.nickname, STARTING_BEANS]);
      return result.rows[0];
    }
    const user = { id: randomUUID(), email: input.email, password_hash: input.passwordHash, nickname: input.nickname, beans: STARTING_BEANS, wins: 0, losses: 0, music_enabled: true, motion_mode: 'light' };
    store.users.set(user.id, user);
    return user;
  }
  async function saveSession(userId, token) {
    const record = sessionRecord(userId, token);
    if (db?.query) {
      await dbQuery(db, 'INSERT INTO sessions (id, user_id, token_hash, expires_at) VALUES ($1, $2, decode($3, \'hex\'), $4)', [record.id, userId, record.tokenHash, record.expiresAt]);
    } else store.sessions.set(record.tokenHash, record);
    return record;
  }
  async function findSession(token) {
    if (!token) return null;
    const tokenHash = hashSessionToken(token);
    if (db?.query) {
      const result = await dbQuery(db, `SELECT s.*, u.* FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.token_hash = decode($1, 'hex') AND s.expires_at > now() AND s.revoked_at IS NULL LIMIT 1`, [tokenHash]);
      return result.rows[0] ?? null;
    }
    const session = store.sessions.get(tokenHash);
    if (!session || session.expiresAt <= new Date()) return null;
    return store.users.get(session.userId);
  }
  async function deleteSession(token) {
    if (!token) return;
    if (db?.query) await dbQuery(db, "DELETE FROM sessions WHERE token_hash = decode($1, 'hex')", [hashSessionToken(token)]);
    else store.sessions.delete(hashSessionToken(token));
  }

  app.decorate('auth', { store, findSession });
  app.decorateRequest('user', null);
  app.addHook('preHandler', async (request) => {
    request.user = await findSession(request.cookies?.[SESSION_COOKIE]);
    if (request.user?.id && !store.users.has(request.user.id)) store.users.set(request.user.id, request.user);
  });
  app.decorate('requireUser', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '需要登录' });
    return request.user;
  });

  app.post('/api/auth/register', async (request, reply) => {
    const body = request.body ?? {};
    const email = normalizeEmail(body.email);
    const nickname = normalizeNickname(body.nickname);
    if (!EMAIL_RE.test(email)) throw httpError(400, '邮箱格式不正确');
    if (nickname.length < 1 || nickname.length > 24) throw httpError(400, '昵称长度需为 1-24 个字符');
    if (typeof body.password !== 'string' || body.password.length < 8) throw httpError(400, '密码至少需要 8 位');
    if (await findByEmail(email)) throw httpError(409, '邮箱已注册');
    if (await findByNickname(nickname)) throw httpError(409, '昵称已存在');
    let user;
    try { user = await createUser({ email, nickname, passwordHash: await hashPassword(body.password) }); }
    catch (error) { if (error.code === '23505') throw httpError(409, '邮箱或昵称已存在'); throw error; }
    const token = createSessionToken();
    await saveSession(user.id, token);
    setSessionCookie(reply, token, options.secureCookies);
    return reply.code(201).send({ user: mapUser(user) });
  });

  app.post('/api/auth/login', async (request, reply) => {
    const email = normalizeEmail(request.body?.email);
    const user = await findByEmail(email);
    if (!user || !(await verifyPassword(user.password_hash ?? user.passwordHash, request.body?.password))) throw httpError(401, '邮箱或密码错误');
    const token = createSessionToken();
    await saveSession(user.id, token);
    setSessionCookie(reply, token, options.secureCookies);
    return { user: mapUser(user) };
  });

  app.post('/api/auth/logout', async (request, reply) => { await deleteSession(request.cookies?.[SESSION_COOKIE]); clearSessionCookie(reply, options.secureCookies); return { ok: true }; });
  app.get('/api/auth/me', async (request, reply) => { if (!request.user) return reply.code(401).send({ error: '需要登录' }); return { user: mapUser(request.user) }; });
  app.patch('/api/me/settings', async (request, reply) => {
    if (!request.user) return reply.code(401).send({ error: '需要登录' });
    const musicEnabled = request.body?.musicEnabled;
    const effectsEnabled = request.body?.effectsEnabled;
    const motionMode = request.body?.motionMode;
    if (musicEnabled !== undefined && typeof musicEnabled !== 'boolean') throw httpError(400, 'musicEnabled 必须是布尔值');
    if (effectsEnabled !== undefined && typeof effectsEnabled !== 'boolean') throw httpError(400, 'effectsEnabled 必须是布尔值');
    if (motionMode !== undefined && !['light', 'cinematic'].includes(motionMode)) throw httpError(400, 'motionMode 不支持');
    if (db?.query) {
      const result = await dbQuery(db, `UPDATE users SET music_enabled = COALESCE($2, music_enabled), effects_enabled = COALESCE($3, effects_enabled), animation_mode = COALESCE($4, animation_mode)
        WHERE id = $1 RETURNING *`, [request.user.id, musicEnabled ?? null, effectsEnabled ?? null, motionMode ?? null]);
      if (result.rows[0]) store.users.set(result.rows[0].id, result.rows[0]);
      return { user: mapUser(result.rows[0]) };
    }
    const user = store.users.get(request.user.id); if (musicEnabled !== undefined) user.music_enabled = musicEnabled; if (effectsEnabled !== undefined) user.effects_enabled = effectsEnabled; if (motionMode !== undefined) user.animation_mode = motionMode;
    return { user: mapUser(user) };
  });
}

export { STARTING_BEANS, normalizeEmail };
