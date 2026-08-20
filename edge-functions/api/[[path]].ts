import type { AdminRoomView, Identity, Player, Room, RoomSummary, Spectator } from "../../shared/types"
import { applyAutomaticProgress, beginGame, bid, chooseDouble, passTurn, playCards, prepareNextRound, publicRoom } from "../_lib/engine"
import { ApiError, assert } from "../_lib/errors"
import { authenticate, hashSecret, isPlayer, randomToken, requireAdmin, resolveNickname } from "../_lib/security"
import { createStoredRoom, deleteRoom, getRoom, listStoredRooms, mutateRoom } from "../_lib/storage"

interface FunctionContext {
  request: Request
  env?: Record<string, string | undefined>
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store",
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders })
}

async function bodyOf(request: Request) {
  try {
    return await request.json() as Record<string, any>
  } catch {
    throw new ApiError(400, "请求内容不是有效 JSON")
  }
}

function validRoomId(roomId: string) {
  assert(/^\d{6}$/.test(roomId), "房间号必须是 6 位数字")
}

function randomRoomId() {
  const value = new Uint32Array(1)
  crypto.getRandomValues(value)
  return String(100000 + value[0] % 900000)
}

async function checkPassword(room: Room, password: unknown) {
  if (!room.passwordHash || !room.passwordSalt) return
  assert(typeof password === "string" && password.length > 0, "请输入房间密码", 403, "PASSWORD_REQUIRED")
  const actual = await hashSecret(password, room.passwordSalt)
  assert(actual === room.passwordHash, "房间密码不正确", 403, "WRONG_PASSWORD")
}

function nextOpenSeat(room: Room) {
  for (let seat = 0; seat < room.maxPlayers; seat += 1) {
    if (!room.players.some((player) => player.seat === seat)) return seat
  }
  return -1
}

async function createRoom(request: Request) {
  const body = await bodyOf(request)
  const maxPlayers = Number(body.maxPlayers)
  const baseScore = Number(body.baseScore)
  assert([2, 3, 4].includes(maxPlayers), "人数上限必须为 2～4 人")
  assert([10, 50, 100, 200, 500, 1000].includes(baseScore), "无效的房间底分")
  const password = typeof body.password === "string" ? body.password : ""
  assert(!password || (password.length >= 4 && password.length <= 16), "密码长度应为 4～16 个字符")

  for (let attempt = 0; attempt < 12; attempt += 1) {
    const id = randomRoomId()
    const playerId = crypto.randomUUID()
    const token = randomToken()
    const salt = password ? randomToken().slice(0, 24) : null
    const nickname = resolveNickname(body.nickname)
    const player: Player = {
      id: playerId,
      tokenHash: await hashSecret(token, id),
      nickname,
      seat: 0,
      beans: 10000,
      ready: false,
      role: null,
      double: 1,
      left: false,
      controlledByBot: false,
      joinedAt: Date.now(),
    }
    const room: Room = {
      id,
      gameType: "doudizhu",
      version: 1,
      maxPlayers: maxPlayers as Room["maxPlayers"],
      baseScore: baseScore as Room["baseScore"],
      passwordSalt: salt,
      passwordHash: salt ? await hashSecret(password, salt) : null,
      hostPlayerId: playerId,
      status: "waiting",
      players: [player],
      spectators: [],
      game: null,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      emptySince: null,
    }
    try {
      const stored = await createStoredRoom(room)
      const identity: Identity = { roomId: id, id: playerId, token, kind: "player" }
      return json({ identity, room: publicRoom(stored, playerId) }, 201)
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "ROOM_ID_CONFLICT") throw error
    }
  }
  throw new ApiError(503, "暂时无法分配房间号，请稍后重试")
}

