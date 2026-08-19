# 炸金花联机版 · 部署说明

## 一、Supabase 配置（一次性）

1. 注册 https://supabase.com，创建一个新项目（免费版即可）
2. 进入项目 **SQL Editor**，粘贴并运行 `zhajinhua_supabase.sql` 的完整内容
3. 打开 **Authentication → Providers → Email**，启用 **Anonymous sign-ins**（匿名登录）
4. 拿到两个值（在 **Project Settings → API** 页面）：
   - Project URL（形如 `https://xxxx.supabase.co`）
   - anon public key

5. 打开 `zhajinhua_online.html`，找到顶部这两行，替换成你的值：
   ```js
   const SUPABASE_URL = 'https://YOUR-PROJECT.supabase.co';
   const SUPABASE_ANON_KEY = 'YOUR-ANON-KEY';
   ```

## 二、运行

把 `zhajinhua_online.html` 部署到任意静态托管（GitHub Pages / Netlify / Vercel），
或者本地双击打开（Realtime 走 Supabase 服务器，本地打开也能联机）。

玩家 A 打开页面 → 输入昵称 → 创建房间 → 得到房号。
玩家 B 打开页面 → 输入昵称 → 加入房间 → 输入房号。
房主等至少 2 人后点「开始游戏」。

## 三、当前状态（重要）

- ✅ SQL 建表脚本：完整（rooms / players / hands 三张表 + RLS 手牌隐私 + Realtime）
- ✅ 前端框架：登录、创建/加入房间、Realtime 订阅、牌型判定、UI
- ⚠️ 房主权威游戏循环（洗牌发牌 → 推进回合 → 结算）是骨架，**还需完善和联调**

联机版比单机版复杂得多，核心难点在「房主权威推进回合」的状态机 ——
房主需要监听每个玩家的操作（跟注/加注/看牌/弃牌/押满），据此推进回合、更新底池注额、判定摊牌时机。

这块我建议继续迭代完善，你先把 Supabase 项目建好，我接着把房主推进回合和结算逻辑补完整、调通。
## 自建服务器部署边界

生产环境使用 Ubuntu/Debian、Node.js 22、PostgreSQL 16、Nginx HTTPS/WSS。先执行两个 SQL 迁移，再以受保护的 `/etc/zhajinhua/*.env` 启动 API、Worker 和 WebSocket 三个进程。`server/deploy` 目录提供 systemd 与 Nginx 示例。

Supabase 导出默认只生成数量、哈希、余额最高值和脱敏 ID；只有显式 `--apply` 才允许导入。导入前必须完成数据库备份、临时库抽样、旧会话声明校验和回滚演练。未完成观察清单前，部署状态保持“迁移未完成”。
