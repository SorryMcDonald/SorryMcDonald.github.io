function serializeRoom(room) {
  return { ...room, spectators: [...room.spectators], pendingLedger: [], players: room.players.map((player) => ({ ...player })) };
}
function deserializeRoom(state) {
  if (!state?.id) return null;
  return { ...state, spectators: new Set(Array.isArray(state.spectators) ? state.spectators : []), players: Array.isArray(state.players) ? state.players : [], events: Array.isArray(state.events) ? state.events : [] };
}
async function transaction(db, callback) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try { await client.query('BEGIN'); const value = await callback(client); await client.query('COMMIT'); return value; }
  catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; }
  finally { client.release?.(); }
}

export function createDoudizhuPersistence({ db, service }) {
  return {
    async hydrateRooms() {
      const result = await db.query(`SELECT state FROM doudizhu_rooms WHERE status <> 'closed' AND state <> '{}'::jsonb ORDER BY updated_at`);
      for (const row of result.rows) { const room = deserializeRoom(row.state); if (room) service.rooms.set(room.id, room); }
    },
    async flushRoom(roomId) {
      const room = service.room(roomId);
      await transaction(db, async (client) => {
        for (const user of service.store.users.values()) {
          await client.query(`UPDATE users SET beans=$2, wins=$3, losses=$4, refill_count=$5 WHERE id=$1`, [user.id, Number(user.beans ?? 0), Number(user.wins ?? 0), Number(user.losses ?? 0), Number(user.refill_count ?? 0)]);
        }
        await client.query(`INSERT INTO doudizhu_rooms (id,code,status,host_user_id,max_players,base_score,version,state)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
          ON CONFLICT (id) DO UPDATE SET code=excluded.code,status=excluded.status,host_user_id=excluded.host_user_id,
            max_players=excluded.max_players,base_score=excluded.base_score,version=excluded.version,state=excluded.state`,
        [room.id, room.code, room.status, room.hostUserId, room.maxPlayers, room.baseScore, room.version, serializeRoom(room)]);
      });
      return room;
    },
    async deleteRoom(roomId) { await db.query('DELETE FROM doudizhu_rooms WHERE id=$1', [roomId]); }
  };
}

export { deserializeRoom, serializeRoom };
