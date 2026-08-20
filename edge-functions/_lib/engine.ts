import { analyzeCombo, canBeat, dealCards, findSuggestedPlay, sortCards } from "../../shared/game"
import type { Card, GameResult, GameState, Player, Room, SettlementItem } from "../../shared/types"
import { ApiError, assert } from "./errors"

const BID_SECONDS = 15
const DOUBLE_SECONDS = 10
const PLAY_SECONDS = 30

function seatsFrom(room: Room, firstSeat: number) {
  const seats = room.players.map((player) => player.seat).sort((a, b) => a - b)
  const start = seats.indexOf(firstSeat)
  return [...seats.slice(start), ...seats.slice(0, start)]
}

function nextSeat(room: Room, seat: number) {
  const seats = room.players.map((player) => player.seat).sort((a, b) => a - b)
  return seats[(seats.indexOf(seat) + 1) % seats.length]
}

function playerAt(room: Room, seat: number) {
  const player = room.players.find((candidate) => candidate.seat === seat)
  if (!player) throw new ApiError(409, "座位状态异常")
  return player
}

function freshGame(room: Room, now: number, redeals = 0): GameState {
  const ordered = [...room.players].sort((left, right) => left.seat - right.seat)
  const { hands, bottomCards } = dealCards(ordered.map((player) => player.id))
  const first = ordered[Math.floor(Math.random() * ordered.length)].seat
  room.players.forEach((player) => {
    player.role = null
    player.double = 1
    player.controlledByBot = player.left
  })
  return {
    roundId: crypto.randomUUID(),
    phase: "bidding",
    hands,
    bottomCards,
    bottomRevealed: false,
    landlordPlayerId: null,
    currentSeat: first,
    bid: {
      mode: "call",
      actingSeat: first,
      pendingSeats: seatsFrom(room, first),
      declinedSeats: [],
      candidateSeat: null,
      redeals,
    },
    pendingDoubleSeats: [],
    publicMultiplier: 1,
    lastPlay: null,
    trickLeaderId: null,
    history: [],
    nonPassPlays: Object.fromEntries(ordered.map((player) => [player.id, 0])),
    deadlineAt: now + BID_SECONDS * 1000,
    result: null,
  }
}

export function beginGame(room: Room, now = Date.now()) {
  assert(room.status === "waiting", "当前不能开始游戏")
  assert(room.players.length >= 2, "至少需要 2 名玩家才能开始游戏")
  assert(room.players.length <= room.maxPlayers, "玩家人数超过房间上限")
  assert(room.players.every((player) => player.ready), "仍有玩家没有准备")
  room.status = "bidding"
  room.game = freshGame(room, now)
}

function finalizeLandlord(room: Room, now: number) {
  const game = room.game!
  const seat = game.bid?.candidateSeat
  assert(seat !== null && seat !== undefined, "地主状态异常")
  const landlord = playerAt(room, seat)
  landlord.role = "landlord"
  room.players.filter((player) => player.id !== landlord.id).forEach((player) => { player.role = "farmer" })
  game.landlordPlayerId = landlord.id
  game.hands[landlord.id].push(...game.bottomCards)
  sortCards(game.hands[landlord.id])
  game.bottomRevealed = true
  game.phase = "doubling"
  room.status = "doubling"
  game.currentSeat = landlord.seat
  game.pendingDoubleSeats = room.players.map((player) => player.seat)
  game.bid = null
  game.deadlineAt = now + DOUBLE_SECONDS * 1000
}

export function bid(room: Room, player: Player, choice: boolean, now = Date.now()) {
  const game = room.game
  assert(room.status === "bidding" && game?.bid, "当前不是叫抢地主阶段")
  assert(game.bid.actingSeat === player.seat, "还没有轮到你")

  const state = game.bid
  state.pendingSeats.shift()
  if (state.mode === "call") {
    if (!choice) {
      state.declinedSeats.push(player.seat)
      if (!state.pendingSeats.length) {
        room.game = freshGame(room, now, state.redeals + 1)
        return
      }
    } else {
      state.candidateSeat = player.seat
      state.mode = "rob"
      const order = seatsFrom(room, nextSeat(room, player.seat))
      state.pendingSeats = order.filter((seat) => seat !== player.seat && !state.declinedSeats.includes(seat))
      if (!state.pendingSeats.length) {
        finalizeLandlord(room, now)
        return
      }
    }
  } else if (choice) {
    state.candidateSeat = player.seat
    game.publicMultiplier *= 2
  }

  if (!state.pendingSeats.length) {
    finalizeLandlord(room, now)
    return
  }
  state.actingSeat = state.pendingSeats[0]
  game.currentSeat = state.actingSeat
  game.deadlineAt = now + BID_SECONDS * 1000
}

