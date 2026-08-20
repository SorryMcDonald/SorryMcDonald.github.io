import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { comboLabel, findSuggestedPlay } from "../../shared/game"
import type { Identity, PublicPlayer, RoomView } from "../../shared/types"
import { api, ApiClientError } from "../api"
import { PlayingCard } from "../components/PlayingCard"
import { playSound } from "../sound"

const statusLabel = {
  waiting: "等待开局",
  bidding: "叫抢地主",
  doubling: "选择加倍",
  playing: "游戏进行中",
  finished: "本局结束",
}

function formatBeans(value: number) {
  return new Intl.NumberFormat("zh-CN").format(value)
}

function Countdown({ deadline }: { deadline: number }) {
  const [, rerender] = useState(0)
  useEffect(() => {
    const timer = window.setInterval(() => rerender((value) => value + 1), 250)
    return () => window.clearInterval(timer)
  }, [])
  const seconds = Math.max(0, Math.ceil((deadline - Date.now()) / 1000))
  return <span className={`countdown ${seconds <= 5 ? "urgent" : ""}`}>{seconds}</span>
}

function PlayerBadge({ player, active, me }: { player: PublicPlayer; active: boolean; me?: boolean }) {
  return (
    <div className={`player-badge ${active ? "active" : ""} ${me ? "me" : ""} ${player.left ? "left" : ""}`}>
      <div className="avatar">{player.nickname.slice(0, 1)}{player.role === "landlord" && <span className="crown">♛</span>}</div>
      <div className="player-copy"><b>{player.nickname}{me && <small>你</small>}</b><span>🫘 {formatBeans(player.beans)}</span></div>
      {player.cardCount > 0 && <span className="card-count">{player.cardCount}</span>}
      {player.ready && <span className="ready-tag">已准备</span>}
      {player.controlledByBot && <span className="bot-tag">托管</span>}
      {player.double > 1 && <span className="double-tag">×{player.double}</span>}
    </div>
  )
}

