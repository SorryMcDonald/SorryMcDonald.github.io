# Zhajinhua Gameplay Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved six-seat, hidden-card, multi-round Zhajinhua experience with lifecycle control, chat, manual refill, three leaderboards, responsive UI, automated coverage, GitHub publication, and rollback-safe production deployment.

**Architecture:** Keep `RoomService` as the deterministic state machine, add a per-room `RoomLifecycleController` for timers and connection-driven changes, and keep `WebSocketGateway` as an authenticated transport. Derive visibility and titles on the server, persist only durable room state, and keep chat and timers in memory. Exercise the same public HTTP/WSS surface from Vitest and Playwright before promoting the exact tested Git revision.

**Tech Stack:** Node.js 22, Fastify 5, PostgreSQL, `ws`, Vitest 3, Playwright, vanilla HTML/CSS/JavaScript, Nginx, Docker Compose.

## 2026-08-20 Release Corrections

The following rules supersede any conflicting command or wording later in this historical plan:

1. Production is the single `app` process in Compose plus PostgreSQL. The split API/WebSocket/Worker systemd examples are deprecated and must not be installed or enabled.
2. Bind the release to the SHA-256 values of `004_animation_mode_disabled.sql`, `005_texas_schema.sql`, `006_texas_indexes.sql`, and `deploy/verify-schema.sql`. Persist those hashes, a deterministic migration-bundle hash, and pre/post schema-receipt hashes in the recovery manifest.
3. After restoring the production dump into the isolated candidate database, but before starting the candidate app, execute `004 -> 005 -> 006` with `psql -X -v ON_ERROR_STOP=1 --single-transaction`, then execute `deploy/verify-schema.sql`. A schema assertion or real database Texas flow failure blocks promotion.
4. After the verified production backup and immediately before switching the application symlink, execute the same hash-bound migration bundle against production in one transaction and run the same schema assertions. This is a schema-forward migration: ordinary application rollback preserves the new tables and relaxed animation constraint. Restoring the dump is a separate, manually approved downtime disaster-recovery action because it would discard post-release writes.
5. Derive the six shared AI Nginx configuration sources from the read-only bind mounts of `ai-platform-domestic-nginx-1`; do not search an assumed host directory. The shared Nginx and Cloudflared projects are never recreated or reloaded by this release.
6. Treat `/healthz` only as liveness. Readiness requires the schema assertions and an authenticated database-backed Texas create/join/start/leave flow.
7. Split ingress validation into a server-local SNI/TLS probe using `--resolve crazythursdayplay.bbroot.com:443:127.0.0.1` and an independent external Browser HTTPS/WSS probe. Server hairpin failure is not a public availability result.
8. A pre-existing shared AI monitor failure requires either recovery by the owning platform or an explicit human approval to use a captured no-regression baseline. This application release must not alter shared AI configuration to clear that gate.

---

## File Map

- Create `server/src/rooms/lifecycle.js`: serialize room mutations, schedule action deadlines, track WebSocket connection counts, disconnect grace periods, and reclaim empty rooms.
- Create `server/src/leaderboard/ranking.js`: rank wealth/wins/losses, derive multi-title arrays, and detect leaderboard leader changes.
- Modify `server/src/game/rules.js`: validate raise tiers, calculate seen/unseen costs, count betting rounds, and determine forced settlement.
- Modify `server/src/game/events.js`: enforce per-viewer card visibility and sanitize compare events.
- Modify `server/src/rooms/service.js`: implement six seats, hidden cards, non-advancing see/reveal, multi-round betting, manual compare targets, chat, and deterministic settlement.
- Modify `server/src/rooms/routes.js`: route every mutation through lifecycle serialization and add room chat.
- Modify `server/src/ws/gateway.js`: lifecycle connection callbacks, ping/pong, filtered room events, and chat transport errors.
- Modify `server/src/persistence/runtime-state.js`: persist new durable round fields while excluding chat and timer state.
- Modify `server/src/runtime.js` and `server/src/app.js`: construct and restore the lifecycle controller.
- Modify `server/src/auth/routes.js`: include server-derived `titles` in account responses.
- Modify `server/src/leaderboard/routes.js`: expose wealth/wins/losses and require exact refill confirmation text.
- Modify `public/index.html`, `public/app.js`, and `public/styles.css`: render rotated seats, countdown, raise/compare/reveal/refill/chat controls, effects, and three leaderboard tabs in the approved original visual language.
- Create `server/scripts/e2e-server.js`, `server/playwright.config.js`, and `server/e2e/gameplay.spec.js`: real browser flows against an isolated in-memory server.
- Create `server/tests/lifecycle.test.js`, `server/tests/ws-integration.test.js`, and `server/tests/blackbox.test.js`; extend existing room, economy, leaderboard, visibility, persistence, and client-contract tests.
- Modify `server/package.json` and `server/package-lock.json`: add Playwright scripts and the pinned test dependency.
- Create `work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/intent.md`, validation evidence, review evidence, release record, and result document.

### Task 1: Establish the Remote Baseline and Test Gate

**Files:**
- Modify: `.gitignore`
- Create: `.git/` metadata tracking `origin/huang`
- Test: existing `server/tests/*.test.js`

- [ ] **Step 1: Initialize Git against the approved branch without changing working files**

```powershell
git init
git remote add origin https://github.com/SorryMcDonald/SorryMcDonald.github.io.git
git fetch origin huang
git branch huang origin/huang
git symbolic-ref HEAD refs/heads/huang
git read-tree origin/huang
```

Expected: `git status --short` shows only local differences from `origin/huang`; `main` is never checked out or modified.

- [ ] **Step 2: Run the untouched baseline**

Run: `npm test -- --run` from `server/`.

Expected: `25 passed` with exit code 0.

- [ ] **Step 3: Protect local-only material**

```gitignore
server/.env
server/node_modules/
work-flow/config.local.json
work-flow/.runtime/*
!work-flow/.runtime/migration-backups/
!work-flow/.runtime/transactions/
!work-flow/.runtime/worker-results/
```

- [ ] **Step 4: Commit the adopted workflow separately**

```powershell
git add .gitignore AGENTS.md work-flow
git commit -m "chore(workflow): 接入项目工作流"
```

Expected: the commit contains no `.env`, key, password, session, database, log, cache, or `node_modules` file.

### Task 2: Add Deterministic Betting and Ranking Rules

**Files:**
- Create: `server/src/leaderboard/ranking.js`
- Modify: `server/src/game/rules.js`
- Modify: `server/tests/rules.test.js`
- Modify: `server/tests/leaderboard.test.js`

- [ ] **Step 1: Write failing rule tests**

```js
it('charges seen players twice the base action cost', () => {
  expect(actionCost({ level: 20, seen: false, action: 'call' })).toBe(20);
  expect(actionCost({ level: 20, seen: true, action: 'call' })).toBe(40);
  expect(actionCost({ level: 20, seen: false, action: 'compare' })).toBe(40);
  expect(actionCost({ level: 20, seen: true, action: 'compare' })).toBe(80);
});

it('accepts only safe raises above the current base level', () => {
  expect(validateRaise({ amount: 50, ante: 10, level: 20, balance: 100, seen: false })).toBe(50);
  expect(() => validateRaise({ amount: 20, ante: 10, level: 20, balance: 100, seen: false })).toThrow(/高于/);
  expect(() => validateRaise({ amount: 20.5, ante: 10, level: 20, balance: 100, seen: false })).toThrow(/整数/);
});
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/rules.test.js tests/leaderboard.test.js`.

Expected: FAIL because `actionCost`, `validateRaise`, `rankUsersBy`, and `resolveUserTitles` do not satisfy the new contracts.

- [ ] **Step 3: Implement the pure contracts**

```js
export function actionCost({ level, seen = false, action }) {
  const base = requirePositiveInteger(level, '下注档位');
  const actionMultiplier = action === 'compare' ? 2 : 1;
  return base * actionMultiplier * (seen ? 2 : 1);
}

export function validateRaise({ amount, level, balance, seen = false }) {
  const base = requirePositiveInteger(amount, '加注金额');
  if (base <= level) throw Object.assign(new Error('加注档位必须高于当前档位'), { statusCode: 400 });
  const charge = base * (seen ? 2 : 1);
  if (!Number.isSafeInteger(charge) || charge > balance) throw Object.assign(new Error('下注豆子不足'), { statusCode: 400 });
  return charge;
}
```

```js
export function rankUsersBy(users, kind) {
  const key = kind === 'wealth' ? 'beans' : kind;
  return [...users].sort((a, b) => Number(b[key] ?? 0) - Number(a[key] ?? 0)
    || String(a.nickname).localeCompare(String(b.nickname), 'zh-CN')
    || String(a.id).localeCompare(String(b.id)));
}
```

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- --run tests/rules.test.js tests/leaderboard.test.js`.

Expected: PASS.

```powershell
git add server/src/game/rules.js server/src/leaderboard/ranking.js server/tests/rules.test.js server/tests/leaderboard.test.js
git commit -m "feat(game): 增加下注和称号规则"
```

### Task 3: Rebuild the Authoritative Room State Machine

**Files:**
- Modify: `server/src/rooms/service.js`
- Modify: `server/src/game/events.js`
- Modify: `server/tests/rooms.test.js`
- Modify: `server/tests/economy.test.js`

- [ ] **Step 1: Write failing six-seat, hidden-card, and non-advancing action tests**

```js
expect(directory.json().rooms[0].maxPlayers).toBe(6);
expect(started.room.players.find((p) => p.userId === first.id)).toMatchObject({ seen: false, cardCount: 3 });
expect(started.room.players.find((p) => p.userId === first.id)).not.toHaveProperty('cards');

const seen = service.action(room.id, first.id, { action: 'see' });
expect(seen.currentTurn).toBe(firstSeat);
expect(seen.players.get(firstPlayerId).actionSeq).toBe(0);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/rooms.test.js tests/economy.test.js`.

Expected: FAIL on `maxPlayers`, unauthorized cards, and see advancing or requiring the turn sequence.

- [ ] **Step 3: Implement six fixed seats and round fields**

```js
const MAX_SEATS = 6;
room.version = 1;
room.bettingRound = 0;
room.roundActedSeats = [];
room.turnStartedAt = null;
room.turnDeadlineAt = null;
room.messages = [];
```

Each started player is reset with `seen: false`, `revealed: false`, and `mayReveal: false`; a normal snapshot returns `cardCount: 3` and omits `cards` until visibility rules allow them.

- [ ] **Step 4: Write failing multi-round and comparison tests**

```js
for (let round = 0; round < 19; round += 1) {
  advanceEveryActionablePlayerWithCall(service, room);
  expect(room.status).toBe('betting');
}
advanceEveryActionablePlayerWithCall(service, room);
expect(room.status).toBe('settled');

service.action(room.id, attacker.userId, { action: 'compare', targetSeat: target.seat, actionSeq: 1 });
expect(attacker.mayReveal).toBe(true);
expect(target.mayReveal).toBe(true);
expect(room.events.at(-1).payload).not.toHaveProperty('cards');
```

- [ ] **Step 5: Verify RED, then implement advancing and non-advancing branches**

```js
if (type === 'see') return this.see(room, player);
if (type === 'reveal') return this.reveal(room, player);
this.assertTurnAndSequence(room, player, input.actionSeq);
```

Advancing actions append the seat once to `roundActedSeats`; when every still-actionable seat has acted, increment `bettingRound`, clear the set, and settle exactly when the count reaches 20. Comparison uses the explicit target, charges `actionCost`, marks only the loser eliminated/folded, grants both participants reveal rights, and emits card-free start/result events.

- [ ] **Step 6: Verify GREEN and commit**

Run: `npm test -- --run tests/rules.test.js tests/rooms.test.js tests/economy.test.js tests/ws.test.js`.

Expected: PASS with settlement payout equal to side-pot receipts and `net = payout - totalContribution`.

```powershell
git add server/src/rooms/service.js server/src/game/events.js server/tests/rooms.test.js server/tests/economy.test.js server/tests/ws.test.js
git commit -m "feat(rooms): 完善多轮暗牌状态机"
```

### Task 4: Add Lifecycle Serialization, Timeouts, and Reclamation

**Files:**
- Create: `server/src/rooms/lifecycle.js`
- Create: `server/tests/lifecycle.test.js`
- Modify: `server/src/rooms/routes.js`
- Modify: `server/src/runtime.js`
- Modify: `server/src/app.js`

- [ ] **Step 1: Write fake-clock lifecycle tests**

```js
const clock = createFakeClock();
const lifecycle = new RoomLifecycleController({ service, persistence, clock });
lifecycle.restoreRoom(room.id);
clock.advanceBy(60_000);
await lifecycle.idle(room.id);
expect(currentPlayer.folded).toBe(true);

lifecycle.connected(room.id, userId);
lifecycle.connected(room.id, userId);
lifecycle.disconnected(room.id, userId);
clock.advanceBy(60_000);
expect(activePlayer.left).toBe(false);
lifecycle.disconnected(room.id, userId);
clock.advanceBy(59_999);
lifecycle.connected(room.id, userId);
clock.advanceBy(1);
expect(activePlayer.left).toBe(false);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/lifecycle.test.js`.

Expected: FAIL because `RoomLifecycleController` does not exist.

- [ ] **Step 3: Implement the controller API**

```js
export class RoomLifecycleController {
  constructor({ service, persistence, broadcastRoom, clock = systemClock }) {
    this.service = service;
    this.persistence = persistence;
    this.broadcastRoom = broadcastRoom;
    this.clock = clock;
    this.queues = new Map();
    this.turnTimers = new Map();
    this.disconnectTimers = new Map();
    this.connections = new Map();
  }

