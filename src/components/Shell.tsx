import type { ReactNode } from "react"
import { isMuted, playSound, toggleMuted } from "../sound"

export function Shell({ children, onHome, muted, setMuted }: {
  children: ReactNode
  onHome?: () => void
  muted: boolean
  setMuted: (value: boolean) => void
}) {
  return (
    <div className="app-shell">
      <header className="topbar">
        <button className="brand" onClick={() => { playSound("click"); onHome?.() }} aria-label="返回游戏大厅">
          <span className="brand-mark">♠</span>
          <span><b>好运</b><small>游戏厅</small></span>
        </button>
        <div className="topbar-actions">
          <span className="online-pill"><i /> EdgeOne 在线</span>
          <button className="icon-button" onClick={() => setMuted(toggleMuted())} aria-label={muted ? "开启声音" : "关闭声音"}>
            {isMuted() ? "🔇" : "🔊"}
          </button>
        </div>
      </header>
      {children}
    </div>
  )
}
