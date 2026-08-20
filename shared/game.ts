import type { Card, Combo, ComboType } from "./types"

const suits: Card["suit"][] = ["spade", "heart", "club", "diamond"]

export function createDeck(): Card[] {
  const deck: Card[] = []
  for (let rank = 3; rank <= 15; rank += 1) {
    for (const suit of suits) deck.push({ id: `${rank}-${suit}`, rank, suit })
  }
  deck.push({ id: "16-joker", rank: 16, suit: "joker" })
  deck.push({ id: "17-joker", rank: 17, suit: "joker" })
  return deck
}

function secureRandom(): number {
  const values = new Uint32Array(1)
  crypto.getRandomValues(values)
  return values[0] / 0x1_0000_0000
}

export function shuffledDeck(random = secureRandom): Card[] {
  const deck = createDeck()
  for (let index = deck.length - 1; index > 0; index -= 1) {
    const target = Math.floor(random() * (index + 1))
    ;[deck[index], deck[target]] = [deck[target], deck[index]]
  }
  return deck
}

export function dealCards(playerIds: string[], random = secureRandom) {
  if (![2, 3, 4].includes(playerIds.length)) throw new Error("斗地主仅支持 2～4 名玩家")
  const bottomCount = playerIds.length === 3 ? 3 : 2
  const deck = shuffledDeck(random)
  const bottomCards = deck.splice(deck.length - bottomCount, bottomCount)
  const hands: Record<string, Card[]> = Object.fromEntries(playerIds.map((id) => [id, []]))
  deck.forEach((card, index) => hands[playerIds[index % playerIds.length]].push(card))
  Object.values(hands).forEach(sortCards)
  return { hands, bottomCards: sortCards(bottomCards) }
}

export function sortCards<T extends Card[]>(cards: T): T {
  cards.sort((left, right) => left.rank - right.rank || left.suit.localeCompare(right.suit))
  return cards
}

function groups(cards: Card[]) {
  const result = new Map<number, Card[]>()
  for (const card of cards) {
    const group = result.get(card.rank) ?? []
    group.push(card)
    result.set(card.rank, group)
  }
  return result
}

function consecutive(ranks: number[]) {
  return ranks.every((rank, index) => index === 0 || rank === ranks[index - 1] + 1)
}

function combo(type: ComboType, rank: number, length: number, chain = 1): Combo {
  return { type, rank, length, chain }
}

export function analyzeCombo(input: Card[]): Combo | null {
  const cards = sortCards([...input])
  const length = cards.length
  if (!length) return null
  const byRank = groups(cards)
  const entries = [...byRank.entries()].sort(([left], [right]) => left - right)
  const counts = entries.map(([, value]) => value.length)
  const ranks = entries.map(([rank]) => rank)

  if (length === 2 && ranks[0] === 16 && ranks[1] === 17) return combo("rocket", 17, 2)
  if (entries.length === 1) {
    if (length === 1) return combo("single", ranks[0], 1)
    if (length === 2) return combo("pair", ranks[0], 2)
    if (length === 3) return combo("triple", ranks[0], 3)
    if (length === 4) return combo("bomb", ranks[0], 4)
  }

  if (length === 4 && counts.includes(3)) {
    const triple = entries.find(([, value]) => value.length === 3)!
    return combo("triple-single", triple[0], 4)
  }
  if (length === 5 && counts.includes(3) && counts.includes(2)) {
    const triple = entries.find(([, value]) => value.length === 3)!
    return combo("triple-pair", triple[0], 5)
  }
  if (length >= 5 && counts.every((count) => count === 1) && ranks.at(-1)! < 15 && consecutive(ranks)) {
    return combo("straight", ranks.at(-1)!, length, length)
  }
  if (length >= 6 && length % 2 === 0 && counts.every((count) => count === 2) && ranks.at(-1)! < 15 && consecutive(ranks)) {
    return combo("pair-straight", ranks.at(-1)!, length, ranks.length)
  }
  if (length === 6 && counts.includes(4)) {
    const four = entries.find(([, value]) => value.length === 4)!
    return combo("four-two-single", four[0], 6)
  }
  if (length === 8 && counts.includes(4)) {
    const four = entries.find(([, value]) => value.length === 4)!
    const wings = entries.filter(([rank]) => rank !== four[0])
    if (wings.length === 2 && wings.every(([, value]) => value.length === 2)) {
      return combo("four-two-pair", four[0], 8)
    }
  }

  const tripleRanks = entries.filter(([rank, value]) => rank < 15 && value.length >= 3).map(([rank]) => rank)
  for (let chain = tripleRanks.length; chain >= 2; chain -= 1) {
    for (let start = 0; start <= tripleRanks.length - chain; start += 1) {
      const run = tripleRanks.slice(start, start + chain)
      if (!consecutive(run)) continue
      const main = new Set(run)
      const remainder = entries.flatMap(([rank, value]) => main.has(rank) ? value.slice(3) : value)
      if (remainder.some((card) => main.has(card.rank))) continue
      if (remainder.length === 0 && length === chain * 3) {
        return combo("airplane", run.at(-1)!, length, chain)
      }
      if (remainder.length === chain && length === chain * 4) {
        return combo("airplane-single", run.at(-1)!, length, chain)
      }
      const wingGroups = groups(remainder)
      if (remainder.length === chain * 2 && length === chain * 5 && [...wingGroups.values()].every((value) => value.length === 2)) {
        return combo("airplane-pair", run.at(-1)!, length, chain)
      }
    }
  }
  return null
}

