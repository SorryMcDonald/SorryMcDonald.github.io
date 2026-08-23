import { describe,expect,it } from 'vitest';
import { createTexasPersistence, deserializeRoom, serializeRoom } from '../src/texas/persistence.js';
import { TexasService } from '../src/texas/service.js';

function fakeDb() {
  const queries=[];
  const db={
    queries,
    async query(text,values=[]) {
      queries.push({ text,values });
      if (/SELECT state FROM texas_rooms/i.test(text)) return { rows:[] };
      if (/RETURNING id/i.test(text) && /INSERT INTO texas_rooms/i.test(text)) return { rows:[{ id:values[0] }] };
      if (/WITH inserted AS/i.test(text) && /texas_wallet_ledger/i.test(text)) return { rows:[{ id:values[1],beans:values[6] }] };
      if (/stats_applied=false RETURNING/i.test(text)) return { rows:[] };
      return { rows:[] };
    }
  };
  return db;
}

describe('Texas PostgreSQL persistence contract',() => {
  it('keeps timers durable while resetting chat to the in-memory lifecycle on restore', () => {
    const users=new Map([['u1',{ id:'u1',nickname:'恢复玩家',beans:100000,wins:0,losses:0 }]]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    room.turnStartedAt='2026-08-19T00:00:00.000Z';
    room.turnDeadlineAt='2026-08-19T00:01:00.000Z';
    service.addMessage(room.id,'u1','临时聊天',{ now:1000 });
    const restored=deserializeRoom(serializeRoom(room));
    expect(restored.turnDeadlineAt).toBe(room.turnDeadlineAt);
    expect(restored.messages).toEqual([]);
    expect(restored.chatLastAt).toBeInstanceOf(Map);
    expect(JSON.stringify(serializeRoom(room))).not.toMatch(/临时聊天/);
  });

  it('infers settled Texas participants from legacy hand results', () => {
    const restored=deserializeRoom({
      id:'legacy-texas', status:'settled', lastWinnerUserId:'legacy-winner',
      hand:{ results:[{ userId:'legacy-winner', net:20 }] },
      players:[['legacy-player',{ id:'legacy-player',userId:'legacy-winner',inHand:false }]],
      spectators:[], events:[]
    });
    expect(restored.players.get('legacy-player')).toMatchObject({ participated:true, roundDecision:null, ready:false });
  });

  it('does not write historical or incremental chat events to texas_actions', async () => {
    const users=new Map([['u1',{ id:'u1',nickname:'聊天过滤',beans:100000,wins:0,losses:0 }]]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    room.events.push(
      { id:900, eventType:'texas_chat_message', payload:{ message:{ text:'历史聊天' } } },
      { id:901, eventType:'chat_message', payload:{ message:{ text:'错误类型聊天' } } },
      { id:902, eventType:'texas_room_settings', payload:{ allowSpectators:true } }
    );
    expect(deserializeRoom({ ...serializeRoom(room), events:room.events }).events.some((event) => event.eventType.includes('chat_message'))).toBe(false);

    const db=fakeDb();
    await createTexasPersistence({ db,service }).flushRoom(room.id,-1,0);
    const actionQueries=db.queries.filter((query) => /INSERT INTO texas_actions/i.test(query.text));
    expect(actionQueries.some((query) => ['chat_message','texas_chat_message'].includes(query.values[3]))).toBe(false);
    expect(actionQueries.some((query) => query.values[3] === 'texas_room_settings')).toBe(true);
  });

  it('writes room, players, wallet ledger and events in one transaction',async() => {
    const users=new Map([['u1',{ id:'u1',nickname:'持久化玩家',beans:100000,wins:0,losses:0 }]]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    const db=fakeDb();
    const persistence=createTexasPersistence({ db,service });
    await persistence.flushRoom(room.id,-1,0);
    const sql=db.queries.map((query) => query.text).join('\n');
    expect(sql).toMatch(/BEGIN/);
    expect(sql).toMatch(/INSERT INTO texas_rooms/);
    expect(sql).toMatch(/INSERT INTO texas_room_players/);
    expect(sql).toMatch(/INSERT INTO texas_wallet_ledger/);
    expect(sql).toMatch(/INSERT INTO texas_actions/);
    expect(sql).toMatch(/COMMIT/);
    expect(room.pendingLedger).toHaveLength(0);
  });

  it('serializes JSONB arrays before passing them to node-postgres',async() => {
    const users=new Map([
      ['u1',{ id:'u1',nickname:'JSON甲',beans:100000,wins:0,losses:0 }],
      ['u2',{ id:'u2',nickname:'JSON乙',beans:100000,wins:0,losses:0 }]
    ]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    service.joinRoom(room.id,'u2',{ buyIn:1000 });
    service.setReady(room.id,'u1',true);
    service.setReady(room.id,'u2',true);
    service.startHand(room.id,'u1');
    const actor=[...room.players.values()].find((player) => player.seat===room.currentTurn);
    service.action(room.id,actor.userId,{ type:'fold',handId:room.hand.id,version:room.version,actionSeq:1,clientActionId:'jsonb-fold-action' });

    const db=fakeDb();
    await createTexasPersistence({ db,service }).flushRoom(room.id,-1,0);
    const handQuery=db.queries.find((query) => /INSERT INTO texas_hands/i.test(query.text));
    const holeCardQueries=db.queries.filter((query) => /INSERT INTO texas_hole_cards/i.test(query.text));
    const potQueries=db.queries.filter((query) => /INSERT INTO texas_pots/i.test(query.text));
    const jsonbValues=[
      handQuery.values[5],
      ...holeCardQueries.map((query) => query.values[2]),
      ...potQueries.flatMap((query) => [query.values[3],query.values[4]])
    ];

    expect(holeCardQueries).toHaveLength(2);
    expect(potQueries).toHaveLength(1);
    for (const value of jsonbValues) {
      expect(typeof value).toBe('string');
      expect(() => JSON.parse(value)).not.toThrow();
      expect(Array.isArray(JSON.parse(value))).toBe(true);
    }
  });

  it('deletes a reclaimed room and its cascading records in one transaction',async() => {
    const users=new Map([['u1',{ id:'u1',nickname:'回收玩家',beans:100000,wins:0,losses:0 }]]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    const db=fakeDb();

    await createTexasPersistence({ db,service }).deleteRoom(room.id);

    expect(db.queries.map((query) => query.text)).toEqual([
      'BEGIN',
      'DELETE FROM texas_rooms WHERE id=$1',
      'COMMIT'
    ]);
    expect(db.queries[1].values).toEqual([room.id]);
  });

  it('rolls back and preserves pending entries when persistence fails',async() => {
    const users=new Map([['u1',{ id:'u1',nickname:'失败玩家',beans:100000,wins:0,losses:0 }]]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    const db={ async query(text) { if (/INSERT INTO texas_rooms/i.test(text)) throw new Error('database unavailable'); return { rows:[] }; } };
    const persistence=createTexasPersistence({ db,service });
    await expect(persistence.flushRoom(room.id,-1,0)).rejects.toThrow(/database unavailable/);
    expect(room.pendingLedger).toHaveLength(1);
  });

  it('persists the settled hand pot instead of the cleared live pot',async() => {
    const users=new Map([
      ['u1',{ id:'u1',nickname:'结算甲',beans:100000,wins:0,losses:0 }],
      ['u2',{ id:'u2',nickname:'结算乙',beans:100000,wins:0,losses:0 }]
    ]);
    const service=new TexasService({ store:{ users,banners:[] } });
    const room=service.createRoom('u1',{ buyIn:1000 });
    service.joinRoom(room.id,'u2',{ buyIn:1000 });
    service.setReady(room.id,'u1',true);
    service.setReady(room.id,'u2',true);
    service.startHand(room.id,'u1');
    const actor=[...room.players.values()].find((player) => player.seat===room.currentTurn);
    service.action(room.id,actor.userId,{ type:'fold',handId:room.hand.id,version:room.version,actionSeq:1,clientActionId:'settle-fold-action' });
    expect(room.pot).toBe(0);
    const expected=room.pots.reduce((sum,pot) => sum+pot.amount,0);
    const db=fakeDb();
    await createTexasPersistence({ db,service }).flushRoom(room.id,-1,0);
    const handInsert=db.queries.find((query) => /INSERT INTO texas_hands/i.test(query.text));
    expect(handInsert.values[6]).toBe(expected);
    expect(service.snapshot(room.id,'u1').pot).toBe(expected);
  });
});