export function chooseDouble(room: Room, player: Player, value: 1 | 2 | 4, now = Date.now()) {
  const game = room.game
  assert(room.status === "doubling" && game, "当前不是加倍阶段")
  assert(game.pendingDoubleSeats.includes(player.seat), "你已经选择过加倍")
  assert([1, 2, 4].includes(value), "无效的加倍选项")
  player.double = value
  game.pendingDoubleSeats = game.pendingDoubleSeats.filter((seat) => seat !== player.seat)
  if (!game.pendingDoubleSeats.length) {
    room.status = "playing"
    game.phase = "playing"
    game.currentSeat = room.players.find((candidate) => candidate.id === game.landlordPlayerId)!.seat
    game.deadlineAt = now + PLAY_SECONDS * 1000
  }
}

function settle(room: Room, winner: "landlord" | "farmer") {
  const game = room.game!
  const landlord = room.players.find((player) => player.id === game.landlordPlayerId)!
  const farmers = room.players.filter((player) => player.role === "farmer")
  const balancesBefore = new Map(room.players.map((player) => [player.id, player.beans]))
  const farmerPlays = farmers.reduce((sum, player) => sum + (game.nonPassPlays[player.id] ?? 0), 0)
  const landlordPlays = game.nonPassPlays[landlord.id] ?? 0
  let spring: GameResult["spring"] = null
  if (winner === "landlord" && farmerPlays === 0) spring = "spring"
  if (winner === "farmer" && landlordPlays <= 1) spring = "anti-spring"
  if (spring) game.publicMultiplier *= 2

  const due = farmers.map((farmer) => ({
    farmer,
    amount: room.baseScore * game.publicMultiplier * landlord.double * farmer.double,
  }))

  if (winner === "landlord") {
    for (const item of due) {
      const paid = Math.min(item.amount, item.farmer.beans)
      item.farmer.beans -= paid
      landlord.beans += paid
    }
  } else {
    const totalDue = due.reduce((sum, item) => sum + item.amount, 0)
    const available = Math.min(landlord.beans, totalDue)
    let distributed = 0
    due.forEach((item, index) => {
      const share = index === due.length - 1
        ? available - distributed
        : Math.floor(available * item.amount / totalDue)
      item.farmer.beans += share
      distributed += share
    })
    landlord.beans -= distributed
  }

  const items: SettlementItem[] = room.players.map((player) => {
    return {
      playerId: player.id,
      nickname: player.nickname,
      role: player.role!,
      delta: player.beans - (balancesBefore.get(player.id) ?? player.beans),
      balance: player.beans,
    }
  })
  game.result = { winner, spring, multiplier: game.publicMultiplier, items }
  game.phase = "finished"
  game.deadlineAt = 0
  room.status = "finished"
  room.players.forEach((player) => { player.ready = false })
}

function removeCards(hand: Card[], cardIds: string[]) {
  const wanted = new Set(cardIds)
  assert(wanted.size === cardIds.length, "不能重复选择同一张牌")
  assert(cardIds.every((id) => hand.some((card) => card.id === id)), "所选牌不在你的手牌中")
  return hand.filter((card) => !wanted.has(card.id))
}

export function playCards(room: Room, player: Player, cardIds: string[], now = Date.now()) {
  const game = room.game
  assert(room.status === "playing" && game, "当前不能出牌")
  assert(game.currentSeat === player.seat, "还没有轮到你")
  const hand = game.hands[player.id]
  const cards = cardIds.map((id) => hand.find((card) => card.id === id)!).filter(Boolean)
  const nextCombo = analyzeCombo(cards)
  assert(nextCombo, "所选的牌不能组成合法牌型")
  const previous = game.lastPlay?.combo ?? null
  assert(canBeat(nextCombo, previous), "所选牌型不能压过上一手")
  game.hands[player.id] = removeCards(hand, cardIds)
  game.nonPassPlays[player.id] = (game.nonPassPlays[player.id] ?? 0) + 1
  const record = {
    id: crypto.randomUUID(), playerId: player.id, nickname: player.nickname,
    cards: sortCards(cards), combo: nextCombo, passed: false, at: now,
  }
  game.lastPlay = record
  game.trickLeaderId = player.id
  game.history.push(record)
  if (nextCombo.type === "bomb" || nextCombo.type === "rocket") game.publicMultiplier *= 2
  if (!game.hands[player.id].length) {
    settle(room, player.role === "landlord" ? "landlord" : "farmer")
    return
  }
  game.currentSeat = nextSeat(room, player.seat)
  game.deadlineAt = now + PLAY_SECONDS * 1000
}