  run(roomId, mutation) {
    const previous = this.queues.get(roomId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(mutation);
    this.queues.set(roomId, next.finally(() => {
      if (this.queues.get(roomId) === next) this.queues.delete(roomId);
    }));
    return next;
  }
}
```

Every scheduled task captures room ID/version, round ID, current seat, and action sequence; it rechecks all values in the serialized queue. Timeout calls the same fold transition, disconnect expiry calls the same leave transition, reconnect cancels only its departure timer, and an empty room cancels tasks and deletes memory/persisted state.

- [ ] **Step 4: Route HTTP mutations through `lifecycle.run`**

```js
app.post('/api/rooms/:roomId/actions', { preHandler: requireUser }, async (request) =>
  lifecycle.run(request.params.roomId, () => mutateAndBroadcast(request.params.roomId, () =>
    service.action(request.params.roomId, request.user.id, request.body ?? {}))));
```

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- --run tests/lifecycle.test.js tests/rooms.test.js tests/production-runtime.test.js`.

Expected: PASS, including stale-task no-op and one-settlement assertions.

```powershell
git add server/src/rooms/lifecycle.js server/src/rooms/routes.js server/src/runtime.js server/src/app.js server/tests/lifecycle.test.js server/tests/production-runtime.test.js
git commit -m "feat(rooms): 增加超时和断线生命周期"
```

### Task 5: Enforce Persistence and Viewer Visibility

**Files:**
- Modify: `server/src/persistence/runtime-state.js`
- Modify: `server/src/game/events.js`
- Modify: `server/tests/production-runtime.test.js`
- Modify: `server/tests/ws.test.js`

- [ ] **Step 1: Write failing serialization and visibility tests**

```js
const state = serializeRoom(room);
expect(state).not.toHaveProperty('messages');
expect(JSON.stringify(state)).not.toMatch(/timer|connection|disconnect/i);
expect(deserializeRoom(state).messages).toEqual([]);

expect(visibleRoom(room, { userId: ownerId }).players[0]).not.toHaveProperty('cards');
room.players.get(ownerPlayerId).seen = true;
expect(visibleRoom(room, { userId: ownerId }).players[0].cards).toHaveLength(3);
expect(visibleRoom(room, { userId: observerId, spectator: true }).players.every((p) => p.cards.length === 3)).toBe(true);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/production-runtime.test.js tests/ws.test.js`.

Expected: FAIL because chat leaks into serialized state or an unseen owner receives cards.

- [ ] **Step 3: Implement explicit durable serialization**

```js
export function serializeRoom(room) {
  const { messages, ...durable } = room;
  return { ...durable, players: [...room.players.entries()], spectators: [...room.spectators] };
}

export function deserializeRoom(state) {
  return { ...state, players: new Map(state.players ?? []), spectators: new Set(state.spectators ?? []), messages: [] };
}
```

`visibleRoom` exposes actual cards only for spectator, settled round, revealed player, or the requesting owner after `seen`; otherwise it returns `cardCount: 3`. `publicEvent` always strips cards and hand types from comparison events.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- --run tests/production-runtime.test.js tests/ws.test.js tests/rooms.test.js`.

Expected: PASS.

```powershell
git add server/src/persistence/runtime-state.js server/src/game/events.js server/tests/production-runtime.test.js server/tests/ws.test.js server/tests/rooms.test.js
git commit -m "fix(security): 收紧手牌可见性和快照"
```

### Task 6: Add Real WebSocket Lifecycle and Room Chat

**Files:**
- Modify: `server/src/ws/gateway.js`
- Modify: `server/src/rooms/routes.js`
- Create: `server/tests/ws-integration.test.js`
- Modify: `server/tests/ws.test.js`

- [ ] **Step 1: Write failing real-socket tests**

```js
const socket = new WebSocket(`${origin.replace('http', 'ws')}/ws?roomId=${room.id}`, { headers: { cookie } });
await once(socket, 'open');
socket.send(JSON.stringify({ type: 'chat', text: '大家好' }));
expect(await nextMessage(observer)).toMatchObject({ type: 'room_event', event: { eventType: 'chat_message' } });
expect(JSON.stringify(await compareMessage(player))).not.toMatch(/cards|handType|typeName/);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/ws-integration.test.js tests/ws.test.js`.

Expected: FAIL because chat, lifecycle callbacks, and heartbeat cleanup are absent.

- [ ] **Step 3: Implement transport-only gateway behavior**

```js
socket.isAlive = true;
socket.on('pong', () => { socket.isAlive = true; });
lifecycle.connected(roomId, userId);
socket.on('close', () => lifecycle.disconnected(roomId, userId));
```

Room chat trims input, rejects empty/over-120-character messages, enforces one message per second per seated user, keeps the latest 20 items, renders data as plain text, and returns a clear read-only error to spectators. Gateway broadcasts viewer-filtered events and never changes game state directly.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- --run tests/ws-integration.test.js tests/ws.test.js tests/rooms.test.js`.

Expected: PASS with authenticated connect, unauthenticated close code 1008, room isolation, heartbeat, chat, reveal, and compare filtering.

```powershell
git add server/src/ws/gateway.js server/src/rooms/routes.js server/tests/ws-integration.test.js server/tests/ws.test.js
git commit -m "feat(ws): 增加房间聊天和连接管理"
```

### Task 7: Require Manual Refill and Return Three Multi-Title Leaderboards

**Files:**
- Modify: `server/src/leaderboard/routes.js`
- Modify: `server/src/auth/routes.js`
- Modify: `server/src/rooms/service.js`
- Modify: `server/tests/leaderboard.test.js`
- Modify: `server/tests/auth.test.js`

- [ ] **Step 1: Write failing refill-order and title tests**

```js
const wrong = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '不正确' } });
expect(wrong.statusCode).toBe(400);
expect(user.beans).toBe(0);
expect(store.banners).toHaveLength(0);

const correct = await app.inject({ method: 'POST', url: '/api/me/refill', headers: { cookie }, payload: { confirmationText: '黄总是大帅比' } });
expect(correct.json().events.map((item) => item.type).slice(0, 2)).toEqual(['fixed_banner', 'refill']);
expect(store.banners[0].message).toBe('归零：黄总是大帅比！');
expect(user.beans).toBe(100000);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/leaderboard.test.js tests/auth.test.js tests/economy.test.js`.

Expected: FAIL because refill accepts no confirmation text and settlement currently emits the fixed banner automatically.

- [ ] **Step 3: Implement exact refill sequence**

```js
if (request.body?.confirmationText !== '黄总是大帅比') {
  return reply.code(400).send({ error: '确认文字不正确' });
}
const fixed = appendBanner(store, 'economy', `${user.nickname}：黄总是大帅比！`);
user.beans = 100000;
user.last_zero_generation = user.refill_generation;
const rankingBanners = appendRankingChanges(store, beforeRanking, snapshotRanking(store.users.values()));
await persistence?.flushStore(beforeBannerCount);
[fixed, ...rankingBanners].forEach((banner) => app.gateway?.broadcastGlobal(banner));
```

Settlement only marks a new zero-balance generation and never emits or grants refill. `GET /api/leaderboards?kind=wealth|wins|losses`, room snapshots, and `/api/auth/me` all return `titles: string[]`; tied wealth extrema share `大富翁`/`穷乞丐`, while equal balances for everyone produce neither.

- [ ] **Step 4: Verify GREEN and commit**

Run: `npm test -- --run tests/leaderboard.test.js tests/auth.test.js tests/economy.test.js`.

Expected: PASS with exact fixed-banner-before-refill-before-ranking order.

```powershell
git add server/src/leaderboard/ranking.js server/src/leaderboard/routes.js server/src/auth/routes.js server/src/rooms/service.js server/tests/leaderboard.test.js server/tests/auth.test.js server/tests/economy.test.js
git commit -m "feat(economy): 增加手动补豆和三榜称号"
```

### Task 8: Implement the Approved Table UI and Effects

**Files:**
- Modify: `public/index.html`
- Modify: `public/app.js`
- Modify: `public/styles.css`
- Modify: `server/tests/client-contract.test.js`

- [ ] **Step 1: Write failing client-contract assertions**

```js
expect(html).toContain('id="raiseDialog"');
expect(html).toContain('id="compareDialog"');
expect(html).toContain('id="refillDialog"');
expect(html).toContain('id="chatForm"');
expect(js).toContain('function projectSeats');
expect(js).toContain("confirmationText:'黄总是大帅比'");
expect(js).not.toMatch(/players\.find\([^\n]+userId!==state\.user\.id/);
```

- [ ] **Step 2: Verify RED**

Run: `npm test -- --run tests/client-contract.test.js`.

Expected: FAIL because the new dialogs, seat projection, chat, and explicit target selector are absent.

- [ ] **Step 3: Implement stable south-seat projection**

```js
function projectSeats(players, userId) {
  const ordered = [...players].sort((a, b) => a.seat - b.seat);
  const selfIndex = ordered.findIndex((player) => player.userId === userId);
  if (selfIndex < 0) return upperArcPositions(ordered);
  const rotated = [...ordered.slice(selfIndex), ...ordered.slice(0, selfIndex)];
  return rotated.map((player, index) => ({
    player,
    position: index === 0 ? { left: 50, top: 84 } : upperArcPosition(index - 1, rotated.length - 1)
  }));
}
```

The action panel disables advancing commands unless it is the local turn; see and reveal remain separate. Raise uses `1x/2x/5x/10x` base presets plus a positive integer input and live seen/unseen charge preview. Compare requires a clicked legal target. The UI renders countdown danger state, chat, multiple title chips, manual refill, and wealth/wins/losses tabs.

- [ ] **Step 4: Implement the three comparison effect modes**

```js
function playCompareEffect(result) {
  if (state.motionMode === 'disabled') return announceCompare(result);
  document.body.dataset.compareEffect = state.motionMode;
  focusCompareSeats(result.attackerUserId, result.targetUserId);
  if (state.motionMode === 'cinematic') playEffect('compare');
  window.setTimeout(() => announceCompare(result), state.motionMode === 'cinematic' ? 420 : 120);
}
```

Use CSS classes for light focus/result labels and cinematic collision/flash/stamp. Respect the stored effects/music switches and `prefers-reduced-motion`; animation reflects server events and never delays server state.

- [ ] **Step 5: Verify GREEN and commit**

Run: `npm test -- --run tests/client-contract.test.js`.

Expected: PASS.

```powershell
git add public/index.html public/app.js public/styles.css server/tests/client-contract.test.js
git commit -m "feat(ui): 完善牌桌交互和比牌效果"
```

### Task 9: Add API, WSS, Black-Box, and Browser Automation

**Files:**
- Create: `server/tests/blackbox.test.js`
- Create: `server/scripts/e2e-server.js`
- Create: `server/playwright.config.js`
- Create: `server/e2e/gameplay.spec.js`
- Modify: `server/package.json`
- Modify: `server/package-lock.json`

- [ ] **Step 1: Add Playwright and scripts**

```json
{
  "scripts": {
    "test:unit": "vitest run",
    "test:e2e": "playwright test",
    "start:e2e": "node scripts/e2e-server.js"
  },
  "devDependencies": {
    "@playwright/test": "^1.55.0",
    "vitest": "^3.2.4"
  }
}
```

Run: `npm install`.

Expected: lockfile records the Playwright dependency without changing production dependencies.

- [ ] **Step 2: Write the public-surface black-box tests**

```js
it('folds after a real 60 second public API timeout', async () => {
  const runtime = await startBlackBoxServer();
  const room = await createTwoPlayerRound(runtime.origin);
  await waitFor(() => fetchRoom(runtime.origin, room.id, room.secondCookie).then((value) => value.status === 'settled'), 65_000);
});
```

The black-box suite never reads `RoomService` internals. It covers two- and six-player starts, seen double cost, preset/custom raise, manual compare target, reveal/settlement visibility, 20-message retention, one real timeout, reconnect within 60 seconds, disconnect expiry, refill event order, and all three leaderboards.

- [ ] **Step 3: Verify RED, then complete public contracts**

Run: `npm test -- --run tests/blackbox.test.js tests/ws-integration.test.js`.

Expected first run: FAIL on any incomplete public behavior. Implement only the missing behavior in the owning source file, then rerun until PASS.

- [ ] **Step 4: Add browser tests for desktop and mobile**

```js
test('keeps every signed-in player at the south seat and requires a compare target', async ({ browser }) => {
  const first = await browser.newContext();
  const second = await browser.newContext();
  const firstPage = await first.newPage();
  const secondPage = await second.newPage();
  await registerAndCreate(firstPage, 'browser-a@example.test', '浏览器甲');
  await registerAndJoin(secondPage, 'browser-b@example.test', '浏览器乙');
  await expect(firstPage.locator('.player-seat.self')).toHaveCSS('top', /.+/);
  await expect(secondPage.locator('.player-seat.self')).toHaveCSS('top', /.+/);
  await firstPage.getByRole('button', { name: '比牌' }).click();
  await expect(firstPage.getByRole('dialog', { name: '选择比牌对手' })).toBeVisible();
});
```

Add 2/3/6-player layout assertions, hidden-to-seen cards, raise preview, compare effects for all modes, chat/read-only spectator, countdown danger class, three leaderboards, multi-title rendering, and refill dialog error/success.

- [ ] **Step 5: Run the full local gate and commit**

Run: `npm test -- --run`.

Run: `npx playwright install chromium`.

Run: `npm run test:e2e`.

Expected: all unit/white-box/API/WSS/black-box tests and all Chromium browser tests pass.

```powershell
git add server/package.json server/package-lock.json server/scripts/e2e-server.js server/playwright.config.js server/e2e server/tests
git commit -m "test(game): 补全接口和浏览器验收"
```

### Task 10: Review, Publish, Deploy, and Verify Production

**Files:**
- Create: `work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/validation.md`
- Create: `work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/review.md`
- Create: `work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/release.md`
- Create: `work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/result.md`

- [ ] **Step 1: Commit the managed workflow migration, then freeze a clean application commit**

```powershell
$ErrorActionPreference = 'Stop'
function Assert-Native([string]$Label) {
  if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" }
}
$projectRoot = (Get-Location).Path
$stagedBefore = @(git diff --cached --name-only)
Assert-Native 'inspect pre-existing staged paths'
if ($stagedBefore.Count) { throw "pre-existing staged changes are not allowed" }

git add -- work-flow/config.json work-flow/scripts work-flow/tests work-flow/state.md
Assert-Native 'stage managed workflow migration'
$workflowStaged = @(git diff --cached --name-only)
Assert-Native 'inspect workflow staged paths'
if (!$workflowStaged.Count -or @($workflowStaged | Where-Object { $_ -notmatch '^work-flow/(config\.json|scripts/|tests/|state\.md$)' }).Count) {
  throw "workflow commit contains an unexpected path"
}
git diff --cached --check
Assert-Native 'check workflow staged diff'
git commit -m "chore(workflow): 升级项目工作流运行时"
Assert-Native 'commit managed workflow migration'
$workflowSha = (git rev-parse HEAD).Trim()
Assert-Native 'resolve workflow migration SHA'
$workflowFiles = @(git show --pretty=format: --name-only $workflowSha | Where-Object { $_ } | Sort-Object -Unique)
Assert-Native 'read workflow migration file list'
if (!$workflowFiles.Count -or @($workflowFiles | Where-Object { $_ -notmatch '^work-flow/(config\.json|scripts/|tests/|state\.md$)' }).Count) {
  throw "workflow commit file list is outside the approved boundary"
}

$stagedAfterWorkflow = @(git diff --cached --name-only)
Assert-Native 'inspect staging area after workflow commit'
if ($stagedAfterWorkflow.Count) { throw "staging area is not empty before application staging" }
git add -- public server docs/superpowers/plans/2026-08-19-zhajinhua-gameplay-closure-plan.md
Assert-Native 'stage application paths'
$applicationStaged = @(git diff --cached --name-only)
Assert-Native 'inspect application staged paths'
if (!$applicationStaged.Count -or @($applicationStaged | Where-Object { $_ -notmatch '^(public/|server/|docs/superpowers/plans/2026-08-19-zhajinhua-gameplay-closure-plan\.md$)' }).Count) {
  throw "application commit contains an unexpected path"
}
git diff --cached --check
Assert-Native 'check application staged diff'
git commit -m "fix(game): 完善牌局体验与生命周期"
Assert-Native 'commit application patch'
$statusAfterCommit = @(git status --porcelain=v1 --untracked-files=all)
Assert-Native 'inspect worktree after application commit'
$unexpected = @($statusAfterCommit | Where-Object { $_ -notmatch '^ D (\.bundle|Gemfile|Gemfile\.lock|LICENSE|README\.md|_config\.yml|_layouts/|_posts/|apocalypse_survival\.html|assets/|blog\.md|game\.md|index\.md|vendor/)' })
if ($unexpected.Count) { throw "unexpected worktree changes remain" }
$testedSha = (git rev-parse HEAD).Trim()
Assert-Native 'resolve tested SHA'
```

Expected: the managed workflow runtime migration is one scoped commit and the application patch is a separate immutable commit. The intentionally deleted personal-site files stay unstaged and are excluded from the application archive; every other tracked, staged, or untracked change blocks validation.

- [ ] **Step 2: Validate the exact frozen SHA**

Create a clean detached worktree outside the repository from `$testedSha`, install with the committed lockfile, and run the application gates there. The managed workflow intentionally depends on ignored machine-local `config.local.json`, `.runtime` state, and the original workspace identity, so its strict validation runs separately in the original workspace and is recorded as control-plane evidence rather than evidence about the detached application tree:

```powershell
function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory)][string]$FilePath,
    [Parameter(Mandatory)][string[]]$Arguments,
    [Parameter(Mandatory)][int]$TimeoutSeconds,
    [Parameter(Mandatory)][string]$Description
  )
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = $FilePath
  $start.UseShellExecute = $false
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (!$process.Start()) { throw "failed to start $Description" }
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "$Description exceeded ${TimeoutSeconds}s deadline"
  }
  if ($process.ExitCode -ne 0) { throw "$Description failed with exit code $($process.ExitCode)" }
}

$npm = (Get-Command npm.cmd -ErrorAction Stop).Source
$node = (Get-Command node.exe -ErrorAction Stop).Source
$validationRoot = Join-Path $env:TEMP "zhajinhua-validation-$($testedSha.Substring(0,12))"
if (Test-Path -LiteralPath $validationRoot) { throw "validation root already exists: $validationRoot" }
git worktree add --detach $validationRoot $testedSha
Assert-Native 'create detached validation worktree'
try {
  Push-Location (Join-Path $validationRoot 'server')
  Invoke-BoundedProcess $npm @('ci') 600 'install locked dependencies'
  Invoke-BoundedProcess $npm @('test', '--', '--run') 300 'run Vitest suite'
  Invoke-BoundedProcess $npm @('run', 'test:e2e') 600 'run Playwright suite'
  Invoke-BoundedProcess $npm @('audit', '--omit=dev') 180 'run production dependency audit'
  Get-ChildItem src -Recurse -Filter *.js | ForEach-Object {
    Invoke-BoundedProcess $node @('--check', $_.FullName) 15 "syntax check $($_.FullName)"
  }
} finally {
  Pop-Location
}
git -C $validationRoot diff --check
Assert-Native 'check detached worktree diff'
$validationSha = (git -C $validationRoot rev-parse HEAD).Trim()
Assert-Native 'read detached validation SHA'
if ($validationSha -ne $testedSha) { throw "validation SHA drift" }
$validationStatus = @(git -C $validationRoot status --porcelain=v1 --untracked-files=all)
Assert-Native 'inspect detached validation status'
if ($validationStatus.Count) { throw "validation tree changed" }

Push-Location $projectRoot
try {
  pwsh.exe -File "work-flow/scripts/Invoke-ProjectWorkflow.ps1" validate --root $projectRoot --strict --json
  Assert-Native 'run strict workflow validation in the original workspace'
} finally {
  Pop-Location
}
```

Expected: Vitest, Playwright, production audit, and syntax checks exit 0 against the same `$testedSha`; the detached validation tree remains clean. The original workspace separately passes strict workflow validation with its machine-local control-plane files present. Do not copy or commit `config.local.json`, operation locks, or `.runtime` material into the detached tree.

- [ ] **Step 3: Perform focused code and L4 risk reviews, plus CodeRabbit when available**

Independently review card secrecy, integer economy mutations, idempotent settlement/refill, stale timers, room reclamation, XSS-safe chat, credential hygiene, deployment rollback, and unchanged AI platform proxy routes. CodeRabbit is an additional check, not a substitute for the required local code review and L4 risk review. When the authenticated CLI completes, record its exact issue count and disposition; when authentication, quota, network, or service availability blocks it, record `CodeRabbit: unavailable` with the exact error and do not represent the independent review as CodeRabbit output. A successful CodeRabbit run with an unresolved blocking issue still blocks release, while external unavailability alone does not erase the two independent required reviews.

- [ ] **Step 4: Verify the frozen SHA with the Browser plugin**

Start the detached validation worktree and, at desktop and mobile viewports, verify page identity, nonblank DOM, no framework overlay, console health, registration, room create/join/start, self south seat, card backs, see, raise, compare target, chat, leaderboard navigation, and refill dialog. Save screenshots outside the repository. Recheck the detached tree SHA and cleanliness after Browser acceptance.

- [ ] **Step 5: Create the immutable archive and obtain the post-validation L4 release confirmation**

Create the archive locally before any remote write:

```powershell
$releaseId = ([DateTime]::UtcNow.ToString('yyyyMMddTHHmmssZ')) + '-' + $testedSha.Substring(0,12)
if ($releaseId -notmatch "^[0-9]{8}T[0-9]{6}Z-$([regex]::Escape($testedSha.Substring(0,12)))$") {
  throw 'release ID binding is invalid'
}
$archiveFileName = "zhajinhua-$releaseId.tar.gz"
$archivePath = Join-Path $env:TEMP $archiveFileName
if (Test-Path -LiteralPath $archivePath) { throw "archive path already exists: $archivePath" }
git archive --format=tar.gz --output=$archivePath $testedSha -- public server
Assert-Native 'create immutable application archive'
$archiveHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $archivePath).Hash.ToLowerInvariant()
```

The read-only production precheck must capture the exact current release symlink target, application image name/ID and runtime `User/WorkingDir/Entrypoint/Cmd`, database image name/ID, six absolute AI Nginx configuration paths with their SHA-256 values, and the authoritative remote `main` SHA. Store those raw machine-specific values only in a local temporary JSON baseline outside the repository. The public approval packet contains the baseline manifest SHA-256, schema version, logical entry names and count, but never absolute production paths, image/database names or IDs, environment paths, usernames, or host-local topology.
Before constructing the private baseline, obtain every `approved*` value from one bounded, read-only production probe. Do not type or infer these values from an old receipt. The probe must be run through the authenticated SSH/Workbench route and its JSON stdout must be copied to a local temporary file outside the repository; only the SHA-256 and redacted counts enter the public approval packet. A probe failure, missing field, unexpected container, or non-unique AI configuration set stops Step 5.

```powershell
$precheckPath = Join-Path $env:TEMP "zhajinhua-$releaseId-production-precheck.json"
if (Test-Path -LiteralPath $precheckPath) { throw 'production precheck already exists' }
$precheckScript = @'
set -euo pipefail
python3 - <<'PY'
import json, pathlib, subprocess
def run(*args):
    return subprocess.check_output(args, text=True).strip()
current = run('readlink', '-f', '/opt/zhajinhua/current')
app = 'zhajinhua-app-1'
db = 'zhajinhua-db-1'
def image(name):
    return {
        'name': run('sudo', '-n', 'docker', 'inspect', name, '--format', '{{.Config.Image}}'),
        'id': run('sudo', '-n', 'docker', 'inspect', name, '--format', '{{.Image}}'),
    }
app_image = image(app)
app_image.update({
    'user': run('sudo', '-n', 'docker', 'inspect', app, '--format', '{{.Config.User}}'),
    'working_dir': run('sudo', '-n', 'docker', 'inspect', app, '--format', '{{.Config.WorkingDir}}'),
    'entrypoint': json.loads(run('sudo', '-n', 'docker', 'inspect', app, '--format', '{{json .Config.Entrypoint}}')),
    'cmd': json.loads(run('sudo', '-n', 'docker', 'inspect', app, '--format', '{{json .Config.Cmd}}')),
})
expected_destinations = {
    '/etc/nginx/nginx.conf',
    '/etc/nginx/conf.d/edge.conf',
    '/etc/nginx/snippets/origin-tls.conf',
    '/etc/nginx/snippets/proxy-common.conf',
    '/etc/nginx/snippets/proxy-public.conf',
    '/etc/nginx/snippets/public-tls.conf',
}
mounts = json.loads(run(
    'sudo', '-n', 'docker', 'inspect', 'ai-platform-domestic-nginx-1',
    '--format', '{{json .Mounts}}',
))
ai_mounts = [mount for mount in mounts if mount.get('Destination') in expected_destinations]
if len(ai_mounts) != len(expected_destinations):
    raise SystemExit('expected exactly six AI nginx configuration mounts')
if {mount.get('Destination') for mount in ai_mounts} != expected_destinations:
    raise SystemExit('AI nginx configuration destination set drifted')
for mount in ai_mounts:
    if mount.get('Type') != 'bind' or mount.get('RW') is not False or mount.get('Mode') != 'ro':
        raise SystemExit('AI nginx configuration mount must be a read-only bind')
ai_configs = []
for mount in sorted(ai_mounts, key=lambda value: value['Destination']):
    path = pathlib.PurePosixPath(mount['Source'])
    if not path.is_absolute():
        raise SystemExit('AI nginx configuration source must be absolute')
    digest = run('sudo', '-n', 'sha256sum', str(path)).split()[0]
    ai_configs.append({
        'logical_name': mount['Destination'].removeprefix('/etc/nginx/'),
        'path': str(path),
        'sha256': digest,
    })
print(json.dumps({
    'schema_version': 1,
    'old_release': current,
    'app_image': app_image,
    'db_image': image(db),
    'ai_configs': ai_configs,
}, separators=(',', ':')))
PY
'@
$precheckOutput = Join-Path $env:TEMP "zhajinhua-$releaseId-production-precheck.out"
[IO.File]::WriteAllText($precheckOutput, $precheckScript.Replace("`r`n", "`n"), [Text.UTF8Encoding]::new($false))
$sshStart = [Diagnostics.ProcessStartInfo]::new()
$sshStart.FileName = (Get-Command ssh.exe -ErrorAction Stop).Source
$sshStart.UseShellExecute = $false
$sshStart.RedirectStandardInput = $true
$sshStart.RedirectStandardOutput = $true
$sshStart.RedirectStandardError = $true
foreach ($argument in @('-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', 'maintain@47.102.218.42', 'bash -s')) { [void]$sshStart.ArgumentList.Add($argument) }
$sshProcess = [Diagnostics.Process]::new(); $sshProcess.StartInfo = $sshStart
if (!$sshProcess.Start()) { throw 'failed to start bounded production baseline probe' }
$sshProcess.StandardInput.Write((Get-Content -Raw -LiteralPath $precheckOutput)); $sshProcess.StandardInput.Close()
$sshStdoutTask = $sshProcess.StandardOutput.ReadToEndAsync(); $sshStderrTask = $sshProcess.StandardError.ReadToEndAsync()
if (!$sshProcess.WaitForExit(120000)) { $sshProcess.Kill($true); $sshProcess.WaitForExit(); throw 'production baseline probe exceeded 120s deadline' }
$sshStdout = $sshStdoutTask.GetAwaiter().GetResult(); $sshStderr = $sshStderrTask.GetAwaiter().GetResult()
if ($sshProcess.ExitCode -ne 0) { throw "production baseline probe failed: $sshStderr" }
[IO.File]::WriteAllText($precheckPath, $sshStdout.Trim() + "`n", [Text.UTF8Encoding]::new($false))
Remove-Item -LiteralPath $precheckOutput -Force -ErrorAction Stop
$precheck = Get-Content -Raw -LiteralPath $precheckPath | ConvertFrom-Json
if ($precheck.schema_version -ne 1 -or @($precheck.ai_configs).Count -ne 6) { throw 'production precheck is invalid' }
$approvedOldRelease = [string]$precheck.old_release
$approvedOldImage = [string]$precheck.app_image.name
$approvedOldImageId = [string]$precheck.app_image.id
$approvedOldImageUser = [string]$precheck.app_image.user
$approvedOldImageWorkingDir = [string]$precheck.app_image.working_dir
$approvedOldImageEntrypoint = $precheck.app_image.entrypoint
$approvedOldImageCmd = $precheck.app_image.cmd
$approvedOldDbImage = [string]$precheck.db_image.name
$approvedOldDbImageId = [string]$precheck.db_image.id
$approvedAiConfigs = @($precheck.ai_configs)
$gitStart = [Diagnostics.ProcessStartInfo]::new()
$gitStart.FileName = (Get-Command git.exe -ErrorAction Stop).Source
$gitStart.UseShellExecute = $false
$gitStart.RedirectStandardOutput = $true
$gitStart.RedirectStandardError = $true
$gitStart.Environment['GIT_TERMINAL_PROMPT'] = '0'
[void]$gitStart.ArgumentList.Add('ls-remote')
[void]$gitStart.ArgumentList.Add('origin')
[void]$gitStart.ArgumentList.Add('refs/heads/main')
$gitProcess = [Diagnostics.Process]::new(); $gitProcess.StartInfo = $gitStart
if (!$gitProcess.Start()) { throw 'failed to start bounded remote main probe' }
$gitStdout = $gitProcess.StandardOutput.ReadToEndAsync(); $gitStderr = $gitProcess.StandardError.ReadToEndAsync()
if (!$gitProcess.WaitForExit(120000)) { $gitProcess.Kill($true); $gitProcess.WaitForExit(); throw 'remote main probe exceeded 120s deadline' }
if ($gitProcess.ExitCode -ne 0) { throw "remote main probe failed: $($gitStderr.GetAwaiter().GetResult())" }
$approvedRemoteMain = ($gitStdout.GetAwaiter().GetResult() -split '\s+')[0].Trim()
if ($approvedRemoteMain -notmatch '^[0-9a-f]{40}$') { throw 'authoritative remote main SHA is invalid' }
```

Present `$testedSha`, `$releaseId`, `$archiveFileName`, clean detached-tree proof, test totals, Browser evidence, exact CodeRabbit status, independent reviewer status, `$archiveHash`, private-baseline hash/count, and the rollback checklist below, then stop before any remote write. Write that sanitized packet as UTF-8 without BOM and with LF endings to `work-flow/docs/requirements/0002_炸金花生产发布与回滚审计_L4/release-approval.md`. Before hashing the packet, create the private baseline with `ConvertTo-Json -Compress`, write it with UTF-8/LF/no BOM, parse it back with `ConvertFrom-Json`, require exactly six AI entries, and compute `$releaseBaselineHash`. The private baseline is transferred only after approval and is never staged.

```powershell
$releaseBaselinePath = Join-Path $env:TEMP "zhajinhua-$releaseId-private-baseline.json"
if (Test-Path -LiteralPath $releaseBaselinePath) { throw 'private release baseline already exists' }
if (@($approvedAiConfigs).Count -ne 6) { throw 'exactly six AI configuration baselines are required' }
$releaseBaseline = [ordered]@{
  schema_version = 1
  tested_sha = $testedSha
  release_id = $releaseId
  archive_file_name = $archiveFileName
  archive_sha256 = $archiveHash
  remote_main = $approvedRemoteMain
  old_release = $approvedOldRelease
  app_image = [ordered]@{
    name = $approvedOldImage
    id = $approvedOldImageId
    user = $approvedOldImageUser
    working_dir = $approvedOldImageWorkingDir
    entrypoint = $approvedOldImageEntrypoint
    cmd = $approvedOldImageCmd
  }
  db_image = [ordered]@{ name = $approvedOldDbImage; id = $approvedOldDbImageId }
  ai_configs = @($approvedAiConfigs | ForEach-Object {
    [ordered]@{ logical_name = $_.logical_name; path = $_.path; sha256 = $_.sha256 }
  })
}
$releaseBaselineJson = ($releaseBaseline | ConvertTo-Json -Depth 6 -Compress).Replace("`r`n", "`n")
[IO.File]::WriteAllText($releaseBaselinePath, "$releaseBaselineJson`n", [Text.UTF8Encoding]::new($false))
$rollbackChecklist = @'
1. Read and compare the local and remote recovery-manifest SHA-256 receipts.
2. Verify the recovery manifest, previous image archive, database dump, and previous Compose backup hashes.
3. Load the previous image only when its exact approved image ID is absent.
4. Atomically restore the previous release symlink.
5. Start only the application from the hash-verified Compose backup with the approved previous image.
6. Revalidate image identity, HTTPS, WSS, Nginx, Cloudflared, and all six AI configuration hashes.
'@.Replace("`r`n", "`n").TrimEnd("`n")
$baselineReadback = Get-Content -Raw -LiteralPath $releaseBaselinePath | ConvertFrom-Json
if ($baselineReadback.schema_version -ne 1 -or @($baselineReadback.ai_configs).Count -ne 6) { throw 'private release baseline is invalid' }
$releaseBaselineHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseBaselinePath).Hash.ToLowerInvariant()
$approvalPath = Join-Path $projectRoot 'work-flow/docs/requirements/0002_炸金花生产发布与回滚审计_L4/release-approval.md'
$approvalText = @"
task_id: 71d4428f-ff22-4e8d-bdb8-f09efcb0221b
release_id: $releaseId
tested_sha: $testedSha
archive_file: $archiveFileName
archive_sha256: $archiveHash
private_baseline_sha256: $releaseBaselineHash
private_baseline_entries: 6
workflow: local tests, detached Browser acceptance, independent code review, independent L4 risk review
coderabbit: $codeRabbitStatus
rollback: $rollbackChecklist
stop_condition: any failed local gate, candidate probe, HTTPS/WSS/auth/room check, or shared AI ingress health check
external_write_scope: target Zhajinhua service and GitHub branch huang only
"@.Replace("`r`n", "`n").Replace("`r", "`n").TrimEnd("`n")
[IO.File]::WriteAllText($approvalPath, "$approvalText`n", [Text.UTF8Encoding]::new($false))
$releaseIntentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $approvalPath).Hash.ToLowerInvariant()
$releasePlanPath = Join-Path $projectRoot 'docs/superpowers/plans/2026-08-19-zhajinhua-gameplay-closure-plan.md'
$releasePlanHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releasePlanPath).Hash.ToLowerInvariant()
$rollbackBytes = [Text.UTF8Encoding]::new($false).GetBytes($rollbackChecklist)
$rollbackChecklistHash = [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData($rollbackBytes)).ToLowerInvariant()
foreach ($hash in @($archiveHash, $releaseBaselineHash, $releaseIntentHash, $releasePlanHash, $rollbackChecklistHash)) {
  if ($hash -notmatch '^[0-9a-f]{64}$') { throw 'release hash generation failed' }
}
$releaseContextPath = Join-Path $env:TEMP 'zhajinhua-active-release-context.json'
$releaseContextHashPath = "$releaseContextPath.sha256"
if (Test-Path -LiteralPath $releaseContextPath,$releaseContextHashPath) { throw 'active release context already exists' }
$releaseContext = [ordered]@{
  schema_version = 1
  release_id = $releaseId
  archive_path = $archivePath
  archive_sha256 = $archiveHash
  baseline_path = $releaseBaselinePath
  baseline_sha256 = $releaseBaselineHash
  approval_path = $approvalPath
  approval_sha256 = $releaseIntentHash
  plan_sha256 = $releasePlanHash
  rollback_sha256 = $rollbackChecklistHash
}
$releaseContextJson = ($releaseContext | ConvertTo-Json -Compress).Replace("`r`n", "`n")
[IO.File]::WriteAllText($releaseContextPath, "$releaseContextJson`n", [Text.UTF8Encoding]::new($false))
$releaseContextHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseContextPath).Hash.ToLowerInvariant()
[IO.File]::WriteAllText($releaseContextHashPath, "$releaseContextHash`n", [Text.UTF8Encoding]::new($false))
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $releaseContextPath).Hash.ToLowerInvariant() -ne (Get-Content -Raw -LiteralPath $releaseContextHashPath).Trim()) {
  throw 'local release context readback failed'
}
```

The server must use the approved `$releaseId` and `$archiveFileName` verbatim rather than generating a second timestamp or filename.

After the user explicitly approves that packet, use the existing independent task `71d4428f-ff22-4e8d-bdb8-f09efcb0221b` to persist the post-validation authorization. Each transition uses a new writer lock, reads the current revision immediately before the transition, checks exit codes, and releases the exact lock in `finally`. The full sequence is `intake -> planned -> approved -> implementing`; the final transition binds the approval to `$testedSha`, `$archiveHash`, the observed release/image, and the rollback-checklist hash. Pass the existing three task IDs as the frozen batch. Do not store a password, environment value, private key, or session identifier in any field.

```powershell
$riskTaskId = '71d4428f-ff22-4e8d-bdb8-f09efcb0221b'
$batchTaskIds = @(
  'be50d92f-59cc-4b99-8286-31b29374c38b',
  'e842278c-e053-45be-aa35-a144f49b57ab',
  $riskTaskId
)
$workflowCli = Join-Path $projectRoot 'work-flow/scripts/Invoke-ProjectWorkflow.ps1'
$ownerId = "release-approval-$($testedSha.Substring(0, 12))"

