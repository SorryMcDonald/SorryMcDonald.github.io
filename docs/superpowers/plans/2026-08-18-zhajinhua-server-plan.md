# 炸金花自建服务器版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** 将当前 Supabase 直连静态牌桌迁移为一台 Ubuntu/Debian 服务器上的 Node.js + PostgreSQL + WebSocket 多人游戏服务，并完成已确认的牌局、账号、观战、榜单和交互需求。

**Architecture:** HTTP API 负责认证、房间和动作提交；游戏 Worker 以 PostgreSQL advisory lock 为每个房间提供唯一权威状态；WebSocket 网关消费 PostgreSQL 事件并广播给玩家、观战者和全站横幅频道。浏览器只访问服务器，不再直连 Supabase。

**Tech Stack:** Node.js 22 ESM, Fastify, pg, ws, Argon2id, PostgreSQL 16, Vitest, Playwright, systemd/Nginx。

---

## 文件边界

- Create: server/package.json, server/src/config.js, server/src/index.js
- Create: server/src/db/pool.js, server/src/db/queries.js, server/sql/001_schema.sql, server/sql/002_indexes.sql
- Create: server/src/auth/password.js, server/src/auth/session.js, server/src/auth/routes.js
- Create: server/src/game/rules.js, server/src/game/worker.js, server/src/game/events.js
- Create: server/src/rooms/routes.js, server/src/rooms/service.js, server/src/leaderboard/routes.js
- Create: server/src/ws/gateway.js, server/src/migration/supabase-export.js, server/src/migration/claim.js
- Create: server/tests/rules.test.js, server/tests/economy.test.js, server/tests/auth.test.js, server/tests/ws.test.js
- Create: server/scripts/admin-reset-password.js, server/scripts/migrate-supabase.js
- Create: public/index.html, public/app.js, public/styles.css, public/audio/README.md
- Modify: zhajinhua.html only as a compatibility redirect to the server root after the new client is available.
- Modify: zhajinhua_修改说明.md and zhajinhua_online_说明.md to point to the self-hosted server and remove stale Supabase-only instructions.

### Task 1: Scaffold the server and test runner

**Files:** server/package.json, server/src/config.js, server/src/index.js, server/tests/smoke.test.js

- [x] Write a failing smoke test:

~~~js
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/index.js';

describe('server bootstrap', () => {
  it('serves a health response without a real database', async () => {
    const app = await buildApp({ logger: false, db: { query: async () => ({ rows: [] }) } });
    const response = await app.inject({ method: 'GET', url: '/healthz' });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    await app.close();
  });
});
~~~

- [x] Run from server: npm install; npm test -- --run tests/smoke.test.js. Expected: FAIL because buildApp and package.json do not exist.
- [x] Add package type module, scripts test/test:run/dev, Fastify and test dependencies. Export buildApp from server/src/index.js and register GET /healthz.
- [x] Run npm run test:run -- tests/smoke.test.js. Expected: one passing test.

### Task 2: Add PostgreSQL schema and repositories

**Files:** server/sql/001_schema.sql, server/sql/002_indexes.sql, server/src/db/pool.js, server/src/db/queries.js, server/tests/db-schema.test.js

- [ ] Write a schema contract test that reads 001_schema.sql and asserts users, sessions, rooms, room_players, room_spectators, rounds, round_players, account_ledger, global_banners, legacy_migrations, a lower-case email uniqueness constraint, and a unique idempotency_key.
- [ ] Run npm run test:run -- tests/db-schema.test.js. Expected: FAIL because the schema file is absent.
- [ ] Create the schema with UUIDs, bigint balances, jsonb hands, timestamps, room status checks, nonnegative balance checks, optimistic version, a partial unique index preventing one account from holding two active seats, and a notify_game_event trigger that writes an event row then calls pg_notify after commit.
- [ ] Export parameterized getUserById, getUserByEmail, createUser, getRoomForUpdate, getRoomPlayers, appendLedgerEntry, updateUserBalance, appendGameEvent, and getLeaderboard. Never interpolate user text into SQL.
- [ ] Run the contract test again. Expected: all assertions pass.

### Task 3: Implement password hashing and sessions

**Files:** server/src/auth/password.js, server/src/auth/session.js, server/src/auth/routes.js, server/src/index.js, server/tests/auth.test.js

