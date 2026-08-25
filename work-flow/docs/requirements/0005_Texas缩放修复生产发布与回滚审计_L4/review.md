task_id: 1ba1870b-6e52-4c7c-bbe0-d59a588b9ae4
review: passed

发布边界为 app-only 原子切换，旧 release、旧镜像和 recovery manifest 可读回。数据库与共享入口未重建或改写；PostgreSQL dump 不参与自动回滚，避免覆盖发布后玩家写入。

