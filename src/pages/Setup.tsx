import { useCallback, useEffect, useMemo, useState } from "react"
import type { Identity, RoomSummary, RoomView } from "../../shared/types"
import { api, ApiClientError } from "../api"
import { playSound } from "../sound"

const statusText: Record<RoomSummary["status"], string> = {
  waiting: "等待中",
  bidding: "抢地主",
  doubling: "加倍中",
  playing: "游戏中",
  finished: "已结束",
}

export function Setup({ onBack, onEntered, notify }: {
  onBack: () => void
  onEntered: (identity: Identity, room: RoomView) => void
  notify: (message: string, kind?: "error" | "success") => void
}) {
  const [nickname, setNickname] = useState(() => localStorage.getItem("game-nickname") ?? "")
  const [tab, setTab] = useState<"create" | "join">("create")
  const [maxPlayers, setMaxPlayers] = useState(3)
  const [baseScore, setBaseScore] = useState(100)
  const [hasPassword, setHasPassword] = useState(false)
  const [createPassword, setCreatePassword] = useState("")
  const [rooms, setRooms] = useState<RoomSummary[]>([])
  const [roomLayout, setRoomLayout] = useState<"grid" | "list">("grid")
  const [search, setSearch] = useState("")
  const [directRoom, setDirectRoom] = useState("")
  const [loading, setLoading] = useState(false)
  const [passwordPrompt, setPasswordPrompt] = useState<{ roomId: string; kind: "player" | "spectator" } | null>(null)
  const [joinPassword, setJoinPassword] = useState("")

  const rememberName = (value: string) => {
    setNickname(value)
    localStorage.setItem("game-nickname", value)
  }

  const refresh = useCallback(async () => {
    try {
      const result = await api.listRooms()
      setRooms(result.rooms)
    } catch {
      // 大厅列表会在下一轮自动重试，不打断当前输入。
    }
  }, [])

  useEffect(() => {
    if (tab !== "join") return
    void refresh()
    const timer = window.setInterval(refresh, 5000)
    return () => window.clearInterval(timer)
  }, [refresh, tab])

  const filteredRooms = useMemo(() => rooms.filter((room) => !search || room.id.includes(search.trim())), [rooms, search])

  const create = async () => {
    if (hasPassword && (createPassword.length < 4 || createPassword.length > 16)) {
      notify("房间密码需要 4～16 个字符", "error")
      return
    }
    setLoading(true)
    try {
      const result = await api.createRoom({ nickname, maxPlayers, baseScore, password: hasPassword ? createPassword : "" })
      playSound("join")
      onEntered(result.identity, result.room)
    } catch (error) {
      playSound("error")
      notify(error instanceof Error ? error.message : "创建房间失败", "error")
    } finally {
      setLoading(false)
    }
  }

  const join = async (roomId: string, kind: "player" | "spectator", password = "") => {
    if (!/^\d{6}$/.test(roomId)) {
      notify("请输入 6 位房间号", "error")
      return
    }
    setLoading(true)
    try {
      const result = await api.joinRoom(roomId, { nickname, password, as: kind })
      setPasswordPrompt(null)
      setJoinPassword("")
      playSound("join")
      onEntered(result.identity, result.room)
    } catch (error) {
      if (error instanceof ApiClientError && ["PASSWORD_REQUIRED", "WRONG_PASSWORD"].includes(error.code)) {
        setPasswordPrompt({ roomId, kind })
        if (error.code === "WRONG_PASSWORD") notify("密码不正确，请重试", "error")
      } else {
        playSound("error")
        notify(error instanceof Error ? error.message : "进入房间失败", "error")
      }
    } finally {
      setLoading(false)
    }
  }

  const requestJoin = (room: RoomSummary, kind: "player" | "spectator") => {
    if (room.hasPassword) setPasswordPrompt({ roomId: room.id, kind })
    else void join(room.id, kind)
  }

  return (
    <main className="setup-page">
      <button className="back-link" onClick={onBack}>← 返回游戏大厅</button>
      <section className="setup-heading">
        <div className="mini-card-fan" aria-hidden="true"><span>♠</span><span>♥</span><span>★</span></div>
        <div><span className="eyebrow">欢乐斗地主</span><h1>找张桌子，马上开局</h1><p>无需账号。昵称留空时，系统会为你分配一个。</p></div>
      </section>

      <section className="setup-panel">
        <label className="field-label nickname-field">
          <span>你的昵称 <small>选填</small></span>
          <input maxLength={10} value={nickname} onChange={(event) => rememberName(event.target.value)} placeholder="例如：今晚手气王" />
          <i>{Array.from(nickname).length}/10</i>
        </label>

        <div className="big-tabs">
          <button className={tab === "create" ? "active" : ""} onClick={() => setTab("create")}><b>＋</b><span>创建房间<small>我来做房主</small></span></button>
          <button className={tab === "join" ? "active" : ""} onClick={() => setTab("join")}><b>⌕</b><span>加入房间<small>浏览或输入房间号</small></span></button>
        </div>

        {tab === "create" ? (
          <div className="create-form panel-body">
            <div className="form-row">
              <label>人数上限</label>
              <div className="choice-pills">{[2, 3, 4].map((count) => <button key={count} className={maxPlayers === count ? "active" : ""} onClick={() => setMaxPlayers(count)}>{count} 人</button>)}</div>
            </div>
            <div className="form-row">
              <label>房间底分</label>
              <div className="choice-pills score-pills">{[10, 50, 100, 200, 500, 1000].map((score) => <button key={score} className={baseScore === score ? "active" : ""} onClick={() => setBaseScore(score)}>{score}</button>)}</div>
            </div>
            <div className="form-row password-row">
              <div><label>房间密码</label><small>加入与观战都需要验证</small></div>
              <button className={`switch ${hasPassword ? "on" : ""}`} onClick={() => setHasPassword(!hasPassword)} aria-pressed={hasPassword}><i /></button>
            </div>
            {hasPassword && <input className="password-input" type="password" maxLength={16} value={createPassword} onChange={(event) => setCreatePassword(event.target.value)} placeholder="输入 4～16 位房间密码" />}
            <button className="primary-button wide-button" disabled={loading} onClick={create}>{loading ? "正在创建…" : "创建房间"}<span>→</span></button>
            <p className="form-note">进入游戏席即获得 <b>10,000</b> 欢乐豆 · 无现金交易</p>
          </div>
        ) : (
          <div className="join-panel panel-body">
            <div className="direct-join">
              <input inputMode="numeric" maxLength={6} value={directRoom} onChange={(event) => setDirectRoom(event.target.value.replace(/\D/g, ""))} placeholder="输入 6 位房间号" />
              <button onClick={() => void join(directRoom, "player")}>加入</button>
              <button className="secondary" onClick={() => void join(directRoom, "spectator")}>观战</button>
            </div>
            <div className="room-toolbar">
              <div className="search-box">⌕<input value={search} onChange={(event) => setSearch(event.target.value.replace(/\D/g, ""))} placeholder="搜索房间号" /></div>
              <div className="layout-switch compact"><button className={roomLayout === "grid" ? "active" : ""} onClick={() => setRoomLayout("grid")}>▦</button><button className={roomLayout === "list" ? "active" : ""} onClick={() => setRoomLayout("list")}>☷</button></div>
            </div>
            <div className={`room-browser ${roomLayout}`}>
              {filteredRooms.length ? filteredRooms.map((room) => (
                <article className="room-card" key={room.id}>
                  <div className="room-card-top"><span className={`status ${room.status}`}>{statusText[room.status]}</span>{room.hasPassword && <span className="lock">🔒</span>}<strong>#{room.id}</strong></div>
                  <div className="room-host"><span>{room.hostNickname.slice(0, 1)}</span><div><b>{room.hostNickname}</b><small>房主</small></div></div>
                  <div className="room-stats"><span>♟ {room.playerCount}/{room.maxPlayers}</span><span>◉ {room.spectatorCount}</span><span>豆 {room.baseScore}</span></div>
                  <div className="room-actions"><button disabled={room.playerCount >= room.maxPlayers || !["waiting", "finished"].includes(room.status)} onClick={() => requestJoin(room, "player")}>加入</button><button className="secondary" onClick={() => requestJoin(room, "spectator")}>观战</button></div>
                </article>
              )) : <div className="empty-rooms"><span>♣</span><b>还没有可见房间</b><small>创建第一张牌桌，邀请朋友加入吧</small></div>}
            </div>
          </div>
        )}
      </section>

      {passwordPrompt && (
        <div className="modal-backdrop" onMouseDown={() => setPasswordPrompt(null)}>
          <form className="password-modal" onSubmit={(event) => { event.preventDefault(); void join(passwordPrompt.roomId, passwordPrompt.kind, joinPassword) }} onMouseDown={(event) => event.stopPropagation()}>
            <span className="modal-icon">🔒</span><h3>这是一个密码房</h3><p>房间 #{passwordPrompt.roomId} · {passwordPrompt.kind === "player" ? "加入游戏" : "进入观战"}</p>
            <input autoFocus type="password" value={joinPassword} onChange={(event) => setJoinPassword(event.target.value)} placeholder="输入房间密码" />
            <div><button type="button" className="ghost-button" onClick={() => setPasswordPrompt(null)}>取消</button><button className="primary-button" disabled={loading}>确认进入</button></div>
          </form>
        </div>
      )}
    </main>
  )
}