- [ ] Write failing tests for unique registration, duplicate email/nickname rejection, login, logout, 401 without a session, and Argon2id-only stored hashes.
- [ ] Run npm run test:run -- tests/auth.test.js. Expected: FAIL because auth routes do not exist.
- [ ] Implement Argon2id hashing, SHA-256 hashes of 32-byte random session tokens, HttpOnly/Secure/SameSite=Lax cookies, seven-day expiry, and registration that creates 100000 beans in one transaction. Do not add email verification or self-service password reset.
- [ ] Run the auth tests. Expected: all tests pass.

### Task 4: Implement pure game rules with TDD

**Files:** server/src/game/rules.js, server/tests/rules.test.js

- [ ] Write failing tests for evaluateHand, compareHands, calculateSidePotPayouts, netChange, selectDealer, shouldSettle, and buildCompareEvents. Include:

~~~js
expect(selectDealer([
  { seat: 2, net: 50, settledOrder: 1 },
  { seat: 4, net: 50, settledOrder: 2 },
]).seat).toBe(4);
expect(shouldSettle({ alive: 3, actionable: 2, allMatched: false, allActed: true })).toBe(false);
expect(shouldSettle({ alive: 3, actionable: 0, allMatched: true, allActed: true })).toBe(true);
expect(buildCompareEvents({ attacker: '甲', target: '乙', fee: 20, attackerWon: true })).toEqual([
  { type: 'compare_started', attacker: '甲', target: '乙', fee: 20 },
  { type: 'compare_resolved', winner: '甲', loser: '乙' },
]);
~~~

- [ ] Run npm run test:run -- tests/rules.test.js. Expected: FAIL because rules.js is absent.
- [ ] Port the existing hand ranking and side-pot logic into dependency-free functions. shouldSettle must ignore one all_in, and return true only for one-or-fewer alive players, zero actionable players, or all actionable players matched and acted. netChange returns payout minus total contribution.
- [ ] Run the rule tests. Expected: all tests pass.

### Task 5: Implement room actions and the authoritative Worker

**Files:** server/src/rooms/service.js, server/src/rooms/routes.js, server/src/game/worker.js, server/src/game/events.js, server/src/index.js, server/tests/economy.test.js

- [ ] Write failing tests for room creation, eight-player limit, one active seat per account, action sequence rejection, all-in continuation, compare visibility, settlement idempotency, next-dealer selection, manual next-round start, and second-highest fallback.
- [ ] Run npm run test:run -- tests/economy.test.js. Expected: FAIL because services and Worker are absent.
- [ ] Expose POST /api/rooms, POST /api/rooms/:roomId/join, POST /api/rooms/:roomId/actions, POST /api/rooms/:roomId/start-next, POST /api/rooms/:roomId/leave, POST /api/rooms/:roomId/spectate, POST /api/rooms/:roomId/observe, and GET /api/rooms/:roomId.
- [ ] Insert each action with round_id, user_id, action_seq uniqueness and wake the Worker. The Worker locks the room, checks the current turn, applies the action, and writes events; HTTP handlers never update users.beans directly.
- [ ] In one transaction lock involved accounts in sorted UUID order, calculate side pots, append debit/credit ledger entries with deterministic idempotency keys, update balances and win/loss counts, select the next dealer, create round_settled, and create zero-balance claim state.
- [ ] Run economy tests. Expected: all transaction and Worker tests pass.

### Task 6: Add WebSocket gateway and global streams

**Files:** server/src/ws/gateway.js, server/tests/ws.test.js

- [ ] Write failing tests proving players receive room events, spectators receive full cards only when allow_spectators is true, rooms are isolated, and all clients receive ordered global banner events.
- [ ] Run npm run test:run -- tests/ws.test.js. Expected: FAIL because the gateway is absent.
- [ ] Implement a ws cookie/session handshake, room and global socket maps, PostgreSQL LISTEN zhajinhua_events, event lookup after commit, and payload filtering. Compare events have no cards or type names; settlement and observer payloads follow the approved visibility rules.
- [ ] Run WebSocket tests. Expected: all isolation tests pass.

### Task 7: Add leaderboards, titles, banners, and refill

**Files:** server/src/leaderboard/routes.js, server/src/game/worker.js, server/src/game/events.js, server/tests/leaderboard.test.js

