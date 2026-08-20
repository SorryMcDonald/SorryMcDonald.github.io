import type { AdminRoomView, Identity, RoomSummary, RoomView } from "../shared/types"

export class ApiClientError extends Error {
  code: string
  status: number

  constructor(message: string, code: string, status: number) {
    super(message)
    this.code = code
    this.status = status
  }
}

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "content-type": "application/json",
      ...(options?.headers ?? {}),
    },
  })
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new ApiClientError(data.error ?? "请求失败", data.code ?? "REQUEST_FAILED", response.status)
  return data as T
}

export const api = {
  listRooms: () => request<{ rooms: RoomSummary[] }>("/api/rooms"),
  createRoom: (payload: { nickname: string; maxPlayers: number; baseScore: number; password: string }) =>
    request<{ identity: Identity; room: RoomView }>("/api/rooms/create", {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  joinRoom: (roomId: string, payload: { nickname: string; password: string; as: "player" | "spectator" }) =>
    request<{ identity: Identity; room: RoomView }>(`/api/rooms/${roomId}/join`, {
      method: "POST",
      body: JSON.stringify(payload),
    }),
  state: (identity: Identity) => request<{ room: RoomView }>(`/api/rooms/${identity.roomId}/state`, {
    headers: {
      "x-player-id": identity.id,
      authorization: `Bearer ${identity.token}`,
    },
  }),
  action: (identity: Identity, version: number, action: string, payload: Record<string, unknown> = {}) =>
    request<{ room?: RoomView; left?: boolean }>(`/api/rooms/${identity.roomId}/action`, {
      method: "POST",
      body: JSON.stringify({ id: identity.id, token: identity.token, version, action, ...payload }),
    }),
  adminRooms: (secret: string) => request<{ rooms: AdminRoomView[] }>("/api/admin/rooms", {
    headers: { authorization: `Bearer ${secret}` },
  }),
  adminKick: (secret: string, roomId: string, memberId: string) =>
    request<{ room: AdminRoomView }>(`/api/admin/rooms/${roomId}/kick`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: JSON.stringify({ memberId }),
    }),
  adminDissolve: (secret: string, roomId: string) =>
    request<{ dissolved: true; roomId: string }>(`/api/admin/rooms/${roomId}/dissolve`, {
      method: "POST",
      headers: { authorization: `Bearer ${secret}` },
      body: "{}",
    }),
}
