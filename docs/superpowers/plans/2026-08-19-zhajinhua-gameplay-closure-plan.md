# Zhajinhua Gameplay Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver the approved six-seat, hidden-card, multi-round Zhajinhua experience with lifecycle control, chat, manual refill, three leaderboards, responsive UI, automated coverage, GitHub publication, and rollback-safe production deployment.

**Architecture:** Keep `RoomService` as the deterministic state machine, add a per-room `RoomLifecycleController` for timers and connection-driven changes, and keep `WebSocketGateway` as an authenticated transport. Derive visibility and titles on the server, persist only durable room state, and keep chat and timers in memory. Exercise the same public HTTP/WSS surface from Vitest and Playwright before promoting the exact tested Git revision.

**Tech Stack:** Node.js 22, Fastify 5, PostgreSQL, `ws`, Vitest 3, Playwright, vanilla HTML/CSS/JavaScript, Nginx, systemd.

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

- [ ] **Step 1: Run static, full-suite, and workflow checks**

```powershell
npm test -- --run
npm run test:e2e
python ..\work-flow\scripts\workflow.py validate --root "F:\study\zhajinhua" --strict --json
git diff --check
git status --short
```

Expected: every command exits 0; only intended task files are changed or committed.

- [ ] **Step 2: Perform a focused code and L4 risk review**

Review card secrecy, integer economy mutations, idempotent settlement/refill, stale timers, room reclamation, XSS-safe chat, credential hygiene, deployment rollback, and unchanged AI platform proxy routes. Record `review: passed` only when no blocking finding remains.

- [ ] **Step 3: Verify with the Browser plugin**

At desktop and mobile viewports, verify page identity, nonblank DOM, no framework overlay, console health, screenshots, registration, room create/join/start, self south seat, card backs, see, raise, compare target, chat, leaderboard navigation, and refill dialog. Save screenshots outside the repository.

- [ ] **Step 4: Push the reviewed branch**

```powershell
git fetch origin huang
git rebase origin/huang
git push origin huang
```

Expected: remote `huang` points to the exact locally tested commit; `main` remains unchanged.

- [ ] **Step 5: Capture production backup and stage the exact revision**

```bash
ssh maintain@47.102.218.42 'sudo tar -C /opt -czf /var/backups/zhajinhua-pre-$(date +%Y%m%d%H%M%S).tgz zhajinhua && sudo systemctl is-active zhajinhua-api zhajinhua-ws nginx'
git archive --format=tar origin/huang | ssh maintain@47.102.218.42 'mkdir -p /tmp/zhajinhua-release && tar -xf - -C /tmp/zhajinhua-release'
```

Expected: backup path and pre-release service states are recorded without exposing credentials or private keys.

- [ ] **Step 6: Validate candidate and promote atomically**

On the server, install with `npm ci --omit=dev`, run the production runtime checks against the candidate, keep the existing environment and TLS files outside the release, then switch the application release symlink. Run `nginx -t`, restart only the Zhajinhua units, and reload Nginx only if its checked configuration changed.

- [ ] **Step 7: Run production acceptance and rollback on failure**

```bash
curl -fsS https://crazythursdayplay.bbroot.com/healthz
curl -fsSI https://crazythursdayplay.bbroot.com/
systemctl is-active zhajinhua-api zhajinhua-ws nginx cloudflared
```

Use fresh test accounts to validate HTTPS registration/login, a two-player room, WSS events, chat, hidden cards, one action, leave/reconnect behavior, and leaderboard access. If any gate fails, restore the previous release symlink and service state, then rerun health checks before reporting the release as failed.

- [ ] **Step 8: Record hashes and close the workflow**

Record local commit SHA, remote `huang` SHA, deployed release SHA, backup reference, test totals, Browser evidence, HTTPS/WSS results, service health, rollback boundary, and residual risks. Remove only deployment staging material and temporary test accounts that were created for acceptance; do not delete user data or unrelated services.

## Self-Review

- Spec coverage: tasks map every requirement in sections 2–9, including 6-seat rotation, default hidden cards, seen multipliers, multi-round betting, 20-round settlement, manual compare targets, reveal rights, side pots, timeouts, disconnect grace, room reclamation, chat, exact manual refill, three leaderboards, multi-titles, effects, persistence exclusions, HTTP/WSS security, browser testing, and L4 release evidence.
- Placeholder scan: every implementation and test step names its owning file, contract, command, and expected state; no deferred work marker remains.
- Type consistency: action names are `see|call|raise|all_in|fold|compare|reveal`; durable fields are `bettingRound`, `roundActedSeats`, `turnStartedAt`, `turnDeadlineAt`, `revealed`, and `mayReveal`; leaderboard kinds are `wealth|wins|losses`; refill input is `confirmationText`.
