import { isTransientChatEvent } from '../persistence/runtime-state.js';

function serializeRoom(room) {
  const { messages, chatLastAt, chatSeq, ...durable } = room;
  return {
    ...durable,
    // Chat is an in-memory lifecycle concern. Filter its event-log entries too
    // so a room snapshot cannot persist message text indirectly.
    events:Array.isArray(room.events)
      ? room.events.filter((event) => !isTransientChatEvent(event))
      : [],
    players:[...room.players.entries()],
    spectators:[...room.spectators],
    pendingLedger:[],
    pendingStats:[],
    pendingClientActions:[]
  };
}

function deserializeRoom(state) {
  if (!state?.id) return null;
  return {
    ...state,
    players:new Map(Array.isArray(state.players) ? state.players : []),
    spectators:new Set(Array.isArray(state.spectators) ? state.spectators : []),
    events:Array.isArray(state.events) ? state.events.filter((event) => !isTransientChatEvent(event)) : [],
    processedActions:Array.isArray(state.processedActions) ? state.processedActions : [],
    pendingLedger:[],
    pendingStats:[],
    pendingClientActions:[],
    messages:[],
    chatLastAt:new Map(),
    chatSeq:0
  };
}

async function transaction(db, callback) {
  const client = typeof db.connect === 'function' ? await db.connect() : db;
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    client.release?.();
  }
}

async function persistWalletEntry(client, entry) {
  const result = await client.query(`WITH inserted AS (
    INSERT INTO texas_wallet_ledger
      (idempotency_key,user_id,room_id,hand_id,entry_type,amount,balance_after,metadata)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
    ON CONFLICT (idempotency_key) DO NOTHING
    RETURNING user_id,amount
  )
  UPDATE users SET beans=users.beans+inserted.amount
  FROM inserted WHERE users.id=inserted.user_id
  RETURNING users.id,users.beans`, [
    entry.idempotencyKey, entry.userId, entry.roomId, entry.handId, entry.entryType,
    entry.amount, entry.balanceAfter, entry.metadata ?? {}
  ]);
  return result.rows[0] ?? null;
}

async function persistRoomRow(client, room, previousVersion) {
  const result = await client.query(`INSERT INTO texas_rooms
    (id,code,status,host_user_id,small_blind,big_blind,min_buy_in,max_buy_in,max_players,
     dealer_seat,current_turn,hand_number,pot,version,is_public,allow_spectators,spectator_cards,state)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
    ON CONFLICT (id) DO UPDATE SET
      code=excluded.code,status=excluded.status,host_user_id=excluded.host_user_id,
      dealer_seat=excluded.dealer_seat,current_turn=excluded.current_turn,
      hand_number=excluded.hand_number,pot=excluded.pot,version=excluded.version,
      is_public=excluded.is_public,allow_spectators=excluded.allow_spectators,
      spectator_cards=excluded.spectator_cards,state=excluded.state
    WHERE texas_rooms.version=$19
    RETURNING id`, [
    room.id,room.code,room.status,room.hostUserId,room.smallBlind,room.bigBlind,room.minBuyIn,room.maxBuyIn,
    room.maxPlayers,room.dealerSeat,room.currentTurn,room.handNumber,room.pot,room.version,room.isPublic,
    room.allowSpectators,room.spectatorCards,serializeRoom(room),previousVersion
  ]);
  if (!result.rows.length) throw Object.assign(new Error('德州房间版本冲突'), { statusCode:409, code:'TEXAS_VERSION_CONFLICT' });
}

async function persistPlayerRows(client, room) {
  for (const player of room.players.values()) {
    await client.query(`INSERT INTO texas_room_players
      (id,room_id,user_id,seat,stack,waiting,pending_leave,left_room)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT (id) DO UPDATE SET stack=excluded.stack,waiting=excluded.waiting,
        pending_leave=excluded.pending_leave,left_room=excluded.left_room`, [
      player.id,room.id,player.userId,player.seat,player.stack,player.waiting,player.pendingLeave,player.left
    ]);
  }
}