export function RoomPage({ identity, initialRoom, onLeft, onIdentityChange, notify }: {
  identity: Identity
  initialRoom: RoomView
  onLeft: () => void
  onIdentityChange: (identity: Identity) => void
  notify: (message: string, kind?: "error" | "success") => void
}) {
  const [room, setRoom] = useState(initialRoom)
  const [selected, setSelected] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const previous = useRef(initialRoom)
  const myPlayer = room.players.find((player) => player.id === identity.id)
  const amSpectator = room.viewer.kind === "spectator"
  const currentPlayer = room.game ? room.players.find((player) => player.seat === room.game!.currentSeat) : undefined
  const myTurn = Boolean(myPlayer && currentPlayer?.id === myPlayer.id)

  const acceptRoom = useCallback((next: RoomView) => {
    const old = previous.current
    if (next.version !== old.version) {
      const oldHistory = old.game?.history.length ?? 0
      const latest = next.game?.history.at(-1)
      if ((next.game?.history.length ?? 0) > oldHistory && latest && !latest.passed) {
        playSound(latest.combo?.type === "bomb" || latest.combo?.type === "rocket" ? "bomb" : "deal")
      }
      if (next.status === "finished" && old.status !== "finished") {
        const winner = next.game?.result?.winner
        playSound(myPlayer?.role === winner ? "win" : "lose")
      } else if (next.game?.currentSeat !== old.game?.currentSeat && next.players.find((player) => player.seat === next.game?.currentSeat)?.id === identity.id) {
        playSound("turn")
      }
    }
    previous.current = next
    setRoom(next)
    setSelected((cards) => cards.filter((id) => next.game?.myHand.some((card) => card.id === id)))
  }, [identity.id, myPlayer?.role])

  const refresh = useCallback(async () => {
    try {
      const result = await api.state(identity)
      acceptRoom(result.room)
    } catch (error) {
      if (error instanceof ApiClientError && ["UNAUTHORIZED", "ROOM_NOT_FOUND"].includes(error.code)) {
        notify(error.message, "error")
        onLeft()
      }
    }
  }, [acceptRoom, identity, notify, onLeft])

  useEffect(() => {
    const timer = window.setInterval(refresh, 1000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const act = async (action: string, payload: Record<string, unknown> = {}) => {
    if (busy) return
    setBusy(true)
    try {
      const result = await api.action(identity, room.version, action, payload)
      if (result.left) {
        onLeft()
        return
      }
      if (result.room) {
        if (result.room.viewer.kind !== identity.kind) {
          const nextIdentity = { ...identity, kind: result.room.viewer.kind }
          onIdentityChange(nextIdentity)
        }
        acceptRoom(result.room)
      }
      playSound("click")
    } catch (error) {
      if (error instanceof ApiClientError && error.code === "VERSION_CONFLICT") {
        await refresh()
        notify("牌桌刚刚有变化，请再试一次", "error")
      } else {
        playSound("error")
        notify(error instanceof Error ? error.message : "操作失败", "error")
      }
    } finally {
      setBusy(false)
    }
  }

  const exit = () => {
    const active = ["bidding", "doubling", "playing"].includes(room.status)
    if (active && !window.confirm("现在退出会进入托管，本局仍会继续结算。确认退出吗？")) return
    void act("leave")
  }

  const opponents = useMemo(() => room.players.filter((player) => player.id !== identity.id).sort((left, right) => left.seat - right.seat), [identity.id, room.players])
  const lastRecord = room.game?.history.at(-1)
  const canJoinGame = amSpectator && ["waiting", "finished"].includes(room.status) && room.players.length < room.maxPlayers
  const canStart = room.players.length >= 2 && room.players.length <= room.maxPlayers && room.players.every((player) => player.ready)

  const suggest = () => {
    if (!room.game || !myTurn) return
    const cards = findSuggestedPlay(room.game.myHand, room.game.lastPlay?.combo ?? null)
    if (!cards) {
      notify("没有能压过上一手的牌")
      return
    }
    setSelected(cards.map((card) => card.id))
    playSound("click")
  }

  return (
    <main className="room-page">
      <div className="room-topline">
        <div className="room-identity"><span className={`status-dot ${room.status}`} /><div><small>{statusLabel[room.status]}</small><b>房间 #{room.id}</b></div><button onClick={() => { void navigator.clipboard?.writeText(room.id); notify("房间号已复制", "success") }}>复制</button></div>
        <div className="table-metrics"><span>底分 <b>{room.baseScore}</b></span><span>倍数 <b>×{room.game?.publicMultiplier ?? 1}</b></span><span>观战 <b>{room.spectators.length}</b></span></div>
        <button className="exit-button" disabled={busy} onClick={exit}>退出房间</button>
      </div>

      <section className={`card-table phase-${room.status}`}>
        <div className="felt-pattern" />
        {amSpectator && <div className="spectator-banner">◉ 观战模式 · 不显示玩家手牌</div>}
        <div className={`opponents opponents-${opponents.length}`}>
          {opponents.map((player) => <PlayerBadge key={player.id} player={player} active={currentPlayer?.id === player.id} />)}
        </div>

        <div className="table-center">
          {room.game?.bottomRevealed && <div className="bottom-cards"><small>地主底牌</small><div>{room.game.bottomCards.map((card) => <PlayingCard key={card.id} card={card} small />)}</div></div>}

          {room.status === "waiting" && (
            <div className="waiting-center"><span className="table-logo">♠</span><h2>等待玩家入座</h2><p>{room.players.length}/{room.maxPlayers} 人 · 2 人起，全员准备即可开局</p><div className="seat-dots">{Array.from({ length: room.maxPlayers }, (_, index) => <i key={index} className={index < room.players.length ? "filled" : ""} />)}</div></div>
          )}
          {room.status === "bidding" && room.game?.bid && (
            <div className="phase-center"><span className="phase-icon">♛</span><h2>{room.game.bid.mode === "call" ? "叫地主" : "抢地主"}</h2><p>正在等待 {currentPlayer?.nickname}</p><Countdown deadline={room.game.deadlineAt} /></div>
          )}
          {room.status === "doubling" && room.game && (
            <div className="phase-center"><span className="phase-icon">×2</span><h2>选择加倍</h2><p>还有 {room.game.pendingDoubleSeats.length} 位玩家未选择</p><Countdown deadline={room.game.deadlineAt} /></div>
          )}
          {room.status === "playing" && room.game && (
            <div className="play-center">
              {lastRecord ? (
                <><small>{lastRecord.nickname} · {lastRecord.passed ? "不出" : lastRecord.combo ? comboLabel(lastRecord.combo.type) : ""}</small>{lastRecord.passed ? <strong className="pass-text">不出</strong> : <div className="played-cards">{lastRecord.cards.map((card) => <PlayingCard key={card.id} card={card} small />)}</div>}</>
              ) : <span className="table-logo faint">♠</span>}
              <div className="turn-label"><Countdown deadline={room.game.deadlineAt} /><span>{currentPlayer?.nickname} 的回合</span></div>
            </div>
          )}
          {room.status === "finished" && room.game?.result && (
            <div className={`result-panel ${room.game.result.winner}`}>
              <span className="result-rays" /><small>{room.game.result.spring === "spring" ? "春天 ×2" : room.game.result.spring === "anti-spring" ? "反春 ×2" : "本局结算"}</small>
              <h2>{room.game.result.winner === "landlord" ? "地主胜利" : "农民胜利"}</h2>
              <p>最终倍数 ×{room.game.result.multiplier}</p>
              <div className="result-list">{room.game.result.items.map((item) => <div key={item.playerId}><span>{item.nickname}</span><b className={item.delta >= 0 ? "gain" : "loss"}>{item.delta >= 0 ? "+" : ""}{formatBeans(item.delta)}</b><small>余额 {formatBeans(item.balance)}</small></div>)}</div>
            </div>
          )}
        </div>

        <div className="own-area">
          {myPlayer && <PlayerBadge player={myPlayer} active={myTurn} me />}
          {room.game && myPlayer && !myPlayer.left && (
            <div className="hand" aria-label="你的手牌">
              {room.game.myHand.map((card) => <PlayingCard key={card.id} card={card} selected={selected.includes(card.id)} onClick={() => setSelected((current) => current.includes(card.id) ? current.filter((id) => id !== card.id) : [...current, card.id])} />)}
            </div>
          )}
        </div>

        <div className="action-dock">
          {myPlayer && room.status === "waiting" && (
            <>
              <button className={myPlayer.ready ? "secondary-action" : "primary-action"} disabled={busy} onClick={() => void act("ready", { ready: !myPlayer.ready })}>{myPlayer.ready ? "取消准备" : "准备"}</button>
              {room.hostPlayerId === myPlayer.id && <button className="gold-action" disabled={busy || !canStart} onClick={() => void act("start")}>开始游戏</button>}
            </>
          )}
          {myPlayer && room.status === "bidding" && room.game?.bid?.actingSeat === myPlayer.seat && (
            <><button className="secondary-action" onClick={() => void act("bid", { choice: false })}>{room.game.bid.mode === "call" ? "不叫" : "不抢"}</button><button className="gold-action" onClick={() => void act("bid", { choice: true })}>{room.game.bid.mode === "call" ? "叫地主" : "抢地主"}</button></>
          )}
          {myPlayer && room.status === "doubling" && room.game?.pendingDoubleSeats.includes(myPlayer.seat) && (
            <><button className="secondary-action" onClick={() => void act("double", { value: 1 })}>不加倍</button><button className="primary-action" onClick={() => void act("double", { value: 2 })}>加倍</button><button className="gold-action pulse" onClick={() => void act("double", { value: 4 })}>超级加倍</button></>
          )}
          {myPlayer && room.status === "playing" && myTurn && (
            <><button className="secondary-action" onClick={suggest}>提示</button>{room.game?.lastPlay && room.game.trickLeaderId !== myPlayer.id && <button className="secondary-action" onClick={() => void act("pass")}>不出</button>}<button className="gold-action" disabled={!selected.length || busy} onClick={() => void act("play", { cardIds: selected })}>出牌</button></>
          )}
          {myPlayer && room.status === "finished" && !myPlayer.left && <button className="gold-action" onClick={() => void act("ready", { ready: true })}>再来一局</button>}
          {canJoinGame && <button className="gold-action" onClick={() => void act("join-game")}>加入下一局 · 获得 10K 欢乐豆</button>}
          {amSpectator && !canJoinGame && <span className="watching-note">正在观战，游戏席暂不可加入</span>}
        </div>
      </section>

      <aside className="spectator-list"><b>观战席</b>{room.spectators.length ? room.spectators.map((spectator) => <span key={spectator.id}>{spectator.nickname}</span>) : <small>暂无观众</small>}</aside>
    </main>
  )
}