function Invoke-WorkflowTransition {
  param([string]$To, [string[]]$ExtraArgs)
  $operationId = [guid]::NewGuid().ToString()
  pwsh.exe -File $workflowCli lock acquire --root $projectRoot --task-id $riskTaskId --role reporter --owner $ownerId --operation-id $operationId --json
  Assert-Native "acquire workflow lock for $To"
  try {
    $state = pwsh.exe -File $workflowCli state read --root $projectRoot --json | ConvertFrom-Json
    Assert-Native "read workflow revision for $To"
    & pwsh.exe -File $workflowCli transition --root $projectRoot --task-id $riskTaskId --to $To --expected-revision $state.state.revision --operation-id $operationId @ExtraArgs --json
    Assert-Native "transition release audit task to $To"
  } finally {
    pwsh.exe -File $workflowCli lock release --root $projectRoot --task-id $riskTaskId --role reporter --owner $ownerId --operation-id $operationId --json
    Assert-Native "release workflow lock for $To"
  }
}

Invoke-WorkflowTransition -To planned -ExtraArgs @('--intent-hash', $releaseIntentHash)
Invoke-WorkflowTransition -To approved -ExtraArgs @(
  '--technical-plan-hash', $releasePlanHash,
  '--authorization-id', "user-confirmed-post-validation-$($testedSha.Substring(0, 12))"
)
$batchArgs = @()
foreach ($taskId in $batchTaskIds) { $batchArgs += @('--batch-task-id', $taskId) }
$implementingArgs = $batchArgs + @(
  '--risk-confirmation', "approved-tested-sha=$testedSha archive-sha256=$archiveHash rollback-checklist-sha256=$rollbackChecklistHash",
  '--target-system', 'crazythursdayplay.bbroot.com Zhajinhua service',
  '--target-environment', 'production Ubuntu 24.04 LTS',
  '--target-object', "huang branch $testedSha and release $releaseId",
  '--backup-ref', "/opt/zhajinhua/backups/$releaseId/recovery.env",
  '--rollback-ref', 'release-approval.md exact rollback checklist',
  '--monitoring-ref', 'finite HTTPS WSS container Nginx Cloudflared and AI Browser checks',
  '--stop-condition', 'rollback on any failed or timed-out promotion or acceptance gate',
  '--external-write-scope', 'origin huang and Zhajinhua release only; main and shared AI configuration unchanged',
  '--post-action-validation-ref', 'work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/release.md',
  '--audit-result-ref', 'work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4/result.md'
)
Invoke-WorkflowTransition -To implementing -ExtraArgs $implementingArgs
```

- [ ] **Step 6: Push exactly the reviewed SHA**

```powershell
function Invoke-BoundedGit {
  param([Parameter(Mandatory)][string[]]$Arguments, [int]$TimeoutSeconds = 120)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'git'
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
  $start.Environment['GIT_HTTP_LOW_SPEED_LIMIT'] = '1'
  $start.Environment['GIT_HTTP_LOW_SPEED_TIME'] = '30'
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (!$process.Start()) { throw "failed to start bounded git command" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "git command exceeded ${TimeoutSeconds}s deadline"
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "git command failed with exit code $($process.ExitCode): $stderr" }
  if ($stderr) { Write-Host $stderr.TrimEnd() }
  return $stdout.TrimEnd()
}

