# 斗地主入口开放与 workflow 恢复发布回执

## 发布信息

- 发布时间：2026-08-24（Asia/Shanghai）
- 公网地址：`https://crazythursdayplay.bbroot.com/`
- 部署提交：`fa2dc92a0d09ab3562b8a2666206d1cda7d267de`
- 功能提交：`bbd058d281a957f7d07d88c0315e975a754292a9`
- 发布标识：`20260824T031134Z-fa2dc92a0d09`
- 发布归档 SHA-256：`141199599eb29feec22a0ec6d7caa05acf23799ee7d737f9846d60af1eca5d10`
- 镜像 ID：`sha256:478ca38f3f71b2ebcb4e5563fd46928c2cb2108b48016ec08425e1b0b454d150`
- 数据库迁移：无；发布前后 schema verifier 均返回 level 10

## 变更范围

- 炸金花和德州页面把斗地主显示为正常链接并指向 `/doudizhu.html`。
- 炸金花页只为本页导航按钮绑定视图切换，不再把跨游戏链接送入“暂未开放”分支。
- workflow state 恢复到当前唯一工作树身份，重新索引现有任务证据，并按受控 plan hash 同步自包含 runtime。
- 远端只更新 `huang`；`main` 保持 `07af1264e8103d5c29fbabf4c79be559ba819059`。

## 本地门禁

- `npm ci`：154 个包，生产依赖审计 0 漏洞。
- Vitest：27 个文件、186 项测试通过。
- Playwright：8 项测试通过。
- Node 语法检查：44 个文件通过。
- workflow strict validation：`valid: true`，0 issues。
- workflow doctor：`ready`，`offline_ready: true`，0 active operation locks。

## 候选与发布

- Docker Hub 元数据请求超时，未产生候选镜像，也未切换生产。
- 候选和当前运行镜像的 `package.json`、`package-lock.json` SHA-256 完全一致；随后以当前镜像作为离线依赖基底，删除并完整覆盖 `/app/server/src` 与 `/app/public`，构建唯一候选镜像。
- 候选在隔离 PostgreSQL 的生产快照上通过 schema level 10、`/healthz`、新斗地主链接、旧按钮不存在和 `/doudizhu.html` HTTP 200 验证。
- 生产通过 `/opt/zhajinhua/current` 原子 symlink 和 Compose `app` 单服务切换；PostgreSQL、Nginx 与 Cloudflared 未重建。

## 回滚与备份

- 备份目录：`/opt/zhajinhua/backups/20260824T031134Z-fa2dc92a0d09`。
- 上一 release：`/opt/zhajinhua/releases/20260823T065411Z-95916f0`。
- 上一镜像：`local/zhajinhua:20260823T065411Z-95916f0`。
- 上一镜像 ID：`sha256:7acebee41a65dff274a81a87f75587a216bab9d9e8c7b7a53e8957a3ccc89b3d`。
- 数据库快照 SHA-256：`a96934afcd77fa28cc1372d738bcc77d3e1e0ada0fe62de8de208b31b95ae586`。
- 上一镜像归档 SHA-256：`e1ac6046a00217b35eaac14212047b63d0551cdd17c563037329a7f827791d54`。
- 上一 Compose SHA-256：`638a77582ae081782dca1d82a76ebcc5ded52d7367d9d66ede8171617fced3c0`。
- recovery receipt SHA-256：`2d3a55572038c83c42804564590d64974cb084e9581b934cf207ef063651e2e0`。

## 发布后验收

- 服务器本机 `/healthz` 返回 `{"ok":true}`；独立公网 Node HTTPS 请求返回 HTTP 200 和 `ok: true`。
- Browser 确认首页存在新的斗地主链接、旧按钮不存在、斗地主页面标题与登录界面正常，控制台应用错误为 0。
- 两次生产采样间隔 31 秒；应用、PostgreSQL、Nginx、Cloudflared 均为 `running/healthy`、重启次数 0。
- 发布后 schema verifier 继续返回 level 10。
- Nginx 配置测试通过，3 个配置文件的 SHA-256 与发布前完全一致。
- monitoring receipt SHA-256：`3fe84e0e0b1eb1bf37d1a30e114ab229f60cb347cf812fae250a144f7f591f61`。
- release manifest SHA-256：`dd8893d691bb14bce44a199736a88379e5eaadb26897f2eb079bb5648981988c`。

## 残余边界

- 本次变更只调整入口状态，没有创建生产验收账号或牌局；斗地主服务的建房、对局和结算逻辑沿用既有实现与测试证据。
- 浏览器客户端直接打开 JSON `/healthz` 被本地扩展拦截；公网健康结论来自独立 Node HTTPS 请求和服务器本机检查。
