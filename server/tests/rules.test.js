import { describe, expect, it } from 'vitest';
import * as rules from '../src/game/rules.js';
import { buildCompareEvents, calculateSidePotPayouts, compareHands, evaluateHand, netChange, selectDealer, shouldSettle } from '../src/game/rules.js';

const c = (rank, suit = 'S') => ({ rank, suit });

describe('炸金花 rules', () => {
  it('ranks all supported hands and compares them', () => {
    expect(evaluateHand([c(10), c(10, 'H'), c(10, 'D')]).name).toBe('豹子');
    expect(evaluateHand([c(14, 'S'), c(2, 'H'), c(3, 'D')]).name).toBe('顺子');
    expect(compareHands([c(14, 'S'), c(14, 'H'), c(2)], [c(13, 'S'), c(13, 'H'), c(14)])).toBeGreaterThan(0);
  });

  it('splits side pots among the best eligible hands', () => {
    const payouts = calculateSidePotPayouts([
      { id: 'a', seat: 1, contribution: 100, cards: [c(14), c(14, 'H'), c(2)] },
      { id: 'b', seat: 2, contribution: 60, cards: [c(13), c(13, 'H'), c(2)] },
      { id: 'c', seat: 3, contribution: 100, folded: true, cards: [c(12), c(11), c(9)] },
    ]);
    expect(payouts.a).toBe(260);
    expect(payouts.b).toBe(0);
  });

  it('calculates net winnings and dealer tie-breaks', () => {
    expect(netChange({ payout: 300, totalContribution: 100 })).toBe(200);
    expect(selectDealer([
      { seat: 2, net: 50, settledOrder: 1 },
      { seat: 4, net: 50, settledOrder: 2 },
    ]).seat).toBe(4);
  });

  it('does not settle on one all-in while another player can act', () => {
    expect(shouldSettle({ alive: 3, actionable: 2, allMatched: false, allActed: true })).toBe(false);
    expect(shouldSettle({ alive: 3, actionable: 0, allMatched: true, allActed: true })).toBe(true);
  });

  it('keeps compare details hidden in the event contract', () => {
    expect(buildCompareEvents({ attacker: '甲', target: '乙', fee: 20, attackerWon: true })).toEqual([
      { type: 'compare_started', attacker: '甲', target: '乙', fee: 20 },
      { type: 'compare_resolved', winner: '甲', loser: '乙' },
    ]);
  });

  it('charges seen players twice the base action cost', () => {
    expect(rules.actionCost({ level: 20, seen: false, action: 'call' })).toBe(20);
    expect(rules.actionCost({ level: 20, seen: true, action: 'call' })).toBe(40);
    expect(rules.actionCost({ level: 20, seen: false, action: 'compare' })).toBe(40);
    expect(rules.actionCost({ level: 20, seen: true, action: 'compare' })).toBe(80);
  });

  it('accepts only safe integer raises above the current base level', () => {
    expect(rules.validateRaise({ amount: 50, level: 20, balance: 100, seen: false })).toEqual({ base: 50, charge: 50 });
    expect(rules.validateRaise({ amount: 50, level: 20, balance: 100, seen: true })).toEqual({ base: 50, charge: 100 });
    expect(() => rules.validateRaise({ amount: 20, level: 20, balance: 100, seen: false })).toThrow(/高于/);
    expect(() => rules.validateRaise({ amount: 20.5, level: 20, balance: 100, seen: false })).toThrow(/整数/);
    expect(() => rules.validateRaise({ amount: Number.POSITIVE_INFINITY, level: 20, balance: 100, seen: false })).toThrow(/整数/);
    expect(() => rules.validateRaise({ amount: 60, level: 20, balance: 100, seen: true })).toThrow(/不足/);
  });
});