export function passTurn(room: Room, player: Player, now = Date.now()) {
  const game = room.game
  assert(room.status === "playing" && game, "当前不能不出")
  assert(game.currentSeat === player.seat, "还没有轮到你")
  assert(game.lastPlay && game.trickLeaderId !== player.id, "你必须出牌")
  game.history.push({
    id: crypto.randomUUID(), playerId: player.id, nickname: player.nickname,
    cards: [], combo: null, passed: true, at: now,
  })
  const next = nextSeat(room, player.seat)
  game.currentSeat = next
  if (playerAt(room, next).id === game.trickLeaderId) {
    game.lastPlay = null
    game.trickLeaderId = null
  }
  game.deadlineAt = now + PLAY_SECONDS * 1000
}

function autoPlay(room: Room, player: Player, now: number) {
  const game = room.game!
  const cards = findSuggestedPlay(game.hands[player.id], game.lastPlay?.combo ?? null)
  if (cards?.length) playCards(room, player, cards.map((card) => card.id), now)
  else passTurn(room, player, now)
}

export function applyAutomaticProgress(room: Room, now = Date.now()) {
  let changed = false
  for (let guard = 0; guard < 24; guard += 1) {
    const game = room.game
    if (!game || game.phase === "finished") break
    if (room.status === "bidding" && game.bid) {
      const player = playerAt(room, game.bid.actingSeat)
      if (game.deadlineAt > now && !player.controlledByBot) break
      bid(room, player, false, now)
      changed = true
      continue
    }
    if (room.status === "doubling") {
      const target = game.pendingDoubleSeats.find((seat) => playerAt(room, seat).controlledByBot)
        ?? (game.deadlineAt <= now ? game.pendingDoubleSeats[0] : undefined)
      if (target === undefined) break
      chooseDouble(room, playerAt(room, target), 1, now)
      changed = true
      continue
    }
    if (room.status === "playing") {
      const player = playerAt(room, game.currentSeat)
      if (game.deadlineAt > now && !player.controlledByBot) break
      autoPlay(room, player, now)
      changed = true
      continue
    }
    break
  }
  return changed
}

export function prepareNextRound(room: Room) {
  assert(room.status === "finished", "本局尚未结束")
  room.players = room.players.filter((player) => !player.left)
  room.players.forEach((player) => {
    player.ready = false
    player.role = null
    player.double = 1
    player.controlledByBot = false
  })
  room.game = null
  room.status = "waiting"
  if (!room.players.some((player) => player.id === room.hostPlayerId)) {
    room.hostPlayerId = room.players[0]?.id ?? ""
  }
}

export function publicRoom(room: Room, viewerId: string) {
  const viewerPlayer = room.players.find((player) => player.id === viewerId)
  const viewerSpectator = room.spectators.find((spectator) => spectator.id === viewerId)
  assert(viewerPlayer || viewerSpectator, "你不在该房间", 401)
  const game = room.game
  const myHand = viewerPlayer && game ? game.hands[viewerPlayer.id] ?? [] : []
  return {
    id: room.id,
    version: room.version,
    maxPlayers: room.maxPlayers,
    baseScore: room.baseScore,
    hasPassword: Boolean(room.passwordHash),
    hostPlayerId: room.hostPlayerId,
    status: room.status,
    players: room.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      seat: player.seat,
      beans: player.beans,
      ready: player.ready,
      role: player.role,
      double: player.double,
      left: player.left,
      controlledByBot: player.controlledByBot,
      cardCount: game?.hands[player.id]?.length ?? 0,
    })),
    spectators: room.spectators.map(({ id, nickname }) => ({ id, nickname })),
    game: game ? { ...game, hands: undefined, myHand } : null,
    viewer: { id: viewerId, kind: viewerPlayer ? "player" : "spectator" },
    updatedAt: room.updatedAt,
  }
}
