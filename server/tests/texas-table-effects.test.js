import { describe, expect, it } from 'vitest';
import { eventEffects, initialEventCursor } from '../../public/dezhou-effects.js';

describe('Texas table effect mapping', () => {
  it('baselines restored event history so refresh does not replay animations', () => {
    expect(initialEventCursor([{ id:2 }, { id:9 }, { id:4 }])).toBe(9);
    expect(initialEventCursor([])).toBe(0);
  });

  it('maps live entry, betting, collection, check, and all-in events', () => {
    expect(eventEffects({ eventType:'texas_player_joined', payload:{ userId:'u2', seat:2 } })).toEqual([
      { kind:'seat-entry', userId:'u2', seat:2 }
    ]);
    expect(eventEffects({ eventType:'texas_player_action', payload:{ userId:'u1', seat:1, action:'raise', paid:80, streetBet:100 } })).toEqual([
      { kind:'bet', userId:'u1', seat:1, amount:80, streetBet:100, allIn:false }
    ]);
    expect(eventEffects({ eventType:'texas_player_action', payload:{ userId:'u1', seat:1, action:'check', paid:0 } })).toEqual([
      { kind:'check', userId:'u1', seat:1 }
    ]);
    expect(eventEffects({ eventType:'texas_player_action', payload:{ userId:'u1', seat:1, action:'all_in', paid:900, streetBet:1000 } })[0]).toMatchObject({ kind:'bet', allIn:true });
    expect(eventEffects({ eventType:'flop_dealt', payload:{ collectedBets:[{ seat:0, amount:20 }] } })).toEqual([
      { kind:'collect-pot', street:'flop', bets:[{ seat:0, amount:20 }] }
    ]);
  });

  it('creates fold effects from identifiers only and never carries card faces', () => {
    const source = { eventType:'texas_player_action', payload:{ userId:'u1', seat:1, action:'fold', holeCards:[{ rank:14, suit:'S' }, { rank:14, suit:'H' }] } };
    const effects = eventEffects(source);
    expect(effects).toEqual([{ kind:'fold', userId:'u1', seat:1 }]);
    expect(JSON.stringify(effects)).not.toMatch(/rank|suit|holeCards|cards/);
  });

  it('distinguishes showdown settlement from an uncontested win', () => {
    const players = [{ userId:'winner', payout:100, net:40 }, { userId:'loser', payout:0, net:-40 }];
    expect(eventEffects({ eventType:'texas_hand_settled', payload:{ uncontested:false, players, pots:[{ amount:100 }] } })[0]).toMatchObject({
      kind:'settlement', winnerUserIds:['winner'], loserUserIds:['loser']
    });
    expect(eventEffects({ eventType:'texas_hand_settled', payload:{ uncontested:true, players, pots:[{ amount:100 }] } })[0]).toMatchObject({
      kind:'uncontested', revealWinner:false, winnerUserIds:['winner']
    });
  });
});
