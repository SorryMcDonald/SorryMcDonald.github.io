# 德州扑克后端部署说明

## 运行边界

德州页面不是纯 GitHub Pages 游戏。浏览器只访问同域的 Node.js REST API 与 WebSocket，牌、行动合法性、边池和结算全部由后端控制。生产环境需要 Node.js 22、PostgreSQL 16、Nginx HTTPS/WSS；仅刷新 GitHub Pages 不能启动后端。

当前生产拓扑是 `compose.production.yaml` 中的单一 `app` 进程加 PostgreSQL。`app` 同时承载 HTTP、WebSocket、行动超时、断线宽限和空房回收，是实时房间的唯一权威进程。不要启用拆分的 API、WebSocket 或 Worker systemd 示例；多进程会破坏内存房间生命周期的一致性。德州房间在最后一名玩家和观战者离开后立即从内存与数据库回收，聊天和运行态同时清空。

## SQL 执行顺序

在 PostgreSQL 或 Supabase SQL Editor 中按顺序完整执行：

1. `server/sql/001_schema.sql`
2. `server/sql/002_indexes.sql`
3. `server/sql/003_room_state.sql`
4. `server/sql/004_animation_mode_disabled.sql`
5. `server/sql/005_texas_schema.sql`
6. `server/sql/006_texas_indexes.sql`

生产升级只执行尚未上线的 `004 -> 005 -> 006`。必须先完成并校验 PostgreSQL 自定义格式备份，再对候选克隆库执行：

```bash
psql -X -v ON_ERROR_STOP=1 --single-transaction \
  -f server/sql/004_animation_mode_disabled.sql \
  -f server/sql/005_texas_schema.sql \
  -f server/sql/006_texas_indexes.sql
```

三个文件的 SHA-256、执行前和执行后的 schema 指纹必须进入发布回执。`IF NOT EXISTS` 不能证明已有对象结构正确，执行后还必须精确校验 `users_animation_mode_check`、9 个 `texas_*` 表、索引和触发器，并跑一次真实数据库德州建房、入座、开局和离房流程。正式库也使用同一哈希绑定的迁移包和单事务执行，任何 SQL 或后置断言失败都停止发布。

## 进程配置

API 环境至少包含：

```text
NODE_ENV=production
DATABASE_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
SESSION_SECRET=替换为高强度随机值
HOST=127.0.0.1
PORT=3000
```

生产不启动独立 Worker。行动超时和断线退出由单一 `app` 进程管理；空房在完成持久化后立即回收。`server/src/worker-entry.js` 只保留为历史兼容入口，不属于当前 Compose 发布拓扑。

## 验证

```bash
cd server
npm ci
npm run test:run
node src/index.js
```

通过 Nginx 将 `/api/`、`/ws` 和静态资源都转发到 API 进程，然后访问 `/dezhou.html`。`/healthz` 是进程存活检查，不代表数据库 schema 已就绪；发布门禁必须另跑 schema 后置断言和真实数据库流程。本地未连接真实 PostgreSQL 时，测试只能证明内存状态机和 SQL 契约，不能替代候选克隆库迁移演练。

应用回滚采用 schema-forward：回退应用和镜像时保留 `004/005/006` 新增或放宽的对象，不能自动恢复发布前数据库备份覆盖上线后的玩家写入。数据库 dump 只用于另行人工批准、明确停机的数据灾难恢复。
