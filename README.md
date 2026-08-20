# 好运游戏厅

部署在 EdgeOne Makers 上的无账号多人小游戏大厅。当前包含 2～4 人斗地主，使用房间号加入或观战。

## 已实现

- 游戏大厅支持水平卡片和 Grid 两种布局。
- 斗地主设置页支持昵称、匿名昵称、2～4 人上限、房间底分和可选密码；达到 2 人且全员准备即可开局。
- 房间浏览支持 Grid/列表切换、房间号搜索、加入与观战。
- 每位玩家进入游戏席获得 10,000 欢乐豆；同房连续对局保留，退出后销毁。
- 叫地主、不叫、抢地主、不抢；不加倍、加倍、超级加倍。
- 标准牌型、炸弹/王炸倍数、春天/反春、余额封顶结算。
- 观众不能看到手牌，对局结束后可抢空余游戏席。
- 出牌超时与中途退出自动托管，临时身份支持刷新恢复。
- 独立开发者后台可按游戏和状态筛选房间、踢出成员或立即解散房间。
- 响应式牌桌、CSS 扑克牌、原创 Web Audio 音效和减少动态效果适配。

## 技术架构

- Vite + React + TypeScript
- EdgeOne Edge Functions：`edge-functions/api/[[path]].ts`
- EdgeOne Blob：`game-rooms` 命名空间，强一致读取
- 版本锁：Blob `onlyIfNew` 条件写入，避免并发抢座和重复出牌
- 客户端仅在房间内按秒同步状态，不依赖云服务器和 WebSocket

EdgeOne 官方参考：

- [Edge Functions](https://pages.edgeone.ai/zh/document/edge-functions)
- [Blob 存储与强一致模式](https://pages.edgeone.ai/zh/document/blob-storage)
- [edgeone.json 配置](https://pages.edgeone.ai/zh/document/edgeone-json)

## 本地运行

仅预览前端：

```bash
npm ci
npm run dev
```

联调 Edge Functions 和 Blob，请先登录 EdgeOne CLI，再使用 Makers 本地开发环境：

```bash
npm install -g edgeone
edgeone login
edgeone makers dev
```

## 测试与构建

```bash
npm test
npm run build
```

## EdgeOne 构建设置

| 配置项 | 值 |
| --- | --- |
| 框架预设 | Vite；没有则选 Other |
| 根目录 | `/` |
| 输出目录 | `dist` |
| 构建命令 | `npm run build` |
| 安装命令 | `npm ci --include=optional` |

仓库根目录的 `edgeone.json` 已包含相同配置和 SPA fallback。部署后第一次访问 API 时，Blob SDK 会为当前项目自动创建 `game-rooms` 命名空间，无需额外数据库。

## 开发者管理后台

管理页面不会出现在玩家大厅导航中，部署后的地址为：

```text
https://你的域名/admin
```

在 EdgeOne 项目的环境变量设置中新增 `GAME_ADMIN_SECRET`，生产与预览环境按需分别配置。密钥至少 12 位，建议使用 32 位以上随机字符串；不要把真实密钥写入仓库。环境变量变更只会应用到之后的新部署，因此保存后需要重新部署一次。

后台支持：

- 按游戏类型、房间状态、房间号或昵称筛选。
- 查看游戏席、观战席、欢乐豆、局内身份和托管状态。
- 踢出观众或等待中的玩家；进行中玩家被踢后转为托管，避免牌局卡死。
- 立即解散房间，现有玩家下一次同步时会退出。

前端只在当前浏览器标签页的 `sessionStorage` 暂存输入的管理密钥，所有管理接口仍会在 Edge Functions 中校验 `GAME_ADMIN_SECRET`。

## 重要说明

这是纯娱乐筹码，不包含充值、提现、现金兑换或账号资产。EdgeOne Functions 是无状态运行环境，所有权威牌局数据均保存于 Blob；客户端只负责渲染和提交操作，不能自行发牌或判定胜负。
