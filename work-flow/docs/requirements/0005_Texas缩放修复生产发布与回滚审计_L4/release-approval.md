task_id: 1ba1870b-6e52-4c7c-bbe0-d59a588b9ae4

- 授权：用户明确要求合并、提交、推送和部署。
- 写入范围：`origin/huang` 与 Zhajinhua app release；`origin/main`、PostgreSQL、Nginx、Cloudflared 不变。
- 回滚：恢复 `/opt/zhajinhua/releases/20260824T031134Z-fa2dc92a0d09` symlink 与旧 app 镜像。
- 停止条件：任一本地、候选或发布后门禁失败即停止；切换后失败由发布脚本自动执行 app-only 回滚。
- 备份：`/opt/zhajinhua/backups/20260825T062632Z-d7c5c86529e3`。

