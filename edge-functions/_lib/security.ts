import type { Player, Room, Spectator } from "../../shared/types"
import { ApiError } from "./errors"

const encoder = new TextEncoder()

export function randomToken() {
  return `${crypto.randomUUID()}${crypto.randomUUID().replaceAll("-", "")}`
}

export async function hashSecret(value: string, salt = "") {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(`${salt}:${value}`))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("")
}

export function cleanNickname(value: unknown) {
  return Array.from(String(value ?? "").trim().replace(/[<>&\u0000-\u001f]/g, "")).slice(0, 10).join("")
}

export function uniqueGuestName(room?: Pick<Room, "players" | "spectators">) {
  const occupied = new Set([
    ...(room?.players ?? []).map((player) => player.nickname),
    ...(room?.spectators ?? []).map((spectator) => spectator.nickname),
  ])
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const values = new Uint32Array(1)
    crypto.getRandomValues(values)
    const nickname = `快乐玩家${String(values[0] % 10000).padStart(4, "0")}`
    if (!occupied.has(nickname)) return nickname
  }
  return `快乐玩家${crypto.randomUUID().slice(0, 6)}`
}

export function resolveNickname(value: unknown, room?: Pick<Room, "players" | "spectators">) {
  const cleaned = cleanNickname(value)
  if (!cleaned) return uniqueGuestName(room)
  const duplicate = [...(room?.players ?? []), ...(room?.spectators ?? [])].some((entry) => entry.nickname === cleaned)
  if (duplicate) throw new ApiError(409, "该昵称在房间内已被使用", "NICKNAME_TAKEN")
  return cleaned
}

export async function authenticate(room: Room, id: string, token: string) {
  const entry = [...room.players, ...room.spectators].find((candidate) => candidate.id === id)
  if (!entry || !token || entry.tokenHash !== await hashSecret(token, room.id)) {
    throw new ApiError(401, "身份已失效，请重新进入房间", "UNAUTHORIZED")
  }
  return entry as Player | Spectator
}

export async function requireAdmin(request: Request, env: Record<string, string | undefined>) {
  const configured = env.GAME_ADMIN_SECRET
  if (!configured || configured.length < 12) {
    throw new ApiError(503, "管理密钥尚未配置，请在 EdgeOne 环境变量中设置 GAME_ADMIN_SECRET", "ADMIN_NOT_CONFIGURED")
  }
  const authorization = request.headers.get("authorization") ?? ""
  const provided = authorization.startsWith("Bearer ") ? authorization.slice(7) : ""
  if (!provided) throw new ApiError(401, "请输入管理密钥", "ADMIN_UNAUTHORIZED")
  const [expectedHash, actualHash] = await Promise.all([
    hashSecret(configured, "game-admin"),
    hashSecret(provided, "game-admin"),
  ])
  if (expectedHash !== actualHash) throw new ApiError(401, "管理密钥不正确", "ADMIN_UNAUTHORIZED")
}

export function isPlayer(value: Player | Spectator): value is Player {
  return "seat" in value
}
