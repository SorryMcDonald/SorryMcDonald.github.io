export type Suit = "spade" | "heart" | "club" | "diamond" | "joker"

export interface Card {
  id: string
  rank: number
  suit: Suit
}

export type ComboType =
  | "single"
  | "pair"
  | "triple"
  | "triple-single"
  | "triple-pair"
  | "straight"
  | "pair-straight"
  | "airplane"
  | "airplane-single"
  | "airplane-pair"
  | "four-two-single"
  | "four-two-pair"
  | "bomb"
  | "rocket"

export interface Combo {
  type: ComboType
  rank: number
  length: number
  chain: number
}

export type RoomStatus = "waiting" | "bidding" | "doubling" | "playing" | "finished"
export type GameType = "doudizhu" | "wuziqi" | "draw" | "uno"
export type PlayerRole = "landlord" | "farmer" | null

export interface Player {
  id: string
  tokenHash: string
  nickname: string
  seat: number
  beans: number
  ready: boolean
  role: PlayerRole
  double: 1 | 2 | 4
  left: boolean
  controlledByBot: boolean
  joinedAt: number
}

export interface Spectator {
  id: string
  tokenHash: string
  nickname: string
  joinedAt: number
}

export interface BidState {
  mode: "call" | "rob"
  actingSeat: number
  pendingSeats: number[]
  declinedSeats: number[]
  candidateSeat: number | null
  redeals: number
}

export interface PlayRecord {
  id: string
  playerId: string
  nickname: string
  cards: Card[]
  combo: Combo | null
  passed: boolean
  at: number
}

export interface SettlementItem {
  playerId: string
  nickname: string
  role: Exclude<PlayerRole, null>
  delta: number
  balance: number
}

export interface GameResult {
  winner: "landlord" | "farmer"
  spring: "spring" | "anti-spring" | null
  multiplier: number
  items: SettlementItem[]
}

export interface GameState {
  roundId: string
  phase: Exclude<RoomStatus, "waiting">
  hands: Record<string, Card[]>
  bottomCards: Card[]
  bottomRevealed: boolean
  landlordPlayerId: string | null
  currentSeat: number
  bid: BidState | null
  pendingDoubleSeats: number[]
  publicMultiplier: number
  lastPlay: PlayRecord | null
  trickLeaderId: string | null
  history: PlayRecord[]
  nonPassPlays: Record<string, number>
  deadlineAt: number
  result: GameResult | null
}

export interface Room {
  id: string
  gameType?: GameType
  dissolved?: boolean
  version: number
  maxPlayers: 2 | 3 | 4
  baseScore: 10 | 50 | 100 | 200 | 500 | 1000
  passwordSalt: string | null
  passwordHash: string | null
  hostPlayerId: string
  status: RoomStatus
  players: Player[]
  spectators: Spectator[]
  game: GameState | null
  createdAt: number
  updatedAt: number
  emptySince: number | null
}

export interface PublicPlayer {
  id: string
  nickname: string
  seat: number
  beans: number
  ready: boolean
  role: PlayerRole
  double: 1 | 2 | 4
  left: boolean
  controlledByBot: boolean
  cardCount: number
}

export interface PublicSpectator {
  id: string
  nickname: string
}

export interface PublicGameState extends Omit<GameState, "hands"> {
  myHand: Card[]
}

export interface RoomView {
  id: string
  version: number
  maxPlayers: number
  baseScore: number
  hasPassword: boolean
  hostPlayerId: string
  status: RoomStatus
  players: PublicPlayer[]
  spectators: PublicSpectator[]
  game: PublicGameState | null
  viewer: {
    id: string
    kind: "player" | "spectator"
  }
  updatedAt: number
}

export interface RoomSummary {
  id: string
  maxPlayers: number
  playerCount: number
  spectatorCount: number
  baseScore: number
  hasPassword: boolean
  status: RoomStatus
  hostNickname: string
  updatedAt: number
}

export interface Identity {
  roomId: string
  id: string
  token: string
  kind: "player" | "spectator"
}

export interface AdminMemberView {
  id: string
  kind: "player" | "spectator"
  nickname: string
  seat: number | null
  beans: number | null
  ready: boolean
  role: PlayerRole
  left: boolean
  controlledByBot: boolean
  joinedAt: number
}

export interface AdminRoomView {
  id: string
  gameType: GameType
  status: RoomStatus
  maxPlayers: number
  baseScore: number
  hasPassword: boolean
  hostPlayerId: string
  members: AdminMemberView[]
  publicMultiplier: number
  roundId: string | null
  createdAt: number
  updatedAt: number
  version: number
}
