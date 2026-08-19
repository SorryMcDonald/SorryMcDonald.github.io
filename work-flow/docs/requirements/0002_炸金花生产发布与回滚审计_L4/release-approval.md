task_id: 71d4428f-ff22-4e8d-bdb8-f09efcb0221b
release_id: 20260819T182935Z-05b7cda9f086
tested_sha: 05b7cda9f086ff3a910d961b59c2e5ada409aca7
archive_sha256: 1fc649caa198db7db84bc6bd6cccb75097f3015952e1630121b1d866203a1bae

## Authorized scope

The approved external write scope was the Zhajinhua production service on `47.102.218.42` and the `huang` branch of `SorryMcDonald/SorryMcDonald.github.io`. `origin/main`, the Texas entry point, and the existing AI platform Nginx/Cloudflared configuration were outside the change scope.

## Backup and rollback

- Backup directory: `/opt/zhajinhua/backups/20260819T182935Z-05b7cda9f086`.
- Previous release: `/opt/zhajinhua/releases/20260819T094341`.
- Previous image: `local/zhajinhua:20260819T094341`.
- Recovery inputs retained: previous image archive, previous Compose file, database dump, recovery manifest, schema receipts, candidate receipts, and approved AI hash manifest.
- Stop condition: any failed local gate, candidate check, HTTPS/WSS/auth/room acceptance check, or shared AI ingress health check requires stopping promotion and restoring the previous application release.

