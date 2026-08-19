import { describe, expect, it } from 'vitest';
import { allowedActions, blindPositions, calculateTexasPots, compareEvaluations, evaluateTexasHand } from '../src/texas/rules.js';

const c = (rank, suit) => ({ rank, suit });

describe('Texas Holdem rules', () => {
  it('evaluates the best five cards from seven including the wheel', () => {
    const straightFlush = evaluateTexasHand([c(14,'S'),c(13,'S'),c(12,'S'),c(11,'S'),c(10,'S'),c(2,'D'),c(3,'C')]);
    const wheel = evaluateTexasHand([c(14,'S'),c(2,'D'),c(3,'C'),c(4,'H'),c(5,'S'),c(9,'D'),c(10,'C')]);
    expect(straightFlush).toMatchObject({ level: 9, name: '同花顺', values: [14] });
    expect(wheel).toMatchObject({ level: 5, name: '顺子', values: [5] });
    expect(compareEvaluations(straightFlush, wheel)).toBeGreaterThan(0);
  });

  it('uses standard heads-up and multi-player blind positions', () => {
    const players = [0,1,2].map((seat) => ({ seat, stack: 100, left: false }));
    expect(blindPositions(players.slice(0,2), 0)).toEqual({ smallBlindSeat:0, bigBlindSeat:1, firstPreflopSeat:0 });
    expect(blindPositions(players, 0)).toEqual({ smallBlindSeat:1, bigBlindSeat:2, firstPreflopSeat:0 });
  });

  it('splits main and side pots and awards odd chips clockwise from dealer', () => {
    const best = { level: 8, values:[9,14] };
    const tied = { level: 2, values:[10,9,8,7] };
    const players = [
      { id:'a', seat:0, totalContribution:50, folded:false, left:false, evaluation:best },
      { id:'b', seat:1, totalContribution:100, folded:false, left:false, evaluation:tied },
      { id:'c', seat:2, totalContribution:100, folded:false, left:false, evaluation:tied }
    ];
    const result = calculateTexasPots(players, 0);
    expect(result.pots.map((pot) => pot.amount)).toEqual([150,100]);
    expect(result.payouts).toEqual({ a:150, b:50, c:50 });
  });

  it('returns server-authoritative action limits', () => {
    const room = { currentTurn:1, currentBet:80, minRaise:40 };
    const player = { seat:1, streetBet:20, stack:100, folded:false, allIn:false, inHand:true, left:false, canRaise:true };
    expect(allowedActions(room, player)).toEqual({ actions:['fold','call','all_in','raise'], toCall:60, minRaiseTo:120, maxRaiseTo:120 });
  });
});
