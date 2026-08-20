import { useEffect, useState } from "react"
import type { Identity, RoomView } from "../shared/types"
import { api } from "./api"
import { Shell } from "./components/Shell"
import { AdminPage } from "./pages/Admin"
import { Hall } from "./pages/Hall"
import { RoomPage } from "./pages/Room"
import { Setup } from "./pages/Setup"
import { isMuted } from "./sound"

type Page = "hall" | "setup" | "room" | "admin"

function loadIdentity(): Identity | null {
  try {
    return JSON.parse(sessionStorage.getItem("active-room-identity") ?? "null")
  } catch {
    return null
  }
}

export default function App() {
  const savedIdentity = loadIdentity()
  const [page, setPage] = useState<Page>(() => window.location.pathname.startsWith("/admin") ? "admin" : (savedIdentity ? "room" : "hall"))
  const [identity, setIdentity] = useState<Identity | null>(savedIdentity)
  const [room, setRoom] = useState<RoomView | null>(null)
  const [muted, setMuted] = useState(isMuted())
  const [toast, setToast] = useState<{ id: number; message: string; kind: "error" | "success" } | null>(null)

  const notify = (message: string, kind: "error" | "success" = "success") => {
    const id = Date.now()
    setToast({ id, message, kind })
    window.setTimeout(() => setToast((current) => current?.id === id ? null : current), 3000)
  }

  const enterRoom = (nextIdentity: Identity, nextRoom: RoomView) => {
    sessionStorage.setItem("active-room-identity", JSON.stringify(nextIdentity))
    setIdentity(nextIdentity)
    setRoom(nextRoom)
    setPage("room")
  }

  const updateIdentity = (next: Identity) => {
    sessionStorage.setItem("active-room-identity", JSON.stringify(next))
    setIdentity(next)
  }

  const leaveRoom = () => {
    sessionStorage.removeItem("active-room-identity")
    setIdentity(null)
    setRoom(null)
    setPage("setup")
  }

  return (
    <Shell muted={muted} setMuted={setMuted} onHome={page === "room" ? undefined : page === "admin" ? () => window.location.assign("/") : () => setPage("hall")}>
      {page === "hall" && <Hall onEnter={() => setPage("setup")} />}
      {page === "setup" && <Setup onBack={() => setPage("hall")} onEntered={enterRoom} notify={notify} />}
      {page === "room" && identity && (room
        ? <RoomPage identity={identity} initialRoom={room} onLeft={leaveRoom} onIdentityChange={updateIdentity} notify={notify} />
        : <RoomBootstrap identity={identity} onReady={(nextRoom) => setRoom(nextRoom)} onFail={leaveRoom} />)}
      {page === "admin" && <AdminPage notify={notify} />}
      {toast && <div className={`toast ${toast.kind}`}><span>{toast.kind === "error" ? "!" : "✓"}</span>{toast.message}</div>}
    </Shell>
  )
}

function RoomBootstrap({ identity, onReady, onFail }: { identity: Identity; onReady: (room: RoomView) => void; onFail: () => void }) {
  useEffect(() => {
    let active = true
    api.state(identity).then((result) => {
      if (active) onReady(result.room)
    }).catch(() => {
      if (active) onFail()
    })
    return () => { active = false }
  }, [identity, onFail, onReady])
  return <main className="loading-page"><span className="shuffle-loader">♠</span><h2>正在回到牌桌…</h2><p>正在恢复你的临时身份和房间状态</p></main>
}