async function persistHand(client, room) {
  if (!room.hand) return;
  const handStatus=['preflop','flop','turn','river','showdown','settled'].includes(room.status)
    ? room.status : room.hand.settledAt ? 'settled' : 'preflop';
  const handPot=room.hand.settledAt
    ? (room.pots ?? []).reduce((sum,pot) => sum+Number(pot.amount ?? 0),0)
    : room.pot;
  await client.query(`INSERT INTO texas_hands
    (id,room_id,hand_number,status,dealer_seat,board,pot,started_at,settled_at)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
    ON CONFLICT (id) DO UPDATE SET status=excluded.status,board=excluded.board,
      pot=excluded.pot,settled_at=excluded.settled_at`, [
    room.hand.id,room.id,room.handNumber,handStatus,room.dealerSeat,JSON.stringify(room.board),handPot,
    room.hand.startedAt,room.hand.settledAt ?? null
  ]);
  for (const player of room.players.values()) {
    if (!player.inHand && !room.hand.results?.some((result) => result.userId === player.userId)) continue;
    const result = room.hand.results?.find((value) => value.userId === player.userId);
    await client.query(`INSERT INTO texas_hand_players
      (hand_id,room_player_id,user_id,seat,folded,all_in,total_contribution,payout,net_change,hand_type)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
      ON CONFLICT (hand_id,user_id) DO UPDATE SET folded=excluded.folded,all_in=excluded.all_in,
        total_contribution=excluded.total_contribution,payout=excluded.payout,
        net_change=excluded.net_change,hand_type=excluded.hand_type`, [
      room.hand.id,player.id,player.userId,player.seat,player.folded,player.allIn,player.totalContribution,
      result?.payout ?? 0,result?.net ?? 0,result?.handType ?? null
    ]);
    if (result) {
      const stats=await client.query(`UPDATE texas_hand_players SET stats_applied=true
        WHERE hand_id=$1 AND user_id=$2 AND stats_applied=false RETURNING user_id`, [room.hand.id,player.userId]);
      if (!room.tournament && stats.rows.length && result.net !== 0) await client.query(`UPDATE users SET
        wins=wins+$2,losses=losses+$3 WHERE id=$1`, [player.userId,result.net>0?1:0,result.net<0?1:0]);
    }
    if (player.holeCards?.length === 2) await client.query(`INSERT INTO texas_hole_cards (hand_id,user_id,cards)
      VALUES ($1,$2,$3) ON CONFLICT (hand_id,user_id) DO UPDATE SET cards=excluded.cards`, [room.hand.id,player.userId,JSON.stringify(player.holeCards)]);
  }
  for (let index=0; index < (room.pots?.length ?? 0); index += 1) {
    const pot=room.pots[index];
    const userIds=(ids) => ids.map((id) => room.players.get(id)?.userId).filter(Boolean);
    await client.query(`INSERT INTO texas_pots
      (hand_id,pot_index,amount,eligible_user_ids,winner_user_ids)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (hand_id,pot_index) DO UPDATE SET amount=excluded.amount,
        eligible_user_ids=excluded.eligible_user_ids,winner_user_ids=excluded.winner_user_ids`, [
      room.hand.id,index,pot.amount,JSON.stringify(userIds(pot.eligiblePlayerIds)),JSON.stringify(userIds(pot.winnerIds))
    ]);
  }
}

export function createTexasPersistence({ db, service }) {
  return {
    async hydrateRooms() {
      const result=await db.query(`SELECT state FROM texas_rooms WHERE status <> 'closed' AND state <> '{}'::jsonb ORDER BY updated_at`);
      for (const row of result.rows) { const room=deserializeRoom(row.state); if (room) service.rooms.set(room.id,room); }
    },
    async flushRoom(roomId, previousVersion = -1, eventStart = 0) {
      const room=service.room(roomId);
      const ledger=[...room.pendingLedger];
      const clientActions=[...(room.pendingClientActions ?? [])];
      const events=room.events.filter((event) => event.id > eventStart && !isTransientChatEvent(event));
      await transaction(db, async (client) => {
        await persistRoomRow(client,room,previousVersion);
        await persistPlayerRows(client,room);
        await persistHand(client,room);
        for (const entry of ledger) {
          const updated=await persistWalletEntry(client,entry);
          if (updated && service.store.users.has(updated.id)) service.store.users.get(updated.id).beans=Number(updated.beans);
        }
        for (const action of clientActions) await client.query(`INSERT INTO texas_client_actions
          (client_action_id,room_id,hand_id,user_id,room_version)
          VALUES ($1,$2,$3,$4,$5) ON CONFLICT (client_action_id) DO NOTHING`, [
          action.clientActionId,action.roomId,action.handId,action.userId,action.roomVersion
        ]);
        for (const event of events) await client.query(`INSERT INTO texas_actions
          (room_id,hand_id,event_seq,event_type,user_id,payload,created_at)
          VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (room_id,event_seq) DO NOTHING`, [
          room.id,event.handId,event.id,event.eventType,event.payload?.userId ?? null,event.payload,event.createdAt
        ]);
      });
      room.pendingLedger.splice(0,ledger.length);
      room.pendingClientActions?.splice(0,clientActions.length);
      return room;
    },
    async deleteRoom(roomId) {
      await transaction(db, async (client) => {
        await client.query('DELETE FROM texas_rooms WHERE id=$1', [roomId]);
      });
    }
  };
}

export { deserializeRoom, serializeRoom };