function adminRoom(room: Room): AdminRoomView {
  return {
    id: room.id,
    gameType: room.gameType ?? "doudizhu",
    status: room.status,
    maxPlayers: room.maxPlayers,
    baseScore: room.baseScore,
    hasPassword: Boolean(room.passwordHash),
    hostPlayerId: room.hostPlayerId,
    members: [
      ...room.players.map((player) => ({
        id: player.id, kind: "player" as const, nickname: player.nickname, seat: player.seat,
        beans: player.beans, ready: player.ready, role: player.role, left: player.left,
        controlledByBot: player.controlledByBot, joinedAt: player.joinedAt,
      })),
      ...room.spectators.map((spectator) => ({
        id: spectator.id, kind: "spectator" as const, nickname: spectator.nickname,
        seat: null, beans: null, ready: false, role: null, left: false,
        controlledByBot: false, joinedAt: spectator.joinedAt,
      })),
    ],
    publicMultiplier: room.game?.publicMultiplier ?? 1,
    roundId: room.game?.roundId ?? null,
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
    version: room.version,
  }
}

async function adminRooms() {
  const rooms = await listStoredRooms()
  rooms.sort((left, right) => right.updatedAt - left.updatedAt)
  return json({ rooms: rooms.filter((room) => !room.dissolved).map(adminRoom) })
}

async function adminKick(request: Request, roomId: string) {
  validRoomId(roomId)
  const body = await bodyOf(request)
  const memberId = String(body.memberId ?? "")
  assert(memberId, "缺少要踢出的成员")
  const existing = await getRoom(roomId)
  assert(existing, "房间不存在或已经解散", 404, "ROOM_NOT_FOUND")
  const { room } = await mutateRoom(roomId, existing.version, (current) => {
    const player = current.players.find((entry) => entry.id === memberId)
    const spectator = current.spectators.find((entry) => entry.id === memberId)
    assert(player || spectator, "成员已经离开房间", 404, "MEMBER_NOT_FOUND")
    if (spectator) {
      current.spectators = current.spectators.filter((entry) => entry.id !== memberId)
      return
    }
    if (["bidding", "doubling", "playing"].includes(current.status)) {
      player!.left = true
      player!.controlledByBot = true
      player!.ready = false
      player!.tokenHash = `revoked-${crypto.randomUUID()}`
      applyAutomaticProgress(current)
    } else {
      current.players = current.players.filter((entry) => entry.id !== memberId)
      if (current.hostPlayerId === memberId) current.hostPlayerId = current.players[0]?.id ?? ""
    }
  })
  return json({ room: adminRoom(room) })
}

async function adminDissolve(roomId: string) {
  validRoomId(roomId)
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const existing = await getRoom(roomId)
    assert(existing, "房间不存在或已经解散", 404, "ROOM_NOT_FOUND")
    try {
      await mutateRoom(roomId, existing.version, (current) => { current.dissolved = true })
      await deleteRoom(roomId)
      return json({ dissolved: true, roomId })
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT" || attempt === 2) throw error
    }
  }
  throw new ApiError(409, "房间正在发生变化，请重试", "VERSION_CONFLICT")
}

async function joinRoom(request: Request, roomId: string) {
  validRoomId(roomId)
  const body = await bodyOf(request)
  const asSpectator = body.as === "spectator"
  const existing = await getRoom(roomId)
  assert(existing, "房间不存在或已经过期", 404, "ROOM_NOT_FOUND")
  await checkPassword(existing, body.password)
  const id = crypto.randomUUID()
  const token = randomToken()

  const { room } = await mutateRoom(roomId, existing.version, async (current) => {
    await checkPassword(current, body.password)
    const nickname = resolveNickname(body.nickname, current)
    const tokenHash = await hashSecret(token, roomId)
    if (asSpectator) {
      assert(current.spectators.length < 20, "观战席已满", 409, "SPECTATORS_FULL")
      const spectator: Spectator = { id, tokenHash, nickname, joinedAt: Date.now() }
      current.spectators.push(spectator)
      return
    }
    assert(current.status === "waiting" || current.status === "finished", "对局已经开始，请先观战", 409, "GAME_IN_PROGRESS")
    const seat = nextOpenSeat(current)
    assert(seat >= 0, "游戏席已满", 409, "ROOM_FULL")
    current.players.push({
      id, tokenHash, nickname, seat, beans: 10000, ready: false, role: null,
      double: 1, left: false, controlledByBot: false, joinedAt: Date.now(),
    })
  })
  const identity: Identity = { roomId, id, token, kind: asSpectator ? "spectator" : "player" }
  return json({ identity, room: publicRoom(room, id) }, 201)
}

