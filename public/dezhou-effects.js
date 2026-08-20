export function initialEventCursor(events = []) {
  return Math.max(0, ...events.map((event) => Number(event?.id) || 0));
}

export function eventEffects(event = {}) {
  const payload = event.payload ?? {};
  if (event.eventType === 'texas_player_joined') {
    return [{ kind:'seat-entry', userId:payload.userId, seat:Number(payload.seat) }];
  }
  if (event.eventType === 'texas_player_action') {
    const base = { userId:payload.userId, seat:Number(payload.seat) };
    if (payload.action === 'fold' || payload.action === 'timeout') return [{ kind:'fold', ...base }];
    if (payload.action === 'check') return [{ kind:'check', ...base }];
    if (Number(payload.paid) > 0) {
      return [{
        kind:'bet',
        ...base,
        amount:Number(payload.paid),
        streetBet:Number(payload.streetBet ?? payload.paid),
        allIn:payload.action === 'all_in'
      }];
    }
    return [];
  }
  const street = { flop_dealt:'flop', turn_dealt:'turn', river_dealt:'river' }[event.eventType];
  if (street) {
    return [{
      kind:'collect-pot',
      street,
      bets:payload.collectedBets ?? [],
      ...(Number.isFinite(Number(payload.pot)) ? { pot:Number(payload.pot) } : {})
    }];
  }
  if (event.eventType === 'texas_hand_settled') {
    const players = payload.players ?? [];
    const winnerUserIds = players.filter((player) => Number(player.payout) > 0).map((player) => player.userId);
    const loserUserIds = players.filter((player) => Number(player.net) < 0).map((player) => player.userId);
    return [{
      kind:payload.uncontested ? 'uncontested' : 'settlement',
      revealWinner:!payload.uncontested,
      winnerUserIds,
      loserUserIds,
      players,
      pots:payload.pots ?? []
    }];
  }
  return [];
}
