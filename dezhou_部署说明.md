# 德州扑克后端部署说明

## 运行边界

德州页面不是纯 GitHub Pages 游戏。浏览器只访问同域的 Node.js REST API 与 WebSocket，牌、行动合法性、边池和结算全部由后端控制。生产环境需要 Node.js 22、PostgreSQL 16、Nginx HTTPS/WSS；仅刷新 GitHub Pages 不能启动后端。

当前 API 进程同时承载 HTTP 和 WebSocket，是实时房间的唯一权威进程。Worker 只关闭没有在座玩家的空房，并清空保留期之外关闭房间的运行态；手牌、行动和资金审计记录不会被级联删除。Worker 不会按时间替任何玩家弃牌或推进牌局。

## SQL 执行顺序

在 PostgreSQL 或 Supabase SQL Editor 中按顺序完整执行：

1. `server/sql/001_schema.sql`
2. `server/sql/002_indexes.sql`
3. `server/sql/003_room_state.sql`
4. `server/sql/005_texas_schema.sql`
5. `server/sql/006_texas_indexes.sql`

`005` 和 `006` 是本次德州新增 SQL，可直接粘贴执行。现有 `004_animation_mode_disabled.sql` 必须先执行；所有语句均使用 `IF NOT EXISTS` 或先删除同名触发器，适合重复检查；正式库执行前仍应备份。

## 进程配置

API 环境至少包含：

```text
NODE_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
SESSION_SECRET=替换为高强度随机值
HOST=127.0.0.1
PORT=3000
```

Worker 使用同一 `DATABASE_URL`，可选配置：

```text
ROOM_CLEANUP_INTERVAL_MS=300000
CLOSED_ROOM_RETENTION_HOURS=720
```

房间保留值最小为 24 小时。清理逻辑不会检查玩家行动时间，因此不存在超时自动弃牌。

## 验证

```bash
cd server
npm ci
npm run test:run
node src/index.js
```

通过 Nginx 将 `/api/`、`/ws` 和静态资源都转发到 API 进程，然后访问 `/dezhou.html`。本地未连接真实 PostgreSQL 时，测试只能证明内存状态机和 SQL 契约，不能替代真实数据库迁移演练。
