import { getStore } from "@edgeone/pages-blob"
import type { Room } from "../../shared/types"
import { ApiError } from "./errors"

// 官方运行时会自动注入当前项目凭证；读取时逐次声明强一致即可。
const store = getStore("game-rooms")
const roomKey = (roomId: string) => `rooms/${roomId}/state.json`

export async function getRoom(roomId: string) {
  const room = await store.get(roomKey(roomId), { type: "json", consistency: "strong" }) as Room | null
  return room?.dissolved ? null : room
}

export async function createStoredRoom(room: Room) {
  try {
    await store.setJSON(roomKey(room.id), room, { onlyIfNew: true })
  } catch {
    throw new ApiError(409, "房间号冲突，请重试", "ROOM_ID_CONFLICT")
  }
  const stored = await getRoom(room.id)
  if (!stored || stored.hostPlayerId !== room.hostPlayerId) {
    throw new ApiError(409, "房间号冲突，请重试", "ROOM_ID_CONFLICT")
  }
  return stored
}

export async function listStoredRooms() {
  const { blobs } = await store.list({ prefix: "rooms/", consistency: "strong" })
  const recent = blobs.filter((blob) => blob.key.endsWith("/state.json")).slice(-100)
  const rooms = await Promise.all(recent.map((blob) => store.get(blob.key, { type: "json", consistency: "strong" }) as Promise<Room | null>))
  return rooms.filter((room): room is Room => Boolean(room))
}

export async function deleteRoom(roomId: string) {
  await store.delete(roomKey(roomId))
  const { blobs } = await store.list({ prefix: `locks/${roomId}/`, consistency: "strong" })
  await Promise.all(blobs.map((blob) => store.delete(blob.key)))
}

export async function mutateRoom<T>(
  roomId: string,
  expectedVersion: number | undefined,
  mutate: (room: Room) => T | Promise<T>,
) {
  const room = await getRoom(roomId)
  if (!room) throw new ApiError(404, "房间不存在或已经过期", "ROOM_NOT_FOUND")
  if (expectedVersion !== undefined && room.version !== expectedVersion) {
    throw new ApiError(409, "房间状态已经更新", "VERSION_CONFLICT")
  }

  const nextVersion = room.version + 1
  const nonce = crypto.randomUUID()
  const lockKey = `locks/${roomId}/${nextVersion}.json`
  try {
    await store.setJSON(lockKey, { nonce, at: Date.now() }, { onlyIfNew: true })
  } catch {
    throw new ApiError(409, "其他玩家刚刚完成了操作，请重试", "VERSION_CONFLICT")
  }
  const lock = await store.get(lockKey, { type: "json", consistency: "strong" }) as { nonce?: string } | null
  if (lock?.nonce !== nonce) throw new ApiError(409, "其他玩家刚刚完成了操作，请重试", "VERSION_CONFLICT")

  try {
    const value = await mutate(room)
    room.version = nextVersion
    room.updatedAt = Date.now()
    room.emptySince = room.players.length || room.spectators.length ? null : (room.emptySince ?? Date.now())
    await store.setJSON(roomKey(roomId), room)
    return { room, value }
  } catch (error) {
    await store.delete(lockKey)
    throw error
  }
}
