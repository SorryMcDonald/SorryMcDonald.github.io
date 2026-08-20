import { useState } from "react"
import { playSound } from "../sound"

const games = [
  { id: "doudizhu", icon: "♠", name: "欢乐斗地主", desc: "叫抢加倍，好友开黑", meta: "2–4 人", active: true, color: "gold" },
  { id: "wuziqi", icon: "●", name: "五子棋", desc: "纵横十九路，一子定胜负", meta: "2 人", active: false, color: "blue" },
  { id: "draw", icon: "✎", name: "你画我猜", desc: "脑洞开场，默契挑战", meta: "3–8 人", active: false, color: "pink" },
  { id: "uno", icon: "U", name: "UNO", desc: "反转、跳过、欢乐加倍", meta: "2–8 人", active: false, color: "red" },
]

export function Hall({ onEnter }: { onEnter: () => void }) {
  const [layout, setLayout] = useState<"horizontal" | "grid">(() => (localStorage.getItem("hall-layout") as "horizontal" | "grid") || "horizontal")
  const changeLayout = (value: "horizontal" | "grid") => {
    setLayout(value)
    localStorage.setItem("hall-layout", value)
    playSound("click")
  }
  return (
    <main className="hall-page">
      <section className="hero">
        <div className="hero-copy">
          <span className="eyebrow">无需注册 · 房间号即刻开玩</span>
          <h1>今晚，<em>好运上桌</em></h1>
          <p>和朋友开一桌轻松的牌局。没有繁琐账号，没有漫长等待，只有刚刚好的快乐。</p>
          <button className="primary-button hero-button" onClick={() => { playSound("join"); onEnter() }}>
            开始斗地主 <span>→</span>
          </button>
        </div>
        <div className="hero-cards" aria-hidden="true">
          <div className="float-card card-a">A<span>♠</span></div>
          <div className="float-card card-k">K<span>♥</span></div>
          <div className="float-card card-joker">JOKER<span>★</span></div>
          <div className="hero-glow" />
        </div>
      </section>

      <section className="game-library">
        <div className="section-heading">
          <div><span className="eyebrow">GAME LIBRARY</span><h2>选择游戏</h2></div>
          <div className="layout-switch" aria-label="切换游戏布局">
            <button className={layout === "horizontal" ? "active" : ""} onClick={() => changeLayout("horizontal")}>▤ <span>卡片</span></button>
            <button className={layout === "grid" ? "active" : ""} onClick={() => changeLayout("grid")}>▦ <span>网格</span></button>
          </div>
        </div>
        <div className={`game-list ${layout}`}>
          {games.map((game) => (
            <button
              key={game.id}
              className={`game-card ${game.color} ${game.active ? "active-game" : "disabled"}`}
              onClick={game.active ? () => { playSound("join"); onEnter() } : undefined}
              disabled={!game.active}
            >
              <span className="game-art"><b>{game.icon}</b><i /></span>
              <span className="game-info"><strong>{game.name}</strong><small>{game.desc}</small></span>
              <span className="game-meta">{game.active ? <><i className="live-dot" /> 可游玩</> : "即将开放"}<small>{game.meta}</small></span>
              {game.active && <span className="game-arrow">→</span>}
            </button>
          ))}
        </div>
      </section>
      <footer className="hall-footer"><span>公平娱乐 · 拒绝现金交易</span><span>由 EdgeOne Makers 提供动力</span></footer>
    </main>
  )
}
