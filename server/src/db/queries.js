import { pool as defaultPool } from './pool.js';

function isDb(value) {
  return value && typeof value.query === 'function';
}

function resolveDb(first, second) {
  if (isDb(first)) return { db: first, value: second };
  if (isDb(second)) return { db: second, value: first };
  return { db: defaultPool, value: first };
}

function requireDb(db) {
  if (!isDb(db)) throw new Error('DATABASE_URL is not configured');
  return db;
}

export function createRepository(db = defaultPool) {
  requireDb(db);
  return {
    getUserById: (userId) => getUserById(db, userId),
    getUserByEmail: (email) => getUserByEmail(db, email),
    createUser: (input) => createUser(db, input),
    getRoomForUpdate: (roomId) => getRoomForUpdate(db, roomId),
    getRoomPlayers: (roomId) => getRoomPlayers(db, roomId),
    appendLedgerEntry: (input) => appendLedgerEntry(db, input),
    updateUserBalance: (userId, amount) => updateUserBalance(db, userId, amount),
    appendGameEvent: (input) => appendGameEvent(db, input),
    getLeaderboard: (kind, limit) => getLeaderboard(db, kind, limit)
  };
}

export async function getUserById(first, second) {
  const { db, value: userId } = resolveDb(first, second);
  requireDb(db);
  const result = await db.query(
    `SELECT id, email, password_hash, nickname, beans, wins, losses,
            music_enabled, effects_enabled, animation_mode,
            refill_generation, last_zero_generation, created_at, updated_at
       FROM users WHERE id = $1`,
    [userId]
  );
  return result.rows[0] ?? null;
}

export async function getUserByEmail(first, second) {
  const { db, value: email } = resolveDb(first, second);
  requireDb(db);
  const result = await db.query(
    `SELECT id, email, password_hash, nickname, beans, wins, losses,
            music_enabled, effects_enabled, animation_mode,
            refill_generation, last_zero_generation, created_at, updated_at
       FROM users WHERE lower(email) = lower($1)`,
    [email]
  );
  return result.rows[0] ?? null;
}

export async function createUser(first, second) {
  const { db, value: input } = resolveDb(first, second);
  requireDb(db);
  if (!input || typeof input !== 'object') throw new TypeError('user input is required');
  const {
    email = null,
    passwordHash = null,
    nickname,
    beans = 100000,
    musicEnabled = true,
    effectsEnabled = true,
    animationMode = 'light'
  } = input;
  const result = await db.query(
    `INSERT INTO users
       (email, password_hash, nickname, beans, music_enabled, effects_enabled, animation_mode)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, email, password_hash, nickname, beans, wins, losses,
               music_enabled, effects_enabled, animation_mode,
               refill_generation, last_zero_generation, created_at, updated_at`,
    [email, passwordHash, nickname, beans, musicEnabled, effectsEnabled, animationMode]
  );
  return result.rows[0];
}

export async function getRoomForUpdate(first, second) {
  const { db, value: roomId } = resolveDb(first, second);
  requireDb(db);
  const result = await db.query(
    `SELECT id, code, status, host_user_id, dealer_user_id, dealer_seat,
            current_turn, ante, level, pot, round_number, is_public,
            allow_spectators, version, created_at, updated_at
       FROM rooms WHERE id = $1 FOR UPDATE`,
    [roomId]
  );
  return result.rows[0] ?? null;
}

export async function getRoomPlayers(first, second) {
  const { db, value: roomId } = resolveDb(first, second);
  requireDb(db);
  const result = await db.query(
    `SELECT rp.id, rp.room_id, rp.user_id, rp.seat, rp.nickname,
            rp.in_round, rp.folded, rp.all_in, rp.seen, rp.current_bet,
            rp.total_contribution, rp.action_seq, rp.last_action,
            rp.compare_with, rp.left_room, rp.is_host, rp.joined_at, rp.updated_at
       FROM room_players rp
      WHERE rp.room_id = $1
      ORDER BY rp.seat`,
    [roomId]
  );
  return result.rows;
}

export async function appendLedgerEntry(first, second) {
  const { db, value: input } = resolveDb(first, second);
  requireDb(db);
  if (!input || typeof input !== 'object') throw new TypeError('ledger input is required');
  const {
    userId, roundId = null, entryType, amount, idempotencyKey,
    balanceAfter = null, metadata = {}
  } = input;
  const result = await db.query(
    `INSERT INTO account_ledger
       (user_id, round_id, entry_type, amount, idempotency_key, balance_after, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (idempotency_key) DO NOTHING
     RETURNING id, user_id, round_id, entry_type, amount, idempotency_key,
               balance_after, metadata, created_at`,
    [userId, roundId, entryType, amount, idempotencyKey, balanceAfter, metadata]
  );
  if (result.rows[0]) return result.rows[0];
  const existing = await db.query(
    `SELECT id, user_id, round_id, entry_type, amount, idempotency_key,
            balance_after, metadata, created_at
       FROM account_ledger WHERE idempotency_key = $1`,
    [idempotencyKey]
  );
  return existing.rows[0] ?? null;
}

export async function updateUserBalance(first, second, third) {
  let db;
  let userId;
  let amount;
  if (isDb(first)) {
    db = first;
    userId = second;
    amount = third;
  } else if (isDb(third)) {
    userId = first;
    amount = second;
    db = third;
  } else {
    db = defaultPool;
    userId = first;
    amount = second;
  }
  requireDb(db);
  const result = await db.query(
    `UPDATE users
        SET beans = beans + $2
      WHERE id = $1 AND beans + $2 >= 0
     RETURNING id, beans, wins, losses, updated_at`,
    [userId, amount]
  );
  return result.rows[0] ?? null;
}

export async function appendGameEvent(first, second) {
  const { db, value: input } = resolveDb(first, second);
  requireDb(db);
  if (!input || typeof input !== 'object') throw new TypeError('event input is required');
  const { roomId = null, roundId = null, eventType, payload = {}, audience = 'room' } = input;
  const result = await db.query(
    `INSERT INTO game_events (room_id, round_id, event_type, payload, audience)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id, room_id, round_id, event_type, payload, audience, created_at`,
    [roomId, roundId, eventType, payload, audience]
  );
  return result.rows[0];
}

export async function getLeaderboard(first, second, third) {
  let db;
  let kind;
  let limit;
  if (isDb(first)) {
    db = first;
    kind = second;
    limit = third;
  } else if (isDb(third)) {
    kind = first;
    limit = second;
    db = third;
  } else {
    db = defaultPool;
    kind = first;
    limit = second;
  }
  requireDb(db);
  const sortColumn = kind === 'wins' ? 'wins' : kind === 'losses' ? 'losses' : null;
  if (!sortColumn) throw new RangeError('leaderboard kind must be wins or losses');
  const parsedLimit = Number(limit ?? 100);
  const safeLimit = Number.isSafeInteger(parsedLimit)
    ? Math.min(Math.max(parsedLimit, 1), 1000)
    : 100;
  const result = await db.query(
    `SELECT id, nickname, beans, wins, losses,
            row_number() OVER (ORDER BY ${sortColumn} DESC, lower(nickname), id) AS rank
       FROM users
      WHERE ${sortColumn} > 0
      ORDER BY ${sortColumn} DESC, lower(nickname), id
      LIMIT $1`,
    [safeLimit]
  );
  return result.rows;
}
