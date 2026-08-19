import { describe,expect,it } from 'vitest';
import { createTexasPersistence } from '../src/texas/persistence.js';
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
