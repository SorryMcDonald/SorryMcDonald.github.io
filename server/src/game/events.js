const PRIVATE_KEYS = new Set(['cards', 'hand', 'typeName', 'handType']);

export function publicEvent(event, { spectator = false, settled = false, revealed = false } = {}) {
  const payload = { ...(event?.payload ?? {}) };
  if (!settled && (event?.eventType === 'compare_started' || event?.eventType === 'compare_resolved')) {
    for (const key of PRIVATE_KEYS) delete payload[key];
  }
  if (!spectator && !settled && !revealed) {
    delete payload.cards;
    delete payload.hand;
    delete payload.typeName;
    delete payload.handType;
  }
  return { ...event, payload };
}

export function appendEvent(room, eventType, payload = {}, audience = 'room') {
  const event = { id: ++room.eventSeq, roomId: room.id, roundId: room.round?.id ?? null, eventType, payload, audience, createdAt: new Date().toISOString() };
  room.events.push(event);
  return event;
}

export function visibleRoom(room, { userId, spectator = false, titles = new Map() } = {}) {
  const isSpectator = spectator || room.spectators.has(userId);
  return {
    id: room.id, code: room.code, status: room.status, hostUserId: room.hostUserId,
    version: room.version, dealerUserId: room.dealerUserId, dealerSeat: room.dealerSeat, currentTurn: room.currentTurn,
    ante: room.ante, level: room.level, pot: room.pot, roundNumber: room.roundNumber,
    bettingRound: room.bettingRound, turnStartedAt: room.turnStartedAt, turnDeadlineAt: room.turnDeadlineAt,
    allowSpectators: room.allowSpectators, isSpectator,
    players: [...room.players.values()].filter((player) => !player.left).map((player) => {
      const visible = isSpectator || room.status === 'settled' || player.revealed || (player.userId === userId && player.seen);
      const result = {
        id: player.id, userId: player.userId, seat: player.seat, nickname: player.nickname,
        folded: player.folded, allIn: player.allIn, seen: player.seen, currentBet: player.currentBet,
        totalContribution: player.totalContribution, actionSeq: player.actionSeq, lastAction: player.lastAction,
        revealed: Boolean(player.revealed), mayReveal: player.userId === userId && Boolean(player.mayReveal),
        cardCount: player.cards?.length ?? 0, titles: titles.get(player.userId) ?? []
      };
      if (visible) {
        result.cards = player.cards;
        result.handType = player.handType;
      }
      return result;
    }),
    spectators: [...room.spectators].map((id) => ({ userId: id })),
    messages: (room.messages ?? []).slice(-20)
  };
}
