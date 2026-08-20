import { describe, expect, it } from "vitest"
import { analyzeCombo, canBeat, createDeck, dealCards } from "./game"
import type { Card, Suit } from "./types"

const cards = (...ranks: number[]): Card[] => ranks.map((rank, index) => ({
  id: `${rank}-${index}`,
  rank,
  suit: (rank > 15 ? "joker" : "spade") as Suit,
}))

describe("斗地主牌型", () => {
  it("生成完整牌组", () => expect(createDeck()).toHaveLength(54))
  it("识别基础与特殊牌型", () => {
    expect(analyzeCombo(cards(7, 7))?.type).toBe("pair")
    expect(analyzeCombo(cards(9, 9, 9, 3))?.type).toBe("triple-single")
    expect(analyzeCombo(cards(3, 4, 5, 6, 7))?.type).toBe("straight")
    expect(analyzeCombo(cards(6, 6, 6, 6))?.type).toBe("bomb")
    expect(analyzeCombo(cards(16, 17))?.type).toBe("rocket")
  })
  it("识别飞机带翅膀", () => {
    expect(analyzeCombo(cards(3, 3, 3, 4, 4, 4))?.type).toBe("airplane")
    expect(analyzeCombo(cards(3, 3, 3, 4, 4, 4, 8, 9))?.type).toBe("airplane-single")
  })
  it("比较牌型", () => {
    expect(canBeat(analyzeCombo(cards(8, 8))!, analyzeCombo(cards(7, 7))!)).toBe(true)
    expect(canBeat(analyzeCombo(cards(3, 3, 3, 3))!, analyzeCombo(cards(14))!)).toBe(true)
  })
})

describe("多人发牌", () => {
  it.each([
    [2, 26, 2],
    [3, 17, 3],
    [4, 13, 2],
  ])("%i 人发牌", (count, handSize, bottomSize) => {
    const ids = Array.from({ length: count }, (_, index) => `p${index}`)
    const result = dealCards(ids, () => 0.42)
    expect(result.bottomCards).toHaveLength(bottomSize)
    ids.forEach((id) => expect(result.hands[id]).toHaveLength(handSize))
  })
})
