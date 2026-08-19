import { describe, expect, it } from 'vitest';
import { TexasService } from '../src/texas/service.js';

function setup(count = 2) {
  const users = new Map();
  for (let index = 0; index < count; index += 1) users.set(`u${index}`, { id:`u${index}`, nickname:`玩家${index}`, beans:100000, wins:0, losses:0 });
  const service = new TexasService({ store:{ users, banners:[] } });
  const room = service.createRoom('u0', { smallBlind:10, bigBlind:20, minBuyIn:400, maxBuyIn:2000, buyIn:1000 });
  for (let index = 1; index < count; index += 1) service.joinRoom(room.id, `u${index}`, { buyIn:1000, seat:index });
  return { service, users, room };
}

function act(service, room, userId, type, amount) {
  const player = [...room.players.values()].find((value) => value.userId === userId);
  return service.action(room.id, userId, { type, amount, handId:room.hand.id, version:room.version, actionSeq:player.actionSeq+1, clientActionId:`action-${userId}-${player.actionSeq+1}-${room.version}` });
}

describe('Texas room state machine', () => {
  it('uses heads-up order and advances through all four betting streets', () => {
    const { service, room } = setup(2);
    service.startHand(room.id, 'u0');
    expect(room.status).toBe('preflop');
    const dealer = [...room.players.values()].find((player) => player.seat === room.dealerSeat);
    expect(room.currentTurn).toBe(dealer.seat);
    act(service, room, dealer.userId, 'call');
    const bigBlind = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    act(service, room, bigBlind.userId, 'check');
    expect(room.status).toBe('flop');
    for (const street of ['flop','turn','river']) {
      const first = [...room.players.values()].find((player) => player.seat === room.currentTurn);
      act(service, room, first.userId, 'check');
      const second = [...room.players.values()].find((player) => player.seat === room.currentTurn);
      act(service, room, second.userId, 'check');
      if (street !== 'river') expect(room.status).not.toBe(street);
    }
    expect(room.status).toBe('settled');
    expect(room.board).toHaveLength(5);
    expect(room.pots.reduce((sum, pot) => sum+pot.amount, 0)).toBe(40);
  });

  it('runs out the board after all players are all-in and waits for manual next hand', () => {
    const { service, room } = setup(3);
    service.startHand(room.id, 'u0');
    while (room.status !== 'settled') {
      const player = [...room.players.values()].find((value) => value.seat === room.currentTurn);
      act(service, room, player.userId, 'all_in');
    }
    expect(room.board).toHaveLength(5);
    expect(room.currentTurn).toBe(-1);
    const previousHand = room.hand.id;
    for (const player of [...room.players.values()]) {
      if (player.stack < room.minBuyIn) service.rebuy(room.id, player.userId, room.minBuyIn-player.stack);
    }
    service.startHand(room.id, 'u0');
    expect(room.hand.id).not.toBe(previousHand);
  });

  it('keeps a leaving player contribution and returns the remaining stack after settlement', () => {
    const { service, users, room } = setup(2);
    service.startHand(room.id, 'u0');
    const leaving = [...room.players.values()].find((player) => player.userId === 'u0');
    const contribution = leaving.totalContribution;
    service.leaveRoom(room.id, 'u0');
    expect(room.status).toBe('settled');
    expect(leaving.left).toBe(true);
    expect(leaving.totalContribution).toBe(contribution);
    expect(users.get('u0').beans).toBe(99000 + (1000-contribution));
  });

  it('deduplicates client action ids and rejects stale versions', () => {
    const { service, room } = setup(2);
    service.startHand(room.id, 'u0');
    const player = [...room.players.values()].find((value) => value.seat === room.currentTurn);
    const payload = { type:'call', handId:room.hand.id, version:room.version, actionSeq:1, clientActionId:'fixed-action-id' };
    service.action(room.id, player.userId, payload);
    const version = room.version;
    service.action(room.id, player.userId, payload);
    expect(room.version).toBe(version);
    const next = [...room.players.values()].find((value) => value.seat === room.currentTurn);
    expect(() => service.action(room.id, next.userId, { type:'check', handId:room.hand.id, version:0, actionSeq:1, clientActionId:'stale-action-id' })).toThrow(/状态已更新/);
  });

  it('keeps a full big-blind bring-in when the blind is short all-in', () => {
    const { service, room } = setup(3);
    const shortBlind = [...room.players.values()].find((player) => player.seat === 2);
    shortBlind.stack = 5;
    service.startHand(room.id, 'u0');
    expect(shortBlind.allIn).toBe(true);
    expect(shortBlind.streetBet).toBe(5);
    expect(room.currentBet).toBe(20);
    const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    expect(service.snapshot(room.id, actor.userId).allowedActions.toCall).toBe(20);
  });

  it('requires room membership and only reveals folded cards to their owner', () => {
    const { service, room } = setup(2);
    expect(() => service.snapshot(room.id, 'not-in-room')).toThrow(/请先加入房间/);
    const folded = [...room.players.values()][0];
    const event = { eventType:'texas_hand_settled', payload:{ players:[{
      userId:folded.userId, folded:true, holeCards:[{ rank:14,suit:'S' }], bestCards:[], handType:'高牌'
    }] } };
    expect(service.publicEvent(room,event,folded.userId).payload.players[0].holeCards).toHaveLength(1);
    expect(service.publicEvent(room,event,'not-in-room').payload.players[0].holeCards).toBeUndefined();
  });

  it('does not reopen a closed room through an invite code', () => {
    const { service, room } = setup(2);
    service.leaveRoom(room.id,'u0');
    service.leaveRoom(room.id,'u1');
    expect(room.status).toBe('closed');
    expect(() => service.joinRoom(room.code,'u0',{ buyIn:1000 })).toThrow(/房间已关闭/);
    expect(() => service.setSpectating(room.id,'u0',true)).toThrow(/房间已关闭/);
  });
});
