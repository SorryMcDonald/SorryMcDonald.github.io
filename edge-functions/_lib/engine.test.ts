import { describe, expect, it } from "vitest"
import type { Player, Room } from "../../shared/types"
import { beginGame, bid, chooseDouble, playCards, publicRoom } from "./engine"

function player(seat: number): Player {
  return {
    id: `p${seat}`,
    tokenHash: `hash${seat}`,
    nickname: `玩家${seat + 1}`,
    seat,
    beans: 10000,
    ready: true,
    role: null,
    double: 1,
    left: false,
    controlledByBot: false,
    joinedAt: 1,
  }
}

function room(count = 3, maxPlayers = count): Room {
  return {
    id: "123456",
    version: 1,
    maxPlayers: maxPlayers as 2 | 3 | 4,
    baseScore: 100,
    passwordSalt: null,
    passwordHash: null,
    hostPlayerId: "p0",
    status: "waiting",
    players: Array.from({ length: count }, (_, seat) => player(seat)),
    spectators: [{ id: "watch", tokenHash: "watch-hash", nickname: "观众", joinedAt: 1 }],
    game: null,
    createdAt: 1,
    updatedAt: 1,
    emptySince: null,
  }
}

function finishBidding(target: Room) {
  const first = target.game!.bid!.actingSeat
  bid(target, target.players.find((entry) => entry.seat === first)!, true, 10)
  while (target.status === "bidding") {
    const seat = target.game!.bid!.actingSeat
    bid(target, target.players.find((entry) => entry.seat === seat)!, false, 10)
  }
}

describe("房间牌局状态机", () => {
  it("达到 2 人后可在未坐满人数上限时开局", () => {
    const target = room(2, 4)
    beginGame(target, 0)
    expect(target.status).toBe("bidding")
    expect(Object.values(target.game!.hands)).toHaveLength(2)
  })

  it("少于 2 人时不能开局", () => {
    const target = room(1, 4)
    expect(() => beginGame(target, 0)).toThrow("至少需要 2 名玩家")
  })

  it("完成叫地主与全员加倍后进入出牌", () => {
    const target = room(4)
    beginGame(target, 0)
    expect(target.status).toBe("bidding")
    expect(Object.values(target.game!.hands)).toHaveLength(4)
    finishBidding(target)
    expect(target.status).toBe("doubling")
    for (const entry of target.players) chooseDouble(target, entry, entry.seat === 0 ? 4 : 1, 20)
    expect(target.status).toBe("playing")
    expect(target.players.filter((entry) => entry.role === "landlord")).toHaveLength(1)
  })

  it("服务端视图只向本人返回手牌", () => {
    const target = room(3)
    beginGame(target, 0)
    const playerView = publicRoom(target, "p0")
    const spectatorView = publicRoom(target, "watch")
    expect(playerView.game?.myHand.length).toBeGreaterThan(0)
    expect(spectatorView.game?.myHand).toEqual([])
    expect(JSON.stringify(playerView)).not.toContain('"hands"')
  })

  it("结算欢乐豆保持总量且不出现负数", () => {
    const target = room(2)
    beginGame(target, 0)
    finishBidding(target)
    target.players.forEach((entry) => chooseDouble(target, entry, 4, 20))
    const landlord = target.players.find((entry) => entry.role === "landlord")!
    target.game!.hands[landlord.id] = [{ id: "3-spade", rank: 3, suit: "spade" }]
    const before = target.players.reduce((sum, entry) => sum + entry.beans, 0)
    playCards(target, landlord, ["3-spade"], 30)
    expect(target.status).toBe("finished")
    expect(target.players.reduce((sum, entry) => sum + entry.beans, 0)).toBe(before)
    expect(target.players.every((entry) => entry.beans >= 0)).toBe(true)
  })
})
