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
  it('uses 100/200 blinds, a 10,000 default buy-in and a fixed 100 raise increment', () => {
    const users = new Map([
      ['u0', { id:'u0', nickname:'甲', beans:100000, wins:0, losses:0 }],
      ['u1', { id:'u1', nickname:'乙', beans:100000, wins:0, losses:0 }]
    ]);
    const service = new TexasService({ store:{ users, banners:[] } });
    const room = service.createRoom('u0');
    service.joinRoom(room.id, 'u1');

    expect(room).toMatchObject({ smallBlind:100, bigBlind:200, minBuyIn:4000, maxBuyIn:20000, minRaise:100 });
    expect([...room.players.values()].map((player) => player.stack)).toEqual([10000,10000]);
    service.startHand(room.id, 'u0');
    const first = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    expect(service.snapshot(room.id, first.userId).allowedActions.minRaiseTo).toBe(300);
    act(service, room, first.userId, 'raise', 300);
    const second = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    expect(room.minRaise).toBe(100);
    expect(service.snapshot(room.id, second.userId).allowedActions.minRaiseTo).toBe(400);
  });

  it('does not retain a room when the creator cannot afford the buy-in', () => {
    const users = new Map([['poor', { id:'poor', nickname:'穷玩家', beans:0, wins:0, losses:0 }]]);
    const service = new TexasService({ store:{ users, banners:[] } });
    expect(() => service.createRoom('poor', { buyIn:10000 })).toThrow(/不足/);
    expect(service.rooms.size).toBe(0);
  });

  it('accepts player-only bounded chat and retains only the latest twenty messages', () => {
    const { service, room } = setup(2);
    expect(() => service.addMessage(room.id, 'spectator', '只读')).toThrow();
    expect(service.addMessage(room.id, 'u0', '  第一条  ', { now:1000 }).text).toBe('第一条');
    expect(() => service.addMessage(room.id, 'u0', '太快', { now:1500 })).toThrow(/频繁/);
    expect(() => service.addMessage(room.id, 'u0', '   ', { now:2200 })).toThrow(/空/);
    expect(() => service.addMessage(room.id, 'u0', 'x'.repeat(121), { now:3300 })).toThrow(/120/);
    for (let index = 1; index <= 20; index += 1) service.addMessage(room.id, 'u1', `消息${index}`, { now:1000 + index * 1000 });
    expect(room.messages).toHaveLength(20);
    expect(room.messages[0].text).toBe('消息1');
    expect(room.messages.at(-1).text).toBe('消息20');
  });

  it('records a turn deadline and folds the current player after the deadline context matches', () => {
    const { service, room } = setup(2);
    service.startHand(room.id, 'u0');
    expect(room.turnDeadlineAt).toBeTruthy();
    const actor = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    const context = { roomVersion:room.version, handId:room.hand.id, currentTurn:room.currentTurn, actionSeq:actor.actionSeq };
    service.timeoutFold(room.id, context);
    expect(actor.folded).toBe(true);
    expect(actor.lastAction).toBe('timeout');
  });
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
    const flop = room.events.find((event) => event.eventType === 'flop_dealt');
    expect(flop.payload.collectedBets).toEqual(expect.arrayContaining([
      expect.objectContaining({ amount:20 })
    ]));
  });

  it('marks an uncontested settlement and does not publish the winner hand to the folded opponent', () => {
    const { service, room } = setup(2);
    service.startHand(room.id, 'u0');
    const folding = [...room.players.values()].find((player) => player.seat === room.currentTurn);
    act(service, room, folding.userId, 'fold');

    const settled = room.events.findLast((event) => event.eventType === 'texas_hand_settled');
    const winner = settled.payload.players.find((player) => player.payout > 0);
    expect(settled.payload.uncontested).toBe(true);
    expect(service.publicEvent(room, settled, folding.userId).payload.players.find((player) => player.userId === winner.userId)).not.toHaveProperty('holeCards');
    expect(service.snapshot(room.id, folding.userId).players.find((player) => player.userId === winner.userId)).not.toHaveProperty('holeCards');
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

  it('gives a permitted spectator the full table view without exposing it to players', () => {
    const { service, users, room } = setup(2);
    users.set('u2', { id:'u2', nickname:'观战者', beans:100000, wins:0, losses:0 });
    room.allowSpectators = true;
    service.startHand(room.id, 'u0');
    service.setSpectating(room.id, 'u2', true);
    service.updateSettings(room.id, 'u0', { spectatorCards:false });

    const spectatorView = service.snapshot(room.id, 'u2');
    expect(spectatorView.isSpectator).toBe(true);
    expect(spectatorView.spectatorCards).toBe(true);
    expect(spectatorView.players.every((player) => player.holeCards?.length === 2)).toBe(true);

    const playerView = service.snapshot(room.id, 'u0');
    expect(playerView.players.find((player) => player.userId === 'u1').holeCards).toBeUndefined();
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
