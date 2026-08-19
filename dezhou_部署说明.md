# 德州扑克 Supabase 版部署说明

## 版本边界

本说明只适用于 `dezhou-supabase` 分支。这个版本由 GitHub Pages 托管静态页面，浏览器使用 Supabase 匿名认证、PostgreSQL RPC 和 Realtime，不需要 Node.js、Nginx 或自有服务器。

牌堆、底牌、合法操作、行动顺序、全押、主池/边池和结算都在 `security definer` 数据库函数中完成。浏览器只能取得自己的底牌；摊牌后可见牌和房主明确开启的观战明牌除外。没有行动倒计时，也没有超时自动弃牌。

## 第一步：开启匿名认证

在 Supabase Dashboard 打开 `Authentication` -> `Providers` -> `Anonymous Sign-Ins`，启用匿名登录。这里不是关闭认证：匿名用户仍会获得独立的 `auth.users` ID，并以 `authenticated` 角色调用 RPC。

## 第二步：执行 SQL

在仓库中打开 `dezhou_supabase.sql`，进入文件的 Raw/原始内容页面，全选并复制正文。然后在 Supabase SQL Editor 新建查询，粘贴后执行一次。

第一行应该是 SQL 注释：

```sql
-- ============================================================
```

如果第一行是下面这种内容，说明复制的是 Git 补丁，不能执行：

```text
diff --git a/... b/...
```

SQL 会创建所有 `texas_sb_` 前缀对象、RLS、RPC 授权、`texas_sb_rooms` Realtime 发布和可选的空房清理任务。`pg_cron` 未启用时会跳过定时任务，不影响游戏；可在 Dashboard 的 Extensions 中启用 `pg_cron` 后再次执行整份 SQL。

## 第三步：检查前端配置

编辑 `public/supabase-config.js`：

```js
export const SUPABASE_URL='https://你的项目.supabase.co';
export const SUPABASE_ANON_KEY='你的 anon 或 publishable key';
```

Anon/publishable key 本来就用于浏览器，可以提交到静态网页。绝不能把 `service_role` 或 secret key 写入 HTML、JavaScript 或 GitHub 仓库。

当前分支配置沿用炸金花页面使用的 Supabase 项目。如果德州使用另一个项目，需要同时替换 URL 和 Anon Key，并在那个项目中重新执行 SQL。

## 第四步：发布 GitHub Pages

根目录 `dezhou.html` 会跳转到实际页面 `public/dezhou.html`。发布后入口是：

```text
https://sorrymcdonald.github.io/dezhou.html
```

推送分支不等于线上立即切换。只有 GitHub 仓库 `Settings` -> `Pages` 当前配置为发布 `dezhou-supabase` 分支，或把该分支合并到 Pages 正在发布的分支后，刷新线上页面才会使用本版本。

## 上线检查

1. 匿名进入后可以创建公开房间，另一浏览器点击手动刷新后能看到房间。
2. 开局后后加入的玩家显示等待下一手，不能参与当前手。
3. 非当前玩家没有操作权限；跟注、过牌、加注和全押按钮来自数据库返回的 `allowedActions`。
4. 不同筹码量全押会拆分主池和边池，未被跟注的多余筹码通过单人边池返还。
5. 刷新页面可恢复房间；主动退出会清除座位，牌局中退出按弃牌处理并在结算后返还剩余筹码。
6. 一手结算后不会自动开下一手，只能由房主点击“开始下一手”。
7. 空房超过 6 小时才会由可选清理任务关闭；有在座玩家的房间不会因超时被推进、弃牌或关闭。