export function canBeat(next: Combo, previous: Combo | null): boolean {
  if (!previous) return true
  if (next.type === "rocket") return previous.type !== "rocket"
  if (previous.type === "rocket") return false
  if (next.type === "bomb" && previous.type !== "bomb") return true
  if (next.type !== previous.type || next.length !== previous.length || next.chain !== previous.chain) return false
  return next.rank > previous.rank
}

function take(group: Card[] | undefined, count: number) {
  return group && group.length >= count ? group.slice(0, count) : null
}

function smallestGroups(hand: Card[], count: number, above = 2, exclude = new Set<number>()) {
  return [...groups(hand).entries()]
    .filter(([rank, cards]) => rank > above && cards.length >= count && !exclude.has(rank))
    .sort(([left], [right]) => left - right)
}

function findSequence(hand: Card[], count: number, chain: number, above: number): Card[] | null {
  const candidates = smallestGroups(hand, count, 2).filter(([rank]) => rank < 15)
  for (let index = 0; index <= candidates.length - chain; index += 1) {
    const run = candidates.slice(index, index + chain)
    const ranks = run.map(([rank]) => rank)
    if (ranks.at(-1)! > above && consecutive(ranks)) return run.flatMap(([, cards]) => cards.slice(0, count))
  }
  return null
}

export function findSuggestedPlay(hand: Card[], previous: Combo | null): Card[] | null {
  const byRank = groups(sortCards([...hand]))
  if (!previous) return [sortCards([...hand])[0]]
  let result: Card[] | null = null
  const simple = (count: number) => smallestGroups(hand, count, previous.rank)[0]?.[1].slice(0, count) ?? null

  if (previous.type === "single") result = simple(1)
  if (previous.type === "pair") result = simple(2)
  if (previous.type === "triple") result = simple(3)
  if (previous.type === "straight") result = findSequence(hand, 1, previous.chain, previous.rank)
  if (previous.type === "pair-straight") result = findSequence(hand, 2, previous.chain, previous.rank)
  if (previous.type === "triple-single" || previous.type === "triple-pair") {
    const triple = smallestGroups(hand, 3, previous.rank)[0]
    if (triple) {
      const wingCount = previous.type === "triple-pair" ? 2 : 1
      const wing = smallestGroups(hand, wingCount, 2, new Set([triple[0]]))[0]
      if (wing) result = [...triple[1].slice(0, 3), ...wing[1].slice(0, wingCount)]
    }
  }
  if (previous.type === "bomb") result = smallestGroups(hand, 4, previous.rank)[0]?.[1].slice(0, 4) ?? null
  if (result && canBeat(analyzeCombo(result)!, previous)) return sortCards(result)

  if (previous.type !== "rocket" && previous.type !== "bomb") {
    const bomb = smallestGroups(hand, 4, 2)[0]
    if (bomb) return bomb[1].slice(0, 4)
  }
  if (byRank.has(16) && byRank.has(17)) return [byRank.get(16)![0], byRank.get(17)![0]]
  return null
}

export function cardLabel(rank: number) {
  if (rank <= 10) return String(rank)
  if (rank === 11) return "J"
  if (rank === 12) return "Q"
  if (rank === 13) return "K"
  if (rank === 14) return "A"
  if (rank === 15) return "2"
  if (rank === 16) return "小王"
  return "大王"
}

export function comboLabel(type: ComboType) {
  const labels: Record<ComboType, string> = {
    single: "单牌",
    pair: "对子",
    triple: "三张",
    "triple-single": "三带一",
    "triple-pair": "三带二",
    straight: "顺子",
    "pair-straight": "连对",
    airplane: "飞机",
    "airplane-single": "飞机带单",
    "airplane-pair": "飞机带对",
    "four-two-single": "四带二",
    "four-two-pair": "四带两对",
    bomb: "炸弹",
    rocket: "王炸",
  }
  return labels[type]
}
