import type { Card } from "../../shared/types"
import { cardLabel } from "../../shared/game"

const suitSymbol = {
  spade: "♠",
  heart: "♥",
  club: "♣",
  diamond: "♦",
  joker: "★",
}

export function PlayingCard({ card, selected = false, small = false, hidden = false, onClick }: {
  card?: Card
  selected?: boolean
  small?: boolean
  hidden?: boolean
  onClick?: () => void
}) {
  if (hidden || !card) return <div className={`playing-card card-back ${small ? "small" : ""}`} aria-label="未公开的牌"><span>好运</span></div>
  const red = card.suit === "heart" || card.suit === "diamond" || card.rank === 17
  const joker = card.rank > 15
  return (
    <button
      type="button"
      className={`playing-card ${small ? "small" : ""} ${selected ? "selected" : ""} ${red ? "red" : ""} ${joker ? "joker" : ""}`}
      onClick={onClick}
      aria-pressed={selected}
      aria-label={`${cardLabel(card.rank)}${suitSymbol[card.suit]}`}
    >
      <span className="card-rank">{cardLabel(card.rank)}</span>
      <span className="card-suit">{suitSymbol[card.suit]}</span>
      {joker && <span className="joker-word">JOKER</span>}
    </button>
  )
}