$contextExpectedHash = (Get-Content -Raw -LiteralPath $releaseContextHashPath).Trim()
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $releaseContextPath).Hash.ToLowerInvariant() -ne $contextExpectedHash) {
  throw 'local release context changed'
}
$context = Get-Content -Raw -LiteralPath $releaseContextPath | ConvertFrom-Json
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $context.approval_path).Hash.ToLowerInvariant() -ne $context.approval_sha256) {
  throw 'release approval changed after confirmation'
}
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $context.baseline_path).Hash.ToLowerInvariant() -ne $context.baseline_sha256) {
  throw 'private release baseline changed after confirmation'
}
$approvedBaseline = Get-Content -Raw -LiteralPath $context.baseline_path | ConvertFrom-Json
$approvedRemoteMain = [string]$approvedBaseline.remote_main
$localMainExistsBefore = $false
$localMainBefore = $null
git show-ref --verify --quiet refs/heads/main
if ($LASTEXITCODE -eq 0) {
  $localMainExistsBefore = $true
  $localMainBefore = (git rev-parse refs/heads/main).Trim()
  Assert-Native 'read optional local main before push'
} elseif ($LASTEXITCODE -ne 1) {
  throw "inspect optional local main failed with exit code $LASTEXITCODE"
}
$remoteMainBeforeLine = Invoke-BoundedGit -Arguments @('ls-remote', 'origin', 'refs/heads/main')
$remoteMainBefore = (($remoteMainBeforeLine -split '\s+')[0]).Trim()
if (!$remoteMainBefore) { throw "remote main is missing" }
if ($approvedRemoteMain -notmatch '^[0-9a-f]{40}$' -or $remoteMainBefore -ne $approvedRemoteMain) {
  throw "remote main drifted after release approval"
}
$remoteMainReceiptPath = Join-Path $env:TEMP "zhajinhua-$releaseId-remote-main.txt"
if (Test-Path -LiteralPath $remoteMainReceiptPath) { throw "remote main receipt already exists" }
[IO.File]::WriteAllText($remoteMainReceiptPath, "$remoteMainBefore`n", [Text.UTF8Encoding]::new($false))
if ((Get-Content -Raw -LiteralPath $remoteMainReceiptPath).Trim() -ne $remoteMainBefore) { throw "remote main receipt readback failed" }
Invoke-BoundedGit -Arguments @('fetch', 'origin', 'huang', 'main') | Out-Null
git merge-base --is-ancestor origin/huang $testedSha
Assert-Native 'verify huang fast-forward ancestry'
Invoke-BoundedGit -Arguments @('push', 'origin', "${testedSha}:refs/heads/huang") | Out-Null
$remoteHuangLine = Invoke-BoundedGit -Arguments @('ls-remote', 'origin', 'refs/heads/huang')
$remoteSha = (($remoteHuangLine -split '\s+')[0]).Trim()
if ($remoteSha -ne $testedSha) { throw "remote huang SHA mismatch" }
Invoke-BoundedGit -Arguments @('fetch', 'origin', 'main') | Out-Null
$localMainExistsAfter = $false
$localMainAfter = $null
git show-ref --verify --quiet refs/heads/main
if ($LASTEXITCODE -eq 0) {
  $localMainExistsAfter = $true
  $localMainAfter = (git rev-parse refs/heads/main).Trim()
  Assert-Native 'read optional local main after push'
} elseif ($LASTEXITCODE -ne 1) {
  throw "inspect optional local main after push failed with exit code $LASTEXITCODE"
}
$originMainAfter = (git rev-parse refs/remotes/origin/main).Trim()
Assert-Native 'read refreshed origin main after push'
$remoteMainAfterLine = Invoke-BoundedGit -Arguments @('ls-remote', 'origin', 'refs/heads/main')
$remoteMainAfter = (($remoteMainAfterLine -split '\s+')[0]).Trim()
if ($localMainExistsAfter -ne $localMainExistsBefore -or $localMainAfter -ne $localMainBefore) { throw "optional local main changed during huang push" }
if ($remoteMainAfter -ne $remoteMainBefore -or $originMainAfter -ne $remoteMainAfter) { throw "remote main changed during huang push" }
```

Expected: remote `huang` reads back as the exact tested SHA; `main` remains unchanged.

- [ ] **Step 7: Capture production state and immutable rollback material**

Reload and hash-check the local release context, then transfer only its exact archive and private baseline with a bounded, non-interactive SSH operation. If the configured SSH route is unavailable, stop; an unbounded browser upload is not an acceptable substitute.

```powershell
$contextExpectedHash = (Get-Content -Raw -LiteralPath $releaseContextHashPath).Trim()
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $releaseContextPath).Hash.ToLowerInvariant() -ne $contextExpectedHash) { throw 'release context changed' }
$context = Get-Content -Raw -LiteralPath $releaseContextPath | ConvertFrom-Json
$scp = (Get-Command scp.exe -ErrorAction Stop).Source
Invoke-BoundedProcess $scp @(
  '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10',
  $context.archive_path, $context.baseline_path,
  'maintain@47.102.218.42:/home/maintain/'
) 600 'transfer approved release inputs'
```

Run the following through the authenticated Alibaba Cloud session. Set only `tested_sha`, `archive_sha256`, `archive_file_name`, `release_id`, `release_baseline_sha256`, and `release_baseline_file_name` from the hash-verified local context. Raw production values are read from the exact transferred JSON after its SHA-256 matches; they are never retyped. Validate all bindings, reject any existing backup/release/candidate path, and resolve the external Compose environment as exactly one file under `/etc/zhajinhua`; never print its contents. All Git/network, archive transfer, backup, build, promotion, and rollback commands use an explicit finite deadline; a timeout is a failed gate.

Create `/opt/zhajinhua/backups/$release_id` as `0700`. Persist a `0600` root-owned recovery manifest containing the tested SHA, archive hash, release ID, environment-file path, previous release symlink target, previous Compose path, previous image name/ID, and the image/database backup hashes. This manifest is the only recovery input after a disconnected Workbench session; terminal-only variables are not sufficient.

```bash
set -euo pipefail
: "${tested_sha:?tested_sha is required}"
: "${archive_sha256:?archive_sha256 is required}"
: "${archive_file_name:?archive_file_name is required}"
: "${release_id:?release_id is required}"
: "${release_baseline_sha256:?release_baseline_sha256 is required}"
: "${release_baseline_file_name:?release_baseline_file_name is required}"
[[ "$tested_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]
[[ "$release_baseline_sha256" =~ ^[0-9a-f]{64}$ ]]
[[ "$release_id" =~ ^[0-9]{8}T[0-9]{6}Z-${tested_sha:0:12}$ ]]
test "$archive_file_name" = "zhajinhua-$release_id.tar.gz"
test "$release_baseline_file_name" = "zhajinhua-$release_id-private-baseline.json"
timeout --foreground 15s sudo -v
sudo -n true
# Keep every later privileged operation non-interactive, including commands
# copied into a fresh Workbench shell after the bounded credential refresh.
sudo() { command sudo -n "$@"; }
backup_dir="/opt/zhajinhua/backups/$release_id"
candidate_release="/opt/zhajinhua/releases/$release_id"
baseline_file="$(pwd -P)/$release_baseline_file_name"
test -f "$baseline_file"
test "$(timeout --foreground 30s sha256sum "$baseline_file" | awk '{print $1}')" = "$release_baseline_sha256"
baseline_value() {
  timeout --foreground 30s python3 -c '
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."): value = value[key]
if isinstance(value, (dict, list)) or value is None: print(json.dumps(value, separators=(",", ":")))
elif isinstance(value, (str, int)): print(value)
else: raise SystemExit(2)
' "$baseline_file" "$1"
}
test "$(baseline_value schema_version)" = 1
test "$(baseline_value tested_sha)" = "$tested_sha"
test "$(baseline_value release_id)" = "$release_id"
test "$(baseline_value archive_file_name)" = "$archive_file_name"
test "$(baseline_value archive_sha256)" = "$archive_sha256"
approved_old_release=$(baseline_value old_release)
approved_old_image=$(baseline_value app_image.name)
approved_old_image_id=$(baseline_value app_image.id)
approved_old_image_user=$(baseline_value app_image.user)
approved_old_image_working_dir=$(baseline_value app_image.working_dir)
approved_old_image_entrypoint=$(baseline_value app_image.entrypoint)
approved_old_image_cmd=$(baseline_value app_image.cmd)
approved_old_db_image=$(baseline_value db_image.name)
approved_old_db_image_id=$(baseline_value db_image.id)
old_release="$approved_old_release"
old_image="$approved_old_image"
old_image_id="$approved_old_image_id"
old_db_image="$approved_old_db_image"
old_db_image_id="$approved_old_db_image_id"
test -n "$old_release" -a -n "$old_image" -a -n "$old_image_id"
test -n "$old_db_image" -a -n "$old_db_image_id"
incoming_dir=$(pwd -P)
case "$incoming_dir" in /home/*) ;; *) echo 'incoming directory must be an authenticated user home' >&2; exit 1 ;; esac
baseline_file="$incoming_dir/$release_baseline_file_name"
test -f "$baseline_file"
test "$(timeout --foreground 30s sha256sum "$baseline_file" | awk '{print $1}')" = "$release_baseline_sha256"
baseline_value() {
  timeout --foreground 30s python3 -c '
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."):
    value = value[key]
if isinstance(value, (dict, list)) or value is None:
    print(json.dumps(value, separators=(",", ":")))
elif isinstance(value, (str, int)):
    print(value)
else:
    raise SystemExit(2)
' "$baseline_file" "$1"
}
test "$(baseline_value schema_version)" = '1'
test "$(baseline_value tested_sha)" = "$tested_sha"
test "$(baseline_value release_id)" = "$release_id"
test "$(baseline_value archive_file_name)" = "$archive_file_name"
test "$(baseline_value archive_sha256)" = "$archive_sha256"
approved_old_release=$(baseline_value old_release)
approved_old_image=$(baseline_value app_image.name)
approved_old_image_id=$(baseline_value app_image.id)
approved_old_image_user=$(baseline_value app_image.user)
approved_old_image_working_dir=$(baseline_value app_image.working_dir)
approved_old_image_entrypoint=$(baseline_value app_image.entrypoint)
approved_old_image_cmd=$(baseline_value app_image.cmd)
approved_old_db_image=$(baseline_value db_image.name)
approved_old_db_image_id=$(baseline_value db_image.id)
[[ "$approved_old_release" == /opt/zhajinhua/releases/* ]]
[[ "$approved_old_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
[[ "$approved_old_db_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
backup_dir="/opt/zhajinhua/backups/$release_id"
candidate_release="/opt/zhajinhua/releases/$release_id"
candidate_image="local/zhajinhua:$release_id"
test ! -e "$backup_dir" && test ! -e "$candidate_release"
mapfile -t env_files < <(sudo find /etc/zhajinhua -maxdepth 1 -type f -name '*.env' -print)
(( ${#env_files[@]} == 1 ))
env_file="${env_files[0]}"
approved_ai_source="$incoming_dir/zhajinhua-$release_id-approved-ai.sha256"
test ! -e "$approved_ai_source"
timeout --foreground 30s python3 - "$baseline_file" > "$approved_ai_source" <<'PY'
import json, pathlib, re, sys
data = json.load(open(sys.argv[1], encoding="utf-8"))
entries = data.get("ai_configs", [])
if len(entries) != 6:
    raise SystemExit(2)
for entry in entries:
    digest, path = entry.get("sha256", ""), entry.get("path", "")
    if not re.fullmatch(r"[0-9a-f]{64}", digest) or not pathlib.PurePosixPath(path).is_absolute() or "\n" in path:
        raise SystemExit(2)
    print(f"{digest}  {path}")
PY
chmod 0600 "$approved_ai_source"
approved_ai_manifest_sha256=$(timeout --foreground 30s sha256sum "$approved_ai_source" | awk '{print $1}')

verify_approved_baseline() {
  local current_release current_image current_image_id current_db_image current_db_image_id current_hash index
  current_release=$(readlink -f /opt/zhajinhua/current)
  current_image=$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Config.Image}}')
  current_image_id=$(sudo timeout --foreground 30s docker image inspect "$current_image" --format '{{.Id}}')
  current_db_image=$(sudo timeout --foreground 30s docker inspect zhajinhua-db-1 --format '{{.Config.Image}}')
  current_db_image_id=$(sudo timeout --foreground 30s docker image inspect "$current_db_image" --format '{{.Id}}')
  test "$current_release" = "$approved_old_release"
  test "$current_image" = "$approved_old_image"
  test "$current_image_id" = "$approved_old_image_id"
  test "$current_db_image" = "$approved_old_db_image"
  test "$current_db_image_id" = "$approved_old_db_image_id"
  test "$(sudo -n timeout --foreground 30s docker image inspect "$current_image" --format '{{.Config.User}}')" = "$approved_old_image_user"
  test "$(sudo -n timeout --foreground 30s docker image inspect "$current_image" --format '{{.Config.WorkingDir}}')" = "$approved_old_image_working_dir"
  test "$(sudo -n timeout --foreground 30s docker image inspect "$current_image" --format '{{json .Config.Entrypoint}}')" = "$approved_old_image_entrypoint"
  test "$(sudo -n timeout --foreground 30s docker image inspect "$current_image" --format '{{json .Config.Cmd}}')" = "$approved_old_image_cmd"
  sudo -n timeout --foreground 2m sha256sum -c "$approved_ai_source" >/dev/null
}

verify_approved_baseline
old_release="$approved_old_release"
old_image="$approved_old_image"
old_image_id="$approved_old_image_id"
old_db_image="$approved_old_db_image"
old_db_image_id="$approved_old_db_image_id"
old_compose="$old_release/server/deploy/compose.production.yaml"
test -d "$old_release"
test -f "$old_compose" && test -f "$env_file"
test -n "$old_image" && test -n "$old_image_id" && test "$old_image_id" != '<no value>'
sudo -n timeout --foreground 30s install -d -m 0700 "$backup_dir"
sudo timeout --foreground 15m sh -c 'docker image save "$1" | gzip -1 > "$2"' sh "$old_image" "$backup_dir/previous-image.tar.gz"
sudo timeout --foreground 5m gzip -t "$backup_dir/previous-image.tar.gz"
sudo timeout --foreground 5m sh -c 'gzip -dc "$1" | tar -tf - >/dev/null' sh "$backup_dir/previous-image.tar.gz"
image_backup_sha=$(sudo timeout --foreground 5m sha256sum "$backup_dir/previous-image.tar.gz" | awk '{print $1}')
sudo timeout --foreground 15m sh -c 'docker exec zhajinhua-db-1 sh -c '\''pg_dump -Fc -U "$POSTGRES_USER" "$POSTGRES_DB"'\'' > "$1"' sh "$backup_dir/database.dump"
sudo timeout --foreground 5m sh -c 'docker exec -i zhajinhua-db-1 pg_restore -l < "$1" >/dev/null' sh "$backup_dir/database.dump"
database_backup_sha=$(sudo timeout --foreground 5m sha256sum "$backup_dir/database.dump" | awk '{print $1}')
sudo -n timeout --foreground 30s install -m 0600 "$old_compose" "$backup_dir/previous-compose.yaml"
compose_backup_sha=$(sudo timeout --foreground 30s sha256sum "$backup_dir/previous-compose.yaml" | awk '{print $1}')
sudo -n timeout --foreground 30s install -m 0600 "$approved_ai_source" "$backup_dir/approved-ai.sha256"
ai_manifest_sha=$(sudo timeout --foreground 30s sha256sum "$backup_dir/approved-ai.sha256" | awk '{print $1}')
{
  printf 'tested_sha=%q\n' "$tested_sha"
  printf 'archive_sha256=%q\n' "$archive_sha256"
  printf 'release_id=%q\n' "$release_id"
  printf 'env_file=%q\n' "$env_file"
  printf 'old_release=%q\n' "$old_release"
  printf 'old_image=%q\n' "$old_image"
  printf 'old_image_id=%q\n' "$old_image_id"
  printf 'old_image_user=%q\n' "$approved_old_image_user"
  printf 'old_image_working_dir=%q\n' "$approved_old_image_working_dir"
  printf 'old_image_entrypoint=%q\n' "$approved_old_image_entrypoint"
  printf 'old_image_cmd=%q\n' "$approved_old_image_cmd"
  printf 'old_db_image=%q\n' "$old_db_image"
  printf 'old_db_image_id=%q\n' "$old_db_image_id"
  printf 'image_backup_sha256=%q\n' "$image_backup_sha"
  printf 'database_backup_sha256=%q\n' "$database_backup_sha"
  printf 'old_compose=%q\n' "$backup_dir/previous-compose.yaml"
  printf 'compose_backup_sha256=%q\n' "$compose_backup_sha"
  printf 'approved_ai_manifest=%q\n' "$backup_dir/approved-ai.sha256"
  printf 'approved_ai_manifest_sha256=%q\n' "$ai_manifest_sha"
  printf 'release_baseline_file=%q\n' "$baseline_file"
  printf 'release_baseline_sha256=%q\n' "$release_baseline_sha256"
} | sudo tee "$backup_dir/recovery.env" >/dev/null
sudo chmod 0600 "$backup_dir/recovery.env"
recovery_manifest_sha=$(sudo timeout --foreground 30s sha256sum "$backup_dir/recovery.env" | awk '{print $1}')
[[ "$recovery_manifest_sha" =~ ^[0-9a-f]{64}$ ]]
printf '%s\n' "$recovery_manifest_sha" | sudo tee "$backup_dir/recovery.env.sha256" >/dev/null
sudo chmod 0600 "$backup_dir/recovery.env.sha256"
test "$(sudo cat "$backup_dir/recovery.env.sha256")" = "$recovery_manifest_sha"
printf 'RECOVERY_MANIFEST_SHA256=%s\n' "$recovery_manifest_sha"
```

Capture the single `RECOVERY_MANIFEST_SHA256` line without shell history or secret output and persist it locally outside the repository before continuing:

```powershell
if ($recoveryManifestHash -notmatch '^[0-9a-f]{64}$') { throw 'invalid recovery manifest hash' }
$recoveryReceiptPath = Join-Path $env:TEMP "zhajinhua-$releaseId-recovery.sha256"
if (Test-Path -LiteralPath $recoveryReceiptPath) { throw 'local recovery receipt already exists' }
[IO.File]::WriteAllText($recoveryReceiptPath, "$recoveryManifestHash`n", [Text.UTF8Encoding]::new($false))
if ((Get-Content -Raw -LiteralPath $recoveryReceiptPath).Trim() -ne $recoveryManifestHash) { throw 'local recovery receipt readback failed' }
```

Also record current container health, `nginx -t`, Cloudflared readiness, the live application HTTPS/TLS baseline, and the refreshed authenticated `https://cf.silhouette.ltd/admin/usage` Browser canary. The `verify_approved_baseline` function proves the approved release/image and all six AI hashes have not drifted. Any missing baseline, invalid backup, failed local or remote recovery-hash readback, secret output, or failed shared-ingress precheck blocks promotion.

- [ ] **Step 8: Stage and validate the exact application archive**

Transfer only the exact `$archivePath` created and approved in Step 5 through the authenticated Workbench session with a 10-minute deadline. Require the server SHA-256 to equal `$archiveHash`, reject absolute or `..` archive members, and extract into the new `/opt/zhajinhua/releases/$release_id` directory with `--no-same-owner`. The extracted release must contain a non-secret manifest with `$testedSha`, archive SHA-256, timestamp, previous release, previous image name, and previous image ID. Verify required source trees before creating any image.

Production dependencies did not change. Because this server cannot reliably reach Docker Hub/npm metadata, build the candidate offline from the immutable approved application image ID with a temporary Dockerfile, `--pull=false`, and `--network=none`. The Dockerfile runs as root only while replacing `/app/server/src`, `/app/server/sql`, and `/app/public`, restores the approved runtime user and working directory through build arguments, and leaves the base image `ENTRYPOINT` and `CMD` inherited unchanged. Compare the candidate's `User/WorkingDir/Entrypoint/Cmd` byte-for-byte with the approved private baseline before probing it.

Never connect the candidate to `zhajinhua_internal` or the production database. Start an isolated internal Docker network and a temporary PostgreSQL container from the approved database image, restore `database.dump` into it, and point the candidate only at that clone. Generate temporary probe credentials, store them only in root-owned `0600` env files, and never source the production Compose env in a shell. Always remove both probe containers, their isolated network, the temporary Dockerfile, and the temporary env files in a trap; do not remove the candidate image needed for promotion. Every build, inspect, restore, run, and probe has a finite deadline.

```bash
set -euo pipefail
incoming_dir=$(pwd -P)
case "$incoming_dir" in /home/*) ;; *) echo 'incoming directory must be an authenticated user home' >&2; exit 1 ;; esac
incoming_archive="$incoming_dir/$archive_file_name"
test -f "$incoming_archive"
server_archive_sha=$(timeout --foreground 30s sha256sum "$incoming_archive" | awk '{print $1}')
test "$server_archive_sha" = "$archive_sha256"
timeout --foreground 2m tar -tzf "$incoming_archive" | awk '
  /^\// || /(^|\/)\.\.($|\/)/ || $0 !~ /^(public|server)(\/|$)/ { bad=1 }
  END { exit bad }
'
sudo install -d -m 0755 "$candidate_release"
sudo timeout --foreground 2m tar -xzf "$incoming_archive" -C "$candidate_release" --no-same-owner --no-same-permissions
for required in server/src server/sql server/package.json server/package-lock.json server/deploy/compose.production.yaml public; do
  test -e "$candidate_release/$required"
done
{
  printf 'tested_sha=%s\n' "$tested_sha"
  printf 'archive_sha256=%s\n' "$archive_sha256"
  printf 'release_id=%s\n' "$release_id"
  printf 'created_at=%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  printf 'previous_release=%s\n' "$old_release"
  printf 'previous_image=%s\n' "$old_image"
  printf 'previous_image_id=%s\n' "$old_image_id"
} | sudo tee "$candidate_release/RELEASE_MANIFEST" >/dev/null
sudo chmod 0644 "$candidate_release/RELEASE_MANIFEST"

probe_container="zhajinhua-probe-${release_id,,}"
probe_db_container="zhajinhua-probe-db-${release_id,,}"
probe_network="zhajinhua-probe-${release_id,,}"
candidate_dockerfile="$backup_dir/Candidate.Dockerfile"
candidate_env="$backup_dir/candidate-app.env"
candidate_db_env="$backup_dir/candidate-db.env"
cleanup_candidate() {
  local cleanup_status=0 container
  for container in "$probe_container" "$probe_db_container"; do
    if sudo timeout --foreground 30s docker container inspect "$container" >/dev/null 2>&1; then
      sudo timeout --foreground 1m docker rm -f "$container" >/dev/null || cleanup_status=1
    fi
    if sudo timeout --foreground 30s docker container inspect "$container" >/dev/null 2>&1; then cleanup_status=1; fi
  done
  if sudo timeout --foreground 30s docker network inspect "$probe_network" >/dev/null 2>&1; then
    sudo timeout --foreground 1m docker network rm "$probe_network" >/dev/null || cleanup_status=1
  fi
  if sudo timeout --foreground 30s docker network inspect "$probe_network" >/dev/null 2>&1; then cleanup_status=1; fi
  for path in "$candidate_env" "$candidate_db_env" "$candidate_dockerfile"; do
    sudo rm -f -- "$path" || cleanup_status=1
    if sudo test -e "$path"; then cleanup_status=1; fi
  done
  return "$cleanup_status"
}
trap cleanup_candidate EXIT
if sudo timeout --foreground 30s docker container inspect "$probe_container" >/dev/null 2>&1; then exit 1; fi
if sudo timeout --foreground 30s docker container inspect "$probe_db_container" >/dev/null 2>&1; then exit 1; fi
if sudo timeout --foreground 30s docker network inspect "$probe_network" >/dev/null 2>&1; then exit 1; fi
if sudo timeout --foreground 30s docker image inspect "$candidate_image" >/dev/null 2>&1; then exit 1; fi
cat <<'DOCKERFILE' | sudo tee "$candidate_dockerfile" >/dev/null
ARG BASE_IMAGE
FROM ${BASE_IMAGE}
ARG RUNTIME_USER
ARG RUNTIME_WORKDIR
USER root
RUN rm -rf /app/server/src /app/server/sql /app/public && mkdir -p /app/server/src /app/server/sql /app/public
COPY server/src /app/server/src
COPY server/sql /app/server/sql
COPY server/package.json server/package-lock.json /app/server/
COPY public /app/public
WORKDIR ${RUNTIME_WORKDIR}
USER ${RUNTIME_USER}
DOCKERFILE
sudo chmod 0600 "$candidate_dockerfile"
sudo timeout --foreground 10m docker build --pull=false --network=none \
  --build-arg "BASE_IMAGE=$old_image_id" \
  --build-arg "RUNTIME_USER=$approved_old_image_user" \
  --build-arg "RUNTIME_WORKDIR=$approved_old_image_working_dir" \
  --label "org.opencontainers.image.revision=$tested_sha" \
  --label "zhajinhua.archive.sha256=$archive_sha256" \
  -f "$candidate_dockerfile" -t "$candidate_image" "$candidate_release" >/dev/null
candidate_image_id=$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Id}}')
test -n "$candidate_image_id" && test "$candidate_image_id" != "$old_image_id"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$tested_sha"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{index .Config.Labels "zhajinhua.archive.sha256"}}')" = "$archive_sha256"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Config.User}}')" = "$approved_old_image_user"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Config.WorkingDir}}')" = "$approved_old_image_working_dir"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{json .Config.Entrypoint}}')" = "$approved_old_image_entrypoint"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{json .Config.Cmd}}')" = "$approved_old_image_cmd"

candidate_db_password=$(timeout --foreground 15s openssl rand -hex 24)
candidate_session_secret=$(timeout --foreground 15s openssl rand -hex 32)
umask 077
{
  printf 'POSTGRES_USER=probe\nPOSTGRES_DB=probe\nPOSTGRES_PASSWORD=%s\n' "$candidate_db_password"
} | sudo tee "$candidate_db_env" >/dev/null
{
  printf 'NODE_ENV=production\nHOST=0.0.0.0\nPORT=3000\nLOG_LEVEL=info\n'
  printf 'DATABASE_URL=postgresql://probe:%s@db:5432/probe\n' "$candidate_db_password"
  printf 'SESSION_SECRET=%s\n' "$candidate_session_secret"
} | sudo tee "$candidate_env" >/dev/null
sudo chmod 0600 "$candidate_db_env" "$candidate_env"
unset candidate_db_password candidate_session_secret
sudo timeout --foreground 1m docker network create --internal "$probe_network" >/dev/null
sudo timeout --foreground 2m docker run -d --name "$probe_db_container" --network "$probe_network" --network-alias db \
  --env-file "$candidate_db_env" --security-opt no-new-privileges:true "$old_db_image_id" >/dev/null
sudo timeout --foreground 2m sh -c '
  until docker exec "$1" pg_isready -U probe -d probe >/dev/null 2>&1; do sleep 2; done
' sh "$probe_db_container"
sudo timeout --foreground 10m sh -c '
  docker exec -i "$1" pg_restore --exit-on-error --no-owner --no-privileges -U probe -d probe < "$2"
' sh "$probe_db_container" "$backup_dir/database.dump"
candidate_migration_manifest="$backup_dir/candidate-migrations.sha256"
sudo timeout --foreground 30s sha256sum \
  "$candidate_release/server/sql/004_animation_mode_disabled.sql" \
  "$candidate_release/server/sql/005_texas_schema.sql" \
  "$candidate_release/server/sql/006_texas_indexes.sql" \
  "$candidate_release/server/deploy/verify-schema.sql" \
  | sudo tee "$candidate_migration_manifest" >/dev/null
candidate_migration_bundle_sha=$(sudo timeout --foreground 30s sha256sum "$candidate_migration_manifest" | awk '{print $1}')
[[ "$candidate_migration_bundle_sha" =~ ^[0-9a-f]{64}$ ]]
sudo timeout --foreground 5m sh -c '
  cat "$2/server/sql/004_animation_mode_disabled.sql" \
      "$2/server/sql/005_texas_schema.sql" \
      "$2/server/sql/006_texas_indexes.sql" \
    | docker exec -i "$1" psql -X -v ON_ERROR_STOP=1 --single-transaction -U probe -d probe >/dev/null
' sh "$probe_db_container" "$candidate_release"
candidate_schema_receipt="$backup_dir/candidate-schema-receipt.json"
sudo timeout --foreground 2m sh -c '
  docker exec -i "$1" psql -X -qAt -v ON_ERROR_STOP=1 -U probe -d probe < "$2"
' sh "$probe_db_container" "$candidate_release/server/deploy/verify-schema.sql" \
  | sudo tee "$candidate_schema_receipt" >/dev/null
candidate_schema_receipt_sha=$(sudo timeout --foreground 30s sha256sum "$candidate_schema_receipt" | awk '{print $1}')
[[ "$candidate_schema_receipt_sha" =~ ^[0-9a-f]{64}$ ]]
sudo timeout --foreground 2m docker run -d --name "$probe_container" --network "$probe_network" \
  --env-file "$candidate_env" --read-only --tmpfs /tmp:size=32m,mode=1777,noexec,nosuid,nodev \
  --cap-drop ALL --security-opt no-new-privileges:true "$candidate_image_id" >/dev/null
sudo timeout --foreground 2m sh -c '
  until docker exec "$1" node -e "fetch('\''http://127.0.0.1:3000/healthz'\'').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"; do sleep 2; done
' sh "$probe_container"
candidate_receipt="$backup_dir/candidate-image.env"
{
  printf 'candidate_image=%q\n' "$candidate_image"
  printf 'candidate_image_id=%q\n' "$candidate_image_id"
  printf 'tested_sha=%q\n' "$tested_sha"
  printf 'archive_sha256=%q\n' "$archive_sha256"
} | sudo tee "$candidate_receipt" >/dev/null
sudo chmod 0600 "$candidate_receipt"
candidate_receipt_sha=$(sudo timeout --foreground 30s sha256sum "$candidate_receipt" | awk '{print $1}')
printf '%s\n' "$candidate_receipt_sha" | sudo tee "$candidate_receipt.sha256" >/dev/null
sudo chmod 0600 "$candidate_receipt.sha256"
test "$(sudo cat "$candidate_receipt.sha256")" = "$candidate_receipt_sha"
test -e "$candidate_receipt" && test -e "$candidate_receipt.sha256"
cleanup_candidate
trap - EXIT
test ! -e "$candidate_env" && test ! -e "$candidate_db_env" && test ! -e "$candidate_dockerfile"
! sudo timeout --foreground 30s docker container inspect "$probe_container" >/dev/null 2>&1
! sudo timeout --foreground 30s docker container inspect "$probe_db_container" >/dev/null 2>&1
! sudo timeout --foreground 30s docker network inspect "$probe_network" >/dev/null 2>&1
test -e "$candidate_receipt" && test -e "$candidate_receipt.sha256"
```

- [ ] **Step 9: Promote atomically with the live Compose topology**

The live topology is Docker Compose project `zhajinhua`; the application publishes only `127.0.0.1:3100`, PostgreSQL stays in the named volume, and the shared AI Nginx/Cloudflared containers are not recreated. Immediately before this step, read `$expectedRecoveryManifestHash` from the local receipt and verify it equals the value already approved in operator memory; then set `expected_recovery_manifest_sha` in the authenticated remote shell without printing it. No symlink may change until the remote receipt, recovery manifest, approved previous release/image IDs, database image ID, all six AI hashes, all four migration/assertion hashes, and the candidate schema receipt are re-read and match.

Before the symlink commands below, capture a schema-only hash from `zhajinhua-db-1`, execute the hash-verified `004 -> 005 -> 006` files through one `psql -X -v ON_ERROR_STOP=1 --single-transaction` invocation, run `deploy/verify-schema.sql`, and capture the post-migration schema receipt and schema-only hash. Finalize and hash `recovery.env` only after it contains the migration manifest hash plus both schema receipts. Do not switch the symlink or restart the app if any database step fails. The ordinary rollback section intentionally leaves this forward-compatible schema in place.

```powershell
$recoveryReceiptPath = Join-Path $env:TEMP "zhajinhua-$releaseId-recovery.sha256"
$expectedRecoveryManifestHash = (Get-Content -Raw -LiteralPath $recoveryReceiptPath).Trim()
if ($expectedRecoveryManifestHash -notmatch '^[0-9a-f]{64}$') {
  throw 'local recovery receipt drifted'
}
```

Validate the candidate Compose file using the external environment file, atomically switch `/opt/zhajinhua/current`, then run only:

```bash
set -euo pipefail
timeout --foreground 15s sudo -v
sudo -n true
sudo() { command sudo -n "$@"; }
: "${tested_sha:?tested_sha is required}"
: "${archive_sha256:?archive_sha256 is required}"
: "${archive_file_name:?archive_file_name is required}"
: "${release_baseline_sha256:?release baseline SHA is required}"
: "${release_baseline_file_name:?release baseline file name is required}"
[[ "$tested_sha" =~ ^[0-9a-f]{40}$ ]]
[[ "$archive_sha256" =~ ^[0-9a-f]{64}$ ]]
[[ "$release_baseline_sha256" =~ ^[0-9a-f]{64}$ ]]
backup_dir="/opt/zhajinhua/backups/$release_id"
incoming_dir=$(pwd -P)
case "$incoming_dir" in /home/*) ;; *) echo 'incoming directory must be an authenticated user home' >&2; exit 1 ;; esac
incoming_archive="$incoming_dir/$archive_file_name"
baseline_file="$incoming_dir/$release_baseline_file_name"
test -f "$incoming_archive" && test -f "$baseline_file"
test "$(timeout --foreground 30s sha256sum "$baseline_file" | awk '{print $1}')" = "$release_baseline_sha256"
baseline_value() {
  timeout --foreground 30s python3 -c '
import json, sys
value = json.load(open(sys.argv[1], encoding="utf-8"))
for key in sys.argv[2].split("."): value = value[key]
if isinstance(value, (dict, list)) or value is None: print(json.dumps(value, separators=(",", ":")))
elif isinstance(value, (str, int)): print(value)
else: raise SystemExit(2)
' "$baseline_file" "$1"
}
test "$(baseline_value tested_sha)" = "$tested_sha"
test "$(baseline_value archive_sha256)" = "$archive_sha256"
approved_ai_manifest_sha256="$(sudo -n sha256sum "$backup_dir/approved-ai.sha256" | awk '{print $1}')"
: "${expected_recovery_manifest_sha:?expected recovery manifest SHA is required}"
backup_dir="/opt/zhajinhua/backups/$release_id"
remote_recovery_sha=$(sudo cat "$backup_dir/recovery.env.sha256")
test "$remote_recovery_sha" = "$expected_recovery_manifest_sha"
test "$(sudo timeout --foreground 30s sha256sum "$backup_dir/recovery.env" | awk '{print $1}')" = "$expected_recovery_manifest_sha"
source <(sudo cat "$backup_dir/recovery.env")
test "$(sudo timeout --foreground 30s sha256sum "$incoming_archive" | awk '{print $1}')" = "$archive_sha256"
sudo timeout --foreground 2m gzip -t "$incoming_archive"
sudo timeout --foreground 2m tar -tzf "$incoming_archive" | awk '/^\// || /(^|\/)\.\.($|\/)/ || $0 !~ /^(public|server)(\/|$)/ { bad=1 } END { exit bad }'
test "$(sudo timeout --foreground 5m sha256sum "$backup_dir/previous-image.tar.gz" | awk '{print $1}')" = "$image_backup_sha256"
sudo timeout --foreground 5m gzip -t "$backup_dir/previous-image.tar.gz"
sudo timeout --foreground 5m sh -c 'gzip -dc "$1" | tar -tf - >/dev/null' sh "$backup_dir/previous-image.tar.gz"
test "$(sudo timeout --foreground 5m sha256sum "$backup_dir/database.dump" | awk '{print $1}')" = "$database_backup_sha256"
sudo timeout --foreground 5m sh -c 'docker exec -i "$1" pg_restore -l < "$2" >/dev/null' sh zhajinhua-db-1 "$backup_dir/database.dump"
test "$(sudo timeout --foreground 30s sha256sum "$old_compose" | awk '{print $1}')" = "$compose_backup_sha256"
test "$(sudo timeout --foreground 30s sha256sum "$release_baseline_file" | awk '{print $1}')" = "$release_baseline_sha256"
test "$(sudo timeout --foreground 30s sha256sum "$approved_ai_manifest" | awk '{print $1}')" = "$approved_ai_manifest_sha256"
sudo timeout --foreground 2m sha256sum -c "$approved_ai_manifest" >/dev/null
candidate_receipt="$backup_dir/candidate-image.env"
candidate_receipt_sha_file="$candidate_receipt.sha256"
candidate_receipt_sha=$(sudo cat "$candidate_receipt_sha_file")
[[ "$candidate_receipt_sha" =~ ^[0-9a-f]{64}$ ]]
test "$(sudo timeout --foreground 30s sha256sum "$candidate_receipt" | awk '{print $1}')" = "$candidate_receipt_sha"
source <(sudo cat "$candidate_receipt")
[[ "$candidate_image_id" =~ ^sha256:[0-9a-f]{64}$ ]]
candidate_image="local/zhajinhua:$release_id"
candidate_tag_id=$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Id}}')
test "$candidate_tag_id" = "$candidate_image_id"
candidate_image_id="$candidate_tag_id"
candidate_release="/opt/zhajinhua/releases/$release_id"
candidate_compose="$candidate_release/server/deploy/compose.production.yaml"
test -f "$candidate_compose"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Config.User}}')" = "$(baseline_value app_image.user)"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{.Config.WorkingDir}}')" = "$(baseline_value app_image.working_dir)"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{json .Config.Entrypoint}}')" = "$(baseline_value app_image.entrypoint)"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{json .Config.Cmd}}')" = "$(baseline_value app_image.cmd)"
test "$(readlink -f /opt/zhajinhua/current)" = "$old_release"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Config.Image}}')" = "$old_image"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Image}}')" = "$old_image_id"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-db-1 --format '{{.Config.Image}}')" = "$old_db_image"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-db-1 --format '{{.Image}}')" = "$old_db_image_id"
test "$(sudo timeout --foreground 30s sha256sum "$approved_ai_manifest" | awk '{print $1}')" = "$approved_ai_manifest_sha256"
sudo timeout --foreground 2m sha256sum -c "$approved_ai_manifest" >/dev/null
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{index .Config.Labels "org.opencontainers.image.revision"}}')" = "$tested_sha"
test "$(sudo timeout --foreground 30s docker image inspect "$candidate_image" --format '{{index .Config.Labels "zhajinhua.archive.sha256"}}')" = "$archive_sha256"
export APP_IMAGE="$candidate_image"
sudo timeout --foreground --preserve-status 2m env APP_IMAGE="$APP_IMAGE" docker compose -p zhajinhua --env-file "$env_file" -f "$candidate_compose" config --quiet
resolved_images=$(sudo timeout --foreground --preserve-status 2m env APP_IMAGE="$APP_IMAGE" docker compose -p zhajinhua --env-file "$env_file" -f "$candidate_compose" config --images)
grep -Fxq "$APP_IMAGE" <<<"$resolved_images"
sudo ln -sfn "$candidate_release" /opt/zhajinhua/current.next
sudo mv -Tf /opt/zhajinhua/current.next /opt/zhajinhua/current
sudo timeout --foreground --preserve-status 3m env APP_IMAGE="$APP_IMAGE" docker compose -p zhajinhua --env-file "$env_file" -f /opt/zhajinhua/current/server/deploy/compose.production.yaml up -d --no-build --no-deps --wait --wait-timeout 120 app
test "$(readlink -f /opt/zhajinhua/current)" = "$candidate_release"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Config.Image}}')" = "$candidate_image"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Image}}')" = "$candidate_image_id"
```

Do not modify or reload shared Nginx unless its checked configuration actually changed; this application release is expected to change neither Nginx nor Cloudflared configuration.

- [ ] **Step 10: Run production acceptance and rollback on any failure**

```bash
set -euo pipefail
timeout --foreground 15s sudo -v
sudo -n true
sudo() { command sudo -n "$@"; }
curl --resolve crazythursdayplay.bbroot.com:443:127.0.0.1 --connect-timeout 5 --max-time 15 -fsS https://crazythursdayplay.bbroot.com/healthz
curl --resolve crazythursdayplay.bbroot.com:443:127.0.0.1 --connect-timeout 5 --max-time 15 -fsSI https://crazythursdayplay.bbroot.com/
assert_container_ready() {
  local name="$1" require_health="$2" state health
  state=$(sudo timeout --foreground 30s docker inspect "$name" --format '{{.State.Status}}')
  health=$(sudo timeout --foreground 30s docker inspect "$name" --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}')
  test "$state" = 'running'
  if test "$require_health" = 'yes'; then test "$health" = 'healthy'; else test "$health" = 'healthy' -o "$health" = 'none'; fi
}
assert_container_ready zhajinhua-app-1 yes
assert_container_ready zhajinhua-db-1 yes
assert_container_ready ai-platform-domestic-nginx-1 no
assert_container_ready ai-platform-domestic-cloudflared-1 no
sudo timeout --foreground 30s docker exec ai-platform-domestic-nginx-1 nginx -t >/dev/null
sudo timeout --foreground 30s docker exec ai-platform-domestic-cloudflared-1 cloudflared --version >/dev/null
# Public reachability and the shared AI route are checked from an independent
# external Browser session. This host-local gate validates only local SNI/TLS.
test "$(sudo timeout --foreground 30s sha256sum "$approved_ai_manifest" | awk '{print $1}')" = "$approved_ai_manifest_sha256"
sudo timeout --foreground 2m sha256sum -c "$approved_ai_manifest" >/dev/null
```

Use fresh test accounts from an independent external Browser to validate HTTPS registration/login, a two-player room, WSS events, chat, hidden cards, one action, leave/reconnect behavior, leaderboard access, and the database-backed Texas create/join/start/leave path. Every HTTP and WSS probe must have a 5-second connect timeout and a 30-second absolute deadline; the complete Browser acceptance flow has a 5-minute deadline. A timeout is a failed gate and triggers rollback. Refresh the authenticated AI usage page, compare all six AI Nginx hashes, rerun `nginx -t`, and require Nginx/Cloudflared health to remain unchanged from the approved pre-release baseline.

If any gate fails, start a fresh local shell, read `expected_recovery_manifest_sha` from `$recoveryReceiptPath`, and set that one non-secret hash plus the approved `release_id` in a fresh authenticated remote shell. Verify the remote hash receipt and recovery manifest against the local value, validate the image/database/Compose/AI-manifest/migration/schema-receipt hashes, and restore the old image from `previous-image.tar.gz` with a 15-minute deadline if its exact ID is absent. Atomically switch `/opt/zhajinhua/current.rollback` to `$old_release` with `ln -sfn` plus `mv -Tf`, export `APP_IMAGE="$old_image"`, and run only the hash-verified `$old_compose` backup with `docker compose -p zhajinhua ... up -d --no-build --no-deps --wait --wait-timeout 120 app` under a three-minute deadline. Require the symlink target, running image name, and running image ID to equal the manifest values before repeating `/healthz`, HTTPS/WSS, Nginx/Cloudflared health, all AI configuration hashes, and the authenticated AI Browser canary with the same finite deadlines. This application rollback preserves the forward-compatible `004/005/006` schema; never restore `database.dump` automatically because doing so would discard post-migration player writes. Dump restoration requires a separate human-approved downtime disaster-recovery procedure. A failed or unread rollback is a release failure and must be reported without claiming recovery.

```bash
set -euo pipefail
timeout --foreground 15s sudo -v
sudo -n true
sudo() { command sudo -n "$@"; }
: "${release_id:?release_id is required}"
backup_dir="/opt/zhajinhua/backups/$release_id"
: "${expected_recovery_manifest_sha:?expected recovery manifest SHA is required}"
test "$(sudo cat "$backup_dir/recovery.env.sha256")" = "$expected_recovery_manifest_sha"
test "$(sudo timeout --foreground 30s sha256sum "$backup_dir/recovery.env" | awk '{print $1}')" = "$expected_recovery_manifest_sha"
source <(sudo cat "$backup_dir/recovery.env")
test "$(sudo timeout --foreground 5m sha256sum "$backup_dir/previous-image.tar.gz" | awk '{print $1}')" = "$image_backup_sha256"
test "$(sudo timeout --foreground 5m sha256sum "$backup_dir/database.dump" | awk '{print $1}')" = "$database_backup_sha256"
test "$(sudo timeout --foreground 30s sha256sum "$old_compose" | awk '{print $1}')" = "$compose_backup_sha256"
test "$(sudo timeout --foreground 30s sha256sum "$approved_ai_manifest" | awk '{print $1}')" = "$approved_ai_manifest_sha256"
sudo timeout --foreground 2m sha256sum -c "$approved_ai_manifest" >/dev/null
current_old_id=$(sudo timeout --foreground 30s docker image inspect "$old_image" --format '{{.Id}}' 2>/dev/null || true)
if test "$current_old_id" != "$old_image_id"; then
  sudo timeout --foreground 15m sh -c 'gzip -dc "$1" | docker image load >/dev/null' sh "$backup_dir/previous-image.tar.gz"
fi
test "$(sudo timeout --foreground 30s docker image inspect "$old_image" --format '{{.Id}}')" = "$old_image_id"
sudo ln -sfn "$old_release" /opt/zhajinhua/current.rollback
sudo mv -Tf /opt/zhajinhua/current.rollback /opt/zhajinhua/current
export APP_IMAGE="$old_image"
sudo timeout --foreground --preserve-status 3m env APP_IMAGE="$APP_IMAGE" docker compose -p zhajinhua \
  --env-file "$env_file" -f "$old_compose" up -d --no-build --no-deps --wait --wait-timeout 120 app
test "$(readlink -f /opt/zhajinhua/current)" = "$old_release"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Config.Image}}')" = "$old_image"
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.Image}}')" = "$old_image_id"
curl --resolve crazythursdayplay.bbroot.com:443:127.0.0.1 --connect-timeout 5 --max-time 15 -fsS https://crazythursdayplay.bbroot.com/healthz
for container in zhajinhua-app-1 zhajinhua-db-1 ai-platform-domestic-nginx-1 ai-platform-domestic-cloudflared-1; do
  test "$(sudo timeout --foreground 30s docker inspect "$container" --format '{{.State.Status}}')" = 'running'
done
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-app-1 --format '{{.State.Health.Status}}')" = 'healthy'
test "$(sudo timeout --foreground 30s docker inspect zhajinhua-db-1 --format '{{.State.Health.Status}}')" = 'healthy'
sudo timeout --foreground 30s docker exec ai-platform-domestic-nginx-1 nginx -t >/dev/null
sudo timeout --foreground 30s docker exec ai-platform-domestic-cloudflared-1 cloudflared --version >/dev/null
rollback_cloudflared_status=$(curl --connect-timeout 5 --max-time 15 -sS -o /dev/null -w '%{http_code}' -I https://cf.silhouette.ltd/)
[[ "$rollback_cloudflared_status" =~ ^[23][0-9][0-9]$ ]]
sudo timeout --foreground 2m sha256sum -c "$approved_ai_manifest" >/dev/null
```

- [ ] **Step 11: Record evidence and close the workflow**

Create separate evidence for all three frozen tasks. Every file must contain its exact `task_id:` marker; each `validation.md` must contain `validation: passed`, each `review.md` must contain `review: passed`, and every task directory must have its own `result.md`. Task `0000` also owns `release.md`; task `0001` owns the interface/black-box/Browser totals; task `0002` owns the baseline-drift, backup, candidate-isolation, promotion, rollback-readiness, and production acceptance evidence. Record the tested application SHA, application remote SHA, `$workflowSha` and its exact file list, deployed release ID, archive/candidate/recovery/backup hashes and image IDs, previous/final symlink targets and images, test totals, Browser evidence, HTTPS/WSS results, service health, AI route/hash readback, rollback boundary, and residual risks. These files must not claim or contain their own future evidence commit SHA.

Before transitioning state, create `0001.../intent.md` with that task's exact ID and test scope, then write all evidence files completely. Do not change validation or review files after the CLI records their hashes. Move task `0001` through `intake -> planned -> approved -> implementing`, then move each task independently through `implementing -> validating -> reviewing -> reporting -> complete` with task-specific validation, review, and result references:

```powershell
$projectRoot = (Get-Location).Path
$workflowCli = Join-Path $projectRoot 'work-flow/scripts/Invoke-ProjectWorkflow.ps1'
$releaseContextPath = Join-Path $env:TEMP 'zhajinhua-active-release-context.json'
$releaseContextHashPath = "$releaseContextPath.sha256"
$contextExpectedHash = (Get-Content -Raw -LiteralPath $releaseContextHashPath).Trim()
if ($contextExpectedHash -notmatch '^[0-9a-f]{64}$' -or (Get-FileHash -Algorithm SHA256 -LiteralPath $releaseContextPath).Hash.ToLowerInvariant() -ne $contextExpectedHash) { throw 'release context readback failed' }
$context = Get-Content -Raw -LiteralPath $releaseContextPath | ConvertFrom-Json
$releaseId = [string]$context.release_id
$testedSha = [string]$context.tested_sha
if (!$testedSha) { $testedSha = [string](Get-Content -Raw -LiteralPath $context.baseline_path | ConvertFrom-Json).tested_sha }
$releasePlanPath = Join-Path $projectRoot 'docs/superpowers/plans/2026-08-19-zhajinhua-gameplay-closure-plan.md'
if ((Get-FileHash -Algorithm SHA256 -LiteralPath $releasePlanPath).Hash.ToLowerInvariant() -ne [string]$context.plan_sha256) { throw 'release plan changed after approval' }
$releasePlanHash = [string]$context.plan_sha256
$mainDir = 'work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4'
$testDir = 'work-flow/docs/requirements/0001_炸金花接口黑白盒与浏览器验收_L3'
$riskDir = 'work-flow/docs/requirements/0002_炸金花生产发布与回滚审计_L4'
$workflowSha = $null
function Assert-Native([string]$Label) { if ($LASTEXITCODE -ne 0) { throw "$Label failed with exit code $LASTEXITCODE" } }
$mainTaskId = 'be50d92f-59cc-4b99-8286-31b29374c38b'
$testTaskId = 'e842278c-e053-45be-aa35-a144f49b57ab'
$riskTaskId = '71d4428f-ff22-4e8d-bdb8-f09efcb0221b'
$taskRoot = Join-Path $projectRoot 'work-flow/docs/requirements'
$mainDir = 'work-flow/docs/requirements/0000_炸金花牌局体验闭环开发测试提交部署_L4'
$testDir = 'work-flow/docs/requirements/0001_炸金花接口黑白盒与浏览器验收_L3'
$riskDir = 'work-flow/docs/requirements/0002_炸金花生产发布与回滚审计_L4'
$testIntentPath = Join-Path $projectRoot "$testDir/intent.md"
$testIntentHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $testIntentPath).Hash.ToLowerInvariant()
$batchIds = @($mainTaskId, $testTaskId, $riskTaskId)

function Invoke-TaskTransition {
  param([string]$TaskId, [string]$To, [string[]]$ExtraArgs = @())
  $operationId = [guid]::NewGuid().ToString()
  $owner = "workflow-close-$($TaskId.Substring(0,8))"
  & pwsh.exe -File $workflowCli lock acquire --root $projectRoot --task-id $TaskId --role reporter --owner $owner --operation-id $operationId --json
  Assert-Native "acquire $TaskId lock for $To"
  try {
    $state = & pwsh.exe -File $workflowCli state read --root $projectRoot --json | ConvertFrom-Json
    Assert-Native "read revision for $TaskId"
    & pwsh.exe -File $workflowCli transition --root $projectRoot --task-id $TaskId --to $To --expected-revision $state.state.revision --operation-id $operationId @ExtraArgs --json
    Assert-Native "transition $TaskId to $To"
  } finally {
    & pwsh.exe -File $workflowCli lock release --root $projectRoot --task-id $TaskId --role reporter --owner $owner --operation-id $operationId --json
    Assert-Native "release $TaskId lock for $To"
  }
}

Invoke-TaskTransition $testTaskId planned @('--intent-hash', $testIntentHash)
Invoke-TaskTransition $testTaskId approved @(
  '--technical-plan-hash', $releasePlanHash,
  '--authorization-id', 'user-confirmed-2026-08-19-interface-blackbox-browser-tests'
)
$testImplementingArgs = @()
foreach ($taskId in $batchIds) { $testImplementingArgs += @('--batch-task-id', $taskId) }
Invoke-TaskTransition $testTaskId implementing $testImplementingArgs

$taskEvidence = @(
  @{ Id = $mainTaskId; Dir = $mainDir },
  @{ Id = $testTaskId; Dir = $testDir },
  @{ Id = $riskTaskId; Dir = $riskDir }
)
foreach ($task in $taskEvidence) {
  Invoke-TaskTransition $task.Id validating @('--validation-evidence', "$($task.Dir)/validation.md")
  Invoke-TaskTransition $task.Id reviewing
  Invoke-TaskTransition $task.Id reporting @('--review-evidence', "$($task.Dir)/review.md")
  Invoke-TaskTransition $task.Id complete @('--result-ref', "$($task.Dir)/result.md")
}
```

Rerun strict workflow validation in the original workspace and `git diff --check`. In a fresh PowerShell session, read the authoritative `main` baseline from the persisted receipt rather than a terminal variable. Stage the exact evidence allowlist, compare the staged set byte-for-byte, commit, push exactly the resulting commit to `huang`, and independently read both remote refs back:

```powershell
$remoteMainReceiptPath = Join-Path $env:TEMP "zhajinhua-$releaseId-remote-main.txt"
$remoteMainBefore = (Get-Content -Raw -LiteralPath $remoteMainReceiptPath).Trim()
if ($remoteMainBefore -notmatch '^[0-9a-f]{40}$') { throw 'persisted remote main baseline is invalid' }
function Invoke-BoundedGit {
  param([Parameter(Mandatory)][string[]]$Arguments, [int]$TimeoutSeconds = 120)
  $start = [Diagnostics.ProcessStartInfo]::new()
  $start.FileName = 'git'
  $start.UseShellExecute = $false
  $start.RedirectStandardOutput = $true
  $start.RedirectStandardError = $true
  $start.Environment['GIT_TERMINAL_PROMPT'] = '0'
  $start.Environment['GIT_HTTP_LOW_SPEED_LIMIT'] = '1'
  $start.Environment['GIT_HTTP_LOW_SPEED_TIME'] = '30'
  foreach ($argument in $Arguments) { [void]$start.ArgumentList.Add($argument) }
  $process = [Diagnostics.Process]::new()
  $process.StartInfo = $start
  if (!$process.Start()) { throw 'failed to start bounded git command' }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (!$process.WaitForExit($TimeoutSeconds * 1000)) {
    $process.Kill($true)
    $process.WaitForExit()
    throw "git command exceeded ${TimeoutSeconds}s deadline"
  }
  $stdout = $stdoutTask.GetAwaiter().GetResult()
  $stderr = $stderrTask.GetAwaiter().GetResult()
  if ($process.ExitCode -ne 0) { throw "git command failed with exit code $($process.ExitCode): $stderr" }
  return $stdout.TrimEnd()
}
& pwsh.exe -File $workflowCli validate --root $projectRoot --strict --json
Assert-Native 'validate completed workflow'
git diff --check -- work-flow
Assert-Native 'check workflow evidence diff'

$evidenceFiles = @(
  "$mainDir/validation.md", "$mainDir/review.md", "$mainDir/release.md", "$mainDir/result.md",
  "$testDir/intent.md", "$testDir/validation.md", "$testDir/review.md", "$testDir/result.md",
  "$riskDir/release-approval.md", "$riskDir/validation.md", "$riskDir/review.md", "$riskDir/result.md",
  "$mainDir/task-state.md", "$testDir/task-state.md", "$riskDir/task-state.md",
  'work-flow/state.md'
) | Sort-Object -Unique
git add -- $evidenceFiles
Assert-Native 'stage exact workflow evidence allowlist'
$stagedEvidence = @(git diff --cached --name-only) | Sort-Object -Unique
Assert-Native 'read staged workflow evidence'
if (Compare-Object $evidenceFiles $stagedEvidence) { throw 'staged evidence differs from allowlist' }
git diff --cached --check
Assert-Native 'check staged evidence'
git commit -m 'docs(release): 记录炸金花发布证据'
Assert-Native 'commit release evidence'
$evidenceSha = (git rev-parse HEAD).Trim()
Assert-Native 'freeze evidence SHA'
Invoke-BoundedGit -Arguments @('push', 'origin', "${evidenceSha}:refs/heads/huang") | Out-Null
$remoteHuang = ((Invoke-BoundedGit -Arguments @('ls-remote', 'origin', 'refs/heads/huang')) -split '\s+')[0]
$remoteMainAfter = ((Invoke-BoundedGit -Arguments @('ls-remote', 'origin', 'refs/heads/main')) -split '\s+')[0]
if ($remoteHuang -ne $evidenceSha) { throw 'remote huang evidence SHA mismatch' }
if ($remoteMainAfter -ne $remoteMainBefore) { throw 'remote main changed during evidence push' }
```

Record `$evidenceSha` only outside that commit in the root-owned production release receipt and the final operator report, together with the receipt hash. This removes the impossible self-referential commit field.

Remove only exact temporary validation worktrees, transferred archives, stopped build/probe containers, root-only candidate env files, and acceptance accounts/rooms. Keep the verified rollback directory and recovery manifest. Recheck that the deployed application labels still name `$testedSha`, while remote `huang` names `$evidenceSha`; do not conflate those two revisions.
```powershell
$cleanupPaths = @(
  $context.archive_path, $context.baseline_path,
  (Join-Path $env:TEMP "zhajinhua-$releaseId-production-precheck.json"),
  (Join-Path $env:TEMP "zhajinhua-$releaseId-production-precheck.out"),
  (Join-Path $env:TEMP "zhajinhua-$releaseId-remote-main.txt"),
  $releaseContextPath, $releaseContextHashPath
) | Sort-Object -Unique
foreach ($path in $cleanupPaths) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force -ErrorAction Stop }
  if (Test-Path -LiteralPath $path) { throw "temporary artifact remains: $path" }
}
if (Test-Path -LiteralPath $validationRoot) {
  git worktree remove --force $validationRoot
  git worktree prune
}
if (Test-Path -LiteralPath $validationRoot) { throw 'validation worktree remains' }
```

## Self-Review

- Spec coverage: tasks map every requirement in sections 2–9, including 6-seat rotation, default hidden cards, seen multipliers, multi-round betting, 20-round settlement, manual compare targets, reveal rights, side pots, timeouts, disconnect grace, room reclamation, chat, exact manual refill, three leaderboards, multi-titles, effects, persistence exclusions, HTTP/WSS security, browser testing, and L4 release evidence.
- Placeholder scan: Task 10 uses the observed Compose release topology and contains no deployment user/path/service placeholders.
- Type consistency: action names are `see|call|raise|all_in|fold|compare|reveal`; durable fields are `bettingRound`, `roundActedSeats`, `turnStartedAt`, `turnDeadlineAt`, `revealed`, and `mayReveal`; leaderboard kinds are `wealth|wins|losses`; refill input is `confirmationText`.