function summarize(room: Room): RoomSummary {
  return {
    id: room.id,
    maxPlayers: room.maxPlayers,
    playerCount: room.players.filter((player) => !player.left).length,
    spectatorCount: room.spectators.length,
    baseScore: room.baseScore,
    hasPassword: Boolean(room.passwordHash),
    status: room.status,
    hostNickname: room.players.find((player) => player.id === room.hostPlayerId)?.nickname ?? "房主已离开",
    updatedAt: room.updatedAt,
  }
}

async function roomList() {
  const now = Date.now()
  const rooms = await listStoredRooms()
  const expired = rooms.filter((room) => now - room.updatedAt > 2 * 60 * 60 * 1000 || (room.emptySince && now - room.emptySince > 5 * 60 * 1000))
  await Promise.all(expired.map((room) => deleteRoom(room.id)))
  const active = rooms.filter((room) => !room.dissolved && !expired.includes(room) && (room.players.length || room.spectators.length))
  active.sort((left, right) => {
    const priority = { waiting: 0, finished: 1, bidding: 2, doubling: 2, playing: 2 }
    return priority[left.status] - priority[right.status] || right.updatedAt - left.updatedAt
  })
  return json({ rooms: active.map(summarize) })
}

async function roomState(request: Request, roomId: string) {
  validRoomId(roomId)
  const url = new URL(request.url)
  const viewerId = request.headers.get("x-player-id") ?? url.searchParams.get("id") ?? ""
  const authorization = request.headers.get("authorization") ?? ""
  const token = authorization.startsWith("Bearer ") ? authorization.slice(7) : (url.searchParams.get("token") ?? "")
  let room = await getRoom(roomId)
  assert(room, "房间不存在或已经过期", 404, "ROOM_NOT_FOUND")
  await authenticate(room, viewerId, token)

  const currentGame = room.game
  const shouldAdvance = Boolean(currentGame && (
    currentGame.deadlineAt <= Date.now()
    || (room.status === "playing" && room.players.find((player) => player.seat === currentGame.currentSeat)?.controlledByBot)
  ))
  if (shouldAdvance) {
    try {
      const result = await mutateRoom(roomId, room.version, (current) => applyAutomaticProgress(current))
      room = result.room
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "VERSION_CONFLICT") throw error
      room = await getRoom(roomId)
      assert(room, "房间不存在或已经过期", 404, "ROOM_NOT_FOUND")
    }
  }
  await authenticate(room, viewerId, token)
  return json({ room: publicRoom(room, viewerId) })
}

