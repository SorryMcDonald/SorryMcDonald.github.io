function number(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function mapBanner(row) {
  return {
    id: number(row.id),
    queueName: row.queue_name,
    bannerType: row.banner_type,
    message: row.message,
    payload: row.payload ?? {},
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at
  };
}

export function isTransientChatEvent(event) {
  return event?.eventType === 'chat_message' || event?.eventType === 'texas_chat_message';
}

function durableEvents(events) {
  return (events ?? []).filter((event) => !isTransientChatEvent(event));
}

export async function hydrateStore(db) {
  const usersResult = await db.query(`SELECT id, email, password_hash, nickname, beans, wins, losses,
    music_enabled, effects_enabled, animation_mode, refill_generation,
    last_zero_generation, created_at, updated_at FROM users`);
  const bannersResult = await db.query(`SELECT id, queue_name, banner_type, message, payload, created_at
    FROM global_banners ORDER BY id DESC LIMIT 100`);
  return {
    users: new Map(usersResult.rows.map((user) => [user.id, user])),
    sessions: new Map(),
    banners: bannersResult.rows.reverse().map(mapBanner)
  };
}

export function serializeRoom(room) {
  const { messages, chatLastAt, ...durable } = room;
  return {
    ...durable,
    players: [...room.players.entries()],
    spectators: [...room.spectators],
    events: durableEvents(room.events)
  };
}

export function deserializeRoom(state) {
  if (!state || typeof state !== 'object' || !state.id) return null;
  return {
    ...state,
    players: new Map(Array.isArray(state.players) ? state.players : []),
    spectators: new Set(Array.isArray(state.spectators) ? state.spectators : []),
    events: durableEvents(Array.isArray(state.events) ? state.events : []),
    messages: [],
    chatLastAt: new Map()
  };
}

async function withTransaction(db, callback) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release?.();
  }
}

async function persistUsers(client, users) {
  for (const user of users.values()) {
    await client.query(`UPDATE users SET beans = $2, wins = $3, losses = $4,
      refill_generation = $5, last_zero_generation = $6 WHERE id = $1`, [
      user.id,
      number(user.beans),
      number(user.wins),
      number(user.losses),
      number(user.refill_generation),
      user.last_zero_generation ?? null
    ]);
  }
}

async function persistBanners(client, banners) {
  for (const banner of banners) {
    await client.query(`INSERT INTO global_banners
      (queue_name, banner_type, message, payload, created_at)
      VALUES ($1, $2, $3, $4, COALESCE($5, now()))`, [
      banner.queueName,
      banner.bannerType ?? (banner.queueName === 'economy' ? 'zero_balance' : 'leaderboard_first'),
      banner.message,
      banner.payload ?? {},
      banner.createdAt ?? null
    ]);
  }
}

async function persistRoom(client, room) {
  await client.query(`INSERT INTO rooms
    (id, code, status, host_user_id, dealer_user_id, dealer_seat, current_turn,
     ante, level, pot, round_number, is_public, allow_spectators, state)
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, TRUE, $12, $13)
    ON CONFLICT (id) DO UPDATE SET
      code = EXCLUDED.code, status = EXCLUDED.status, host_user_id = EXCLUDED.host_user_id,
      dealer_user_id = EXCLUDED.dealer_user_id, dealer_seat = EXCLUDED.dealer_seat,
      current_turn = EXCLUDED.current_turn, ante = EXCLUDED.ante, level = EXCLUDED.level,
      pot = EXCLUDED.pot, round_number = EXCLUDED.round_number,
      allow_spectators = EXCLUDED.allow_spectators, state = EXCLUDED.state`, [
    room.id,
    room.code,
    room.status,
    room.hostUserId,
    room.dealerUserId,
    room.dealerSeat,
    room.currentTurn,
    room.ante,
    room.level,
    room.pot,
    room.roundNumber,
    room.allowSpectators,
    serializeRoom(room)
  ]);
}

export function createPersistence({ db, store, roomService }) {
  return {
    async hydrateRooms() {
      const result = await db.query(`SELECT state FROM rooms
        WHERE status <> 'finished' AND state <> '{}'::jsonb ORDER BY updated_at`);
      for (const row of result.rows) {
        const room = deserializeRoom(row.state);
        if (room) roomService.rooms.set(room.id, room);
      }
    },

    async flushStore(bannerStart = store.banners.length, banners = store.banners.slice(bannerStart)) {
      await withTransaction(db, async (client) => {
        await persistUsers(client, store.users);
        await persistBanners(client, banners);
      });
    },

    async flushRoom(roomId, bannerStart = store.banners.length, banners = store.banners.slice(bannerStart)) {
      const room = roomService.room(roomId);
      await withTransaction(db, async (client) => {
        await persistUsers(client, store.users);
        await persistRoom(client, room);
        await persistBanners(client, banners);
      });
    },

    async deleteRoom(roomId, bannerStart = store.banners.length, banners = store.banners.slice(bannerStart)) {
      await withTransaction(db, async (client) => {
        await persistUsers(client, store.users);
        await persistBanners(client, banners);
        await client.query('DELETE FROM rooms WHERE id = $1', [roomId]);
      });
    }
  };
}
