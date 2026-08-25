# Texas 缩放方向与牌桌裁切修复发布回执

## 发布信息

- 发布时间：2026-08-25（Asia/Shanghai）
- 公网地址：`https://crazythursdayplay.bbroot.com/dezhou.html`
- 目标分支：`huang`
- 部署提交：`d7c5c86529e3a24355884e40daed8729a95cceb6`
- 远端合并基线：`0180163a9ec4a6cd2a85278f001970d9020214da`
- 发布标识：`20260825T062632Z-d7c5c86529e3`
- 发布归档 SHA-256：`2bcbb8e44d4d506724a3e29fb571196c1ad7c4679c2f55499159ee2dfed9367c`
- 镜像 ID：`sha256:db0bfd7c9eb7f3396858acd55e740da77bb05f376cd7aa0e30f52437aa00641f`
- 数据库迁移：无；发布前、隔离候选和发布后 schema verifier 均为 level 10

## 合并与提交

- 发布前两次 fetch 和一次 `git ls-remote` 均确认 `origin/huang` 为 `0180163a9ec4a6cd2a85278f001970d9020214da`。
- `git merge --ff-only origin/huang` 返回 `Already up to date`，因此没有制造空 merge commit。
- 本地两文件修复与 managed workflow 记录提交为 `d7c5c86529e3a24355884e40daed8729a95cceb6`。
- 非强制推送后，本地 HEAD、tracking ref 和 GitHub `refs/heads/huang` 独立读回一致；`origin/main` 保持 `07af1264e8103d5c29fbabf4c79be559ba819059`。

## 变更范围

- Texas 牌桌在桌面缩放场景使用稳定的 `42rem` 上限，缩放方向与浏览器预期一致。
- 短高度视口允许页面滚动，避免牌桌和操作栏被固定视口裁切。
- 新增 Playwright 回归，覆盖 80%、100%、125% 等效视口以及开局后操作栏边界。
- 未修改炸金花共享样式 `public/styles.css`，未修改数据库、Nginx 或 Cloudflared 配置。

## 本地门禁

- `npm ci`：审计 154 个包，0 漏洞。
- Vitest：27 个文件、187 项测试通过。
- Playwright：9 项测试通过，其中 Texas 专项 4/4 通过。
- Node 语法检查：73 个 JavaScript 文件通过。
- `git diff --check` 和 staged secret-shaped value 检查通过。
- workflow strict validation：`valid: true`，0 issues。

## 候选与原子发布

- 当前生产 release 为 `/opt/zhajinhua/releases/20260824T031134Z-fa2dc92a0d09`，应用镜像为 `local/zhajinhua:20260824T031134Z-fa2dc92a0d09`。
- 当前镜像中的 `package.json`、`package-lock.json` 与候选归档哈希完全一致；候选以当前生产镜像为离线依赖基底，仅覆盖 `server/src`、`server/sql` 和 `public`。
- 生产数据库自定义格式 dump 已在隔离 PostgreSQL 容器中用 `--no-owner --no-privileges` 恢复；候选通过 schema level 10、`/healthz`、`/dezhou.html`、Texas CSS marker 和 `/doudizhu.html` 检查。
- 生产通过 `/opt/zhajinhua/current` 原子 symlink 与 Compose `app` 单服务切换；PostgreSQL、Nginx、Cloudflared 的容器 ID、镜像和重启计数保持不变。

## 回滚与备份

- 备份目录：`/opt/zhajinhua/backups/20260825T062632Z-d7c5c86529e3`。
- 上一 release：`/opt/zhajinhua/releases/20260824T031134Z-fa2dc92a0d09`。
- 上一镜像：`local/zhajinhua:20260824T031134Z-fa2dc92a0d09`。
- 上一镜像 ID：`sha256:478ca38f3f71b2ebcb4e5563fd46928c2cb2108b48016ec08425e1b0b454d150`。
- recovery manifest SHA-256：`3503c5f6b198edf6ee4c42dfeb21d39431519dbd72e6bc2f46586fcbed149d9b`。
- promotion receipt SHA-256：`612aab19b58adf3c2e6414d25e9ee99c0dc578d86d29fd4ce39915d337275cc1`。
- 自动回滚边界仅恢复旧 symlink 和旧 app 镜像；数据库 dump 仅供另行批准的灾难恢复使用。

## 发布后验收

- 应用、PostgreSQL、AI Nginx、Cloudflared 均为 `running/healthy`，重启次数均为 0。
- 应用运行镜像、OCI revision、archive hash 与锁定提交/归档一致。
- 两次服务器本机健康采样间隔 31 秒，均返回 `{"ok":true}`。
- 发布后 schema verifier 为 level 10。
- Nginx 11 个配置文件的聚合 SHA-256 发布前后均为 `8141a5230a271e60e6a0586418aaf58c03425db1edba6fa2f37e52739aa50085`，配置测试通过。
- 独立 Node HTTPS 探针确认 `/healthz`、`/dezhou.html`、`/dezhou.css`、`/doudizhu.html` 均为 HTTP 200，两个 Texas CSS 修复标记均存在。
- Browser 确认页面标题、登录界面和生产样式表链接正常，控制台错误/警告为 0。

## 残余边界

- 为避免创建生产账号或牌局，本次未在生产主动进入一桌 Texas 对局；主动牌桌缩放和操作栏边界由本地 Playwright 真实浏览器回归证明，公网精确 CSS 资产由独立 HTTPS 探针证明。
- Browser 截图接口两次超时，未形成截图证据；DOM、可见内容和控制台读取成功。
- Windows `curl.exe` 的 Schannel 握手失败未用于公网健康结论；公网结论来自独立 Node HTTPS 与 Browser。