async function roomAction(request: Request, roomId: string) {
  validRoomId(roomId)
  const body = await bodyOf(request)
  const id = String(body.id ?? "")
  const token = String(body.token ?? "")
  const action = String(body.action ?? "")
  const expectedVersion = Number.isInteger(body.version) ? body.version as number : undefined
  let leftRoom = false

  const { room } = await mutateRoom(roomId, expectedVersion, async (current) => {
    const member = await authenticate(current, id, token)
    if (action === "leave") {
      if (isPlayer(member)) {
        if (["bidding", "doubling", "playing"].includes(current.status)) {
          member.left = true
          member.controlledByBot = true
          member.ready = false
          applyAutomaticProgress(current)
        } else {
          current.players = current.players.filter((player) => player.id !== id)
          if (current.hostPlayerId === id) current.hostPlayerId = current.players[0]?.id ?? ""
        }
      } else {
        current.spectators = current.spectators.filter((spectator) => spectator.id !== id)
      }
      leftRoom = true
      return
    }

    if (action === "join-game") {
      assert(!isPlayer(member), "你已经在游戏席")
      assert(current.status === "waiting" || current.status === "finished", "本局结束后才能加入游戏席")
      const seat = nextOpenSeat(current)
      assert(seat >= 0, "游戏席已满", 409, "ROOM_FULL")
      current.spectators = current.spectators.filter((spectator) => spectator.id !== id)
      current.players.push({
        id: member.id, tokenHash: member.tokenHash, nickname: member.nickname, seat,
        beans: 10000, ready: false, role: null, double: 1, left: false,
        controlledByBot: false, joinedAt: Date.now(),
      })
      return
    }

    assert(isPlayer(member), "观众不能执行该操作", 403)
    if (action === "ready") {
      if (current.status === "finished") prepareNextRound(current)
      assert(current.status === "waiting", "当前不能准备")
      assert(member.beans > 0, "欢乐豆不足，请退出房间后重新进入")
      member.ready = Boolean(body.ready)
    } else if (action === "start") {
      assert(current.hostPlayerId === member.id, "只有房主可以开始游戏", 403)
      beginGame(current)
    } else if (action === "bid") {
      bid(current, member, Boolean(body.choice))
    } else if (action === "double") {
      chooseDouble(current, member, Number(body.value) as 1 | 2 | 4)
    } else if (action === "play") {
      assert(Array.isArray(body.cardIds), "请选择要出的牌")
      playCards(current, member, body.cardIds.map(String))
    } else if (action === "pass") {
      passTurn(current, member)
    } else {
      throw new ApiError(400, "未知的房间操作")
    }
    applyAutomaticProgress(current)
  })
  if (leftRoom) return json({ left: true })
  return json({ room: publicRoom(room, id) })
}

export default async function onRequest({ request, env = {} }: FunctionContext) {
  if (request.method === "OPTIONS") return new Response(null, { status: 204 })
  try {
    const pathname = new URL(request.url).pathname.replace(/\/+$/, "") || "/"
    if (pathname.startsWith("/api/admin/")) {
      await requireAdmin(request, env)
      if (pathname === "/api/admin/rooms" && request.method === "GET") return await adminRooms()
      const kickMatch = pathname.match(/^\/api\/admin\/rooms\/(\d{6})\/kick$/)
      if (kickMatch && request.method === "POST") return await adminKick(request, kickMatch[1])
      const dissolveMatch = pathname.match(/^\/api\/admin\/rooms\/(\d{6})\/dissolve$/)
      if (dissolveMatch && request.method === "POST") return await adminDissolve(dissolveMatch[1])
      return json({ error: "管理接口不存在", code: "NOT_FOUND" }, 404)
    }
    if (pathname === "/api/rooms" && request.method === "GET") return await roomList()
    if (pathname === "/api/rooms/create" && request.method === "POST") return await createRoom(request)

    const joinMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/join$/)
    if (joinMatch && request.method === "POST") return await joinRoom(request, joinMatch[1])
    const stateMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/state$/)
    if (stateMatch && request.method === "GET") return await roomState(request, stateMatch[1])
    const actionMatch = pathname.match(/^\/api\/rooms\/(\d{6})\/action$/)
    if (actionMatch && request.method === "POST") return await roomAction(request, actionMatch[1])
    return json({ error: "接口不存在", code: "NOT_FOUND" }, 404)
  } catch (error) {
    if (error instanceof ApiError) return json({ error: error.message, code: error.code }, error.status)
    console.error(error)
    return json({ error: "服务器暂时开小差了", code: "INTERNAL_ERROR" }, 500)
  }
}
