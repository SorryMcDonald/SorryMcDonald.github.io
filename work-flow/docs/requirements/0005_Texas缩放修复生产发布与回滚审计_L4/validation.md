task_id: 1ba1870b-6e52-4c7c-bbe0-d59a588b9ae4
validation: passed

- 发布归档 SHA-256、候选镜像 revision/archive 标签和运行镜像 ID 与锁定提交一致。
- 旧镜像、数据库 dump、旧 Compose、源归档、Nginx 基线和 recovery manifest 已保留。
- 隔离 PostgreSQL 恢复与候选 app 验收通过；生产未执行数据库迁移。
- `/opt/zhajinhua/current` 原子切换后，四个相关容器均 healthy、重启 0；依赖容器 ID 未变。
- schema level 10、Nginx 配置哈希、公网 HTTPS 与 Browser 验收通过。