- [ ] Write failing tests for count-only ordering, stable nickname ties, the six confirmed titles, equal-rank gambler priority, one refill per zero state, and conditional top-loser banners.
- [ ] Run npm run test:run -- tests/leaderboard.test.js. Expected: FAIL because leaderboard and claim logic are absent.
- [ ] Expose GET /api/leaderboards?kind=wins|losses and POST /api/me/refill. Refill requires beans = 0, creates one zero-state claim token, appends a refill ledger entry with a unique key, sets balance to 100000, emits the fixed banner, and emits the top-loser banner only when the recalculated rank is first.
- [ ] Run leaderboard tests. Expected: all assertions pass.

### Task 8: Implement Supabase export and legacy claims

**Files:** server/src/migration/supabase-export.js, server/src/migration/claim.js, server/scripts/migrate-supabase.js, server/tests/migration.test.js

- [ ] Write failing tests for line-count/hash reporting, maximum balance selection across rooms, idempotent import, old-session subject validation, and merge into an existing email account without logging service credentials.
- [ ] Run npm run test:run -- tests/migration.test.js. Expected: FAIL because migration modules are absent.
- [ ] Require SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MIGRATION_SOURCE_HASH, and an explicit --apply flag. Default output contains counts, schema, hashes, and redacted IDs only. For each old user_id select the maximum nonnegative players.chips and store source IDs with a unique migration key before applying.
- [ ] Validate an old Supabase access token through the Auth admin API, issue a short-lived signed claim, and require the new email session to redeem it. Merge balance and verifiable history in one transaction. Never log tokens or passwords.
- [ ] Run migration tests. Expected: all tests pass.

### Task 9: Replace the browser client

**Files:** public/index.html, public/app.js, public/styles.css, public/audio/README.md, server/src/index.js, zhajinhua.html, server/tests/client-contract.test.js

- [ ] Write failing contract tests for the fixed disclaimer, top navigation leaderboard button, spectator controls, music/cinematic toggles, and absence of Supabase URL/key or direct database client.
- [ ] Run npm run test:run -- tests/client-contract.test.js. Expected: FAIL because the new public client is absent.
- [ ] Move the table markup into public/index.html, styles into public/styles.css, and API/WebSocket/rendering into public/app.js. Add email login, manual next-round, compare notices/result, observer full cards, standalone leaderboard, global ticker, safe textContent rendering, and no direct database access.
- [ ] Add light/cinematic classes, reduced-motion handling, press/deal/chip/compare/settle transitions, an audio element with separate music/effect controls, autoplay attempt without prompt on rejection, and GET/PATCH /api/me/settings persistence.
- [ ] Run npm run test:run -- tests/client-contract.test.js. Expected: all contract tests pass.

### Task 10: Browser acceptance and deployment artifacts

**Files:** server/tests/e2e/playwright.config.js, server/tests/e2e/game.spec.js, server/deploy/zhajinhua-api.service, server/deploy/zhajinhua-worker.service, server/deploy/zhajinhua-ws.service, server/deploy/nginx.conf.example, zhajinhua_修改说明.md, zhajinhua_online_说明.md

- [ ] Write browser scenarios for registration/login, create/join, manual next-round, all-in continuation, compare visibility, observer cards, both leaderboards, refill, global banners, audio preference, and disclaimer.
- [ ] Run npm run test:e2e against a local PostgreSQL test database. Expected: all scenarios pass with no console errors or failed WebSocket connections.
- [ ] Add systemd units using a dedicated unprivileged user, env files outside the web root, restart-on-failure, separate logs, and an Nginx example proxying /api, /ws, and static / over HTTPS.
- [ ] Update both Markdown guides with PostgreSQL setup, admin reset, migration dry-run/apply, backups, and the statement that production migration is incomplete until the observation checklist passes.
- [ ] Run the complete verification command:

~~~powershell
npm run test:run
npm run test:e2e
node scripts/migrate-supabase.js --dry-run --report migration-report.json
~~~

Expected: unit/integration tests pass, browser tests pass, and the migration report contains counts/hashes only with no credentials.

## Self-review checklist

- Every approved design section maps to tasks: architecture (1-6), database/migration (2/8), rules (4/5), UI/audio/observer (9), testing/deployment (10).
- The all-in rule distinguishes one all-in from the no-actionable-players settlement condition.
- The manual next-round rule removes the existing auto-start timer.
- Compare events never carry cards or type names before settlement.
- Ledger idempotency covers bets, settlement, and refill.
- No task places Supabase credentials in the browser.
- No unfinished placeholder or unspecified edge-case step remains.
