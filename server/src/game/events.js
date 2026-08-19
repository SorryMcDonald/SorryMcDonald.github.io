const PRIVATE_KEYS = new Set(['cards', 'hand', 'typeName', 'handType']);

export function publicEvent(event, { spectator = false, settled = false } = {}) {
  const payload = { ...(event?.payload ?? {}) };
  if (!settled && (event?.eventType === 'compare_started' || event?.eventType === 'compare_resolved')) {
    for (const key of PRIVATE_KEYS) delete payload[key];
  }
  if (!spectator && !settled) {
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

export function visibleRoom(room, { userId, spectator = false } = {}) {
  const isSpectator = spectator || room.spectators.has(userId);
  return {
    id: room.id, code: room.code, status: room.status, hostUserId: room.hostUserId,
    dealerUserId: room.dealerUserId, dealerSeat: room.dealerSeat, currentTurn: room.currentTurn,
    ante: room.ante, level: room.level, pot: room.pot, roundNumber: room.roundNumber,
    allowSpectators: room.allowSpectators, isSpectator,
    players: [...room.players.values()].filter((player) => !player.left).map((player) => ({
      id: player.id, userId: player.userId, seat: player.seat, nickname: player.nickname,
      folded: player.folded, allIn: player.allIn, seen: player.seen, currentBet: player.currentBet,
      totalContribution: player.totalContribution, actionSeq: player.actionSeq, lastAction: player.lastAction,
      cards: isSpectator || player.userId === userId || room.status === 'settled' ? player.cards : undefined,
      handType: isSpectator || player.userId === userId || room.status === 'settled' ? player.handType : undefined
    })),
    spectators: [...room.spectators].map((id) => ({ userId: id }))
  };
}
