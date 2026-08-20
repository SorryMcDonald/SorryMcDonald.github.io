import { useCallback, useEffect, useMemo, useState } from "react"
import type { AdminRoomView, GameType, RoomStatus } from "../../shared/types"
import { api, ApiClientError } from "../api"

const gameLabels: Record<GameType, string> = {
  doudizhu: "欢乐斗地主",
  wuziqi: "五子棋",
  draw: "你画我猜",
  uno: "UNO",
}

const statusLabels: Record<RoomStatus, string> = {
  waiting: "等待中",
  bidding: "抢地主",
  doubling: "加倍中",
  playing: "游戏中",
  finished: "已结束",
}

function dateTime(value: number) {
  return new Intl.DateTimeFormat("zh-CN", {
    month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).format(value)
}

export function AdminPage({ notify }: { notify: (message: string, kind?: "error" | "success") => void }) {
  const [secret, setSecret] = useState(() => sessionStorage.getItem("game-admin-secret") ?? "")
  const [secretInput, setSecretInput] = useState("")
  const [rooms, setRooms] = useState<AdminRoomView[]>([])
  const [authenticated, setAuthenticated] = useState(false)
  const [loading, setLoading] = useState(false)
  const [search, setSearch] = useState("")
  const [gameFilter, setGameFilter] = useState<"all" | GameType>("all")
  const [statusFilter, setStatusFilter] = useState<"all" | RoomStatus>("all")
  const [expanded, setExpanded] = useState<string | null>(null)

  const load = useCallback(async (key = secret, quiet = false) => {
    if (!key) return false
    if (!quiet) setLoading(true)
    try {
      const result = await api.adminRooms(key)
      setRooms(result.rooms)
      setAuthenticated(true)
      return true
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "ADMIN_UNAUTHORIZED") {
        sessionStorage.removeItem("game-admin-secret")
        setAuthenticated(false)
        setSecret("")
      }
      if (!quiet) notify(error instanceof Error ? error.message : "无法进入管理后台", "error")
      return false
    } finally {
      if (!quiet) setLoading(false)
    }
  }, [notify, secret])

  useEffect(() => {
    if (!secret) return
    void load(secret)
  }, []) // 仅恢复本标签页中的管理会话

  useEffect(() => {
    if (!authenticated || !secret) return
    const timer = window.setInterval(() => void load(secret, true), 5000)
    return () => window.clearInterval(timer)
  }, [authenticated, load, secret])

  const login = async (event: React.FormEvent) => {
    event.preventDefault()
    const key = secretInput.trim()
    if (!key) return
    const accepted = await load(key)
    if (accepted) {
      sessionStorage.setItem("game-admin-secret", key)
      setSecret(key)
      setSecretInput("")
      notify("管理身份验证成功")
    }
  }

  const logout = () => {
    sessionStorage.removeItem("game-admin-secret")
    setSecret("")
    setRooms([])
    setAuthenticated(false)
  }

  const filtered = useMemo(() => rooms.filter((room) => {
    if (gameFilter !== "all" && room.gameType !== gameFilter) return false
    if (statusFilter !== "all" && room.status !== statusFilter) return false
    if (search && !room.id.includes(search.trim()) && !room.members.some((member) => member.nickname.includes(search.trim()))) return false
    return true
  }), [gameFilter, rooms, search, statusFilter])

  const kick = async (room: AdminRoomView, memberId: string, nickname: string) => {
    if (!window.confirm(`确认将“${nickname}”踢出房间 #${room.id}？`)) return
    setLoading(true)
    try {
      const result = await api.adminKick(secret, room.id, memberId)
      setRooms((current) => current.map((entry) => entry.id === room.id ? result.room : entry))
      notify(`已将 ${nickname} 踢出房间`)
    } catch (error) {
      notify(error instanceof Error ? error.message : "踢出失败", "error")
      await load(secret, true)
    } finally {
      setLoading(false)
    }
  }

  const dissolve = async (room: AdminRoomView) => {
    if (!window.confirm(`确认立即解散“${gameLabels[room.gameType]}”房间 #${room.id}？所有玩家都会退出且无法恢复。`)) return
    setLoading(true)
    try {
      await api.adminDissolve(secret, room.id)
      setRooms((current) => current.filter((entry) => entry.id !== room.id))
      notify(`房间 #${room.id} 已解散`)
    } catch (error) {
      notify(error instanceof Error ? error.message : "解散失败", "error")
      await load(secret, true)
    } finally {
      setLoading(false)
    }
  }

  if (!authenticated) {
    return (
      <main className="admin-login">
        <section>
          <span className="admin-shield">◆</span>
          <span className="eyebrow">DEVELOPER CONSOLE</span>
          <h1>游戏运营后台</h1>
          <p>管理密钥仅在当前浏览器标签页保存，不会写入代码或公开存储。</p>
          <form onSubmit={login}>
            <label>管理密钥<input autoFocus type="password" value={secretInput} onChange={(event) => setSecretInput(event.target.value)} placeholder="输入 GAME_ADMIN_SECRET" /></label>
            <button className="primary-button" disabled={loading}>{loading ? "正在验证…" : "进入管理后台"}</button>
          </form>
          <a href="/">← 返回玩家大厅</a>
        </section>
      </main>
    )
  }

  const activePlayers = rooms.reduce((sum, room) => sum + room.members.filter((member) => member.kind === "player" && !member.left).length, 0)
  const spectators = rooms.reduce((sum, room) => sum + room.members.filter((member) => member.kind === "spectator").length, 0)
  return (
    <main className="admin-page">
      <div className="admin-heading">
        <div><span className="eyebrow">DEVELOPER CONSOLE</span><h1>游戏运营后台</h1><p>房间与成员状态每 5 秒自动刷新</p></div>
        <div><button className="admin-refresh" disabled={loading} onClick={() => void load(secret)}>↻ 刷新</button><button className="admin-logout" onClick={logout}>退出管理</button></div>
      </div>

      <section className="admin-stats">
        <article><small>活跃房间</small><strong>{rooms.length}</strong><span>全部游戏</span></article>
        <article><small>游戏玩家</small><strong>{activePlayers}</strong><span>不含托管离场</span></article>
        <article><small>观战人数</small><strong>{spectators}</strong><span>所有观战席</span></article>
        <article><small>进行中</small><strong>{rooms.filter((room) => ["bidding", "doubling", "playing"].includes(room.status)).length}</strong><span>实时牌局</span></article>
      </section>

      <section className="admin-panel">
        <div className="admin-toolbar">
          <div className="admin-search">⌕<input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="搜索房间号或昵称" /></div>
          <select value={gameFilter} onChange={(event) => setGameFilter(event.target.value as "all" | GameType)}><option value="all">全部游戏</option>{Object.entries(gameLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as "all" | RoomStatus)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
          <span>显示 {filtered.length} / {rooms.length} 个房间</span>
        </div>

        <div className="admin-room-list">
          {filtered.length ? filtered.map((room) => {
            const players = room.members.filter((member) => member.kind === "player")
            const watchers = room.members.filter((member) => member.kind === "spectator")
            const isExpanded = expanded === room.id
            return (
              <article className="admin-room" key={room.id}>
                <button className="admin-room-summary" onClick={() => setExpanded(isExpanded ? null : room.id)}>
                  <span className={`admin-game-icon ${room.gameType}`}>♠</span>
                  <span><small>{gameLabels[room.gameType]}</small><b>#{room.id} {room.hasPassword && "🔒"}</b></span>
                  <span className={`admin-status ${room.status}`}>{statusLabels[room.status]}</span>
                  <span><small>玩家</small><b>{players.filter((member) => !member.left).length}/{room.maxPlayers}</b></span>
                  <span><small>观战</small><b>{watchers.length}</b></span>
                  <span><small>底分 / 倍数</small><b>{room.baseScore} / ×{room.publicMultiplier}</b></span>
                  <span><small>最后更新</small><b>{dateTime(room.updatedAt)}</b></span>
                  <i>{isExpanded ? "⌃" : "⌄"}</i>
                </button>
                {isExpanded && (
                  <div className="admin-room-detail">
                    <div className="admin-members">
                      <h3>游戏席</h3>
                      {players.length ? players.map((member) => <div className="admin-member" key={member.id}><span className="member-avatar">{member.nickname.slice(0, 1)}</span><span><b>{member.nickname}</b><small>{member.id === room.hostPlayerId ? "房主 · " : ""}{member.role === "landlord" ? "地主" : member.role === "farmer" ? "农民" : `座位 ${Number(member.seat) + 1}`}{member.controlledByBot ? " · 托管" : ""}</small></span><span className="member-beans">🫘 {Number(member.beans).toLocaleString()}</span><button disabled={member.left || loading} onClick={() => void kick(room, member.id, member.nickname)}>{member.left ? "已离场" : "踢出"}</button></div>) : <p>暂无玩家</p>}
                    </div>
                    <div className="admin-members">
                      <h3>观战席</h3>
                      {watchers.length ? watchers.map((member) => <div className="admin-member" key={member.id}><span className="member-avatar watcher">◉</span><span><b>{member.nickname}</b><small>观众</small></span><button disabled={loading} onClick={() => void kick(room, member.id, member.nickname)}>踢出</button></div>) : <p>暂无观众</p>}
                    </div>
                    <aside><span>创建于 {dateTime(room.createdAt)}</span><span>状态版本 v{room.version}</span>{room.roundId && <span>对局 {room.roundId.slice(0, 8)}</span>}<button className="danger-button" disabled={loading} onClick={() => void dissolve(room)}>解散房间</button></aside>
                  </div>
                )}
              </article>
            )
          }) : <div className="admin-empty"><span>◇</span><b>没有符合条件的房间</b></div>}
        </div>
      </section>
    </main>
  )
}
