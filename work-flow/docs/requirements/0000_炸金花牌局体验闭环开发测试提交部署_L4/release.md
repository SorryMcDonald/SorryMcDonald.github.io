task_id: be50d92f-59cc-4b99-8286-31b29374c38b
validation: passed

## Post-action release validation

- Release ID: `20260819T182935Z-05b7cda9f086`.
- Current release: `/opt/zhajinhua/releases/20260819T182935Z-05b7cda9f086`.
- Application image: `local/zhajinhua:20260819T182935Z-05b7cda9f086`.
- Application image ID: `sha256:53fb3eb751fc5da7da12276244298f531e287f413482516369774630489b8a36`.
- Archive SHA-256: `1fc649caa198db7db84bc6bd6cccb75097f3015952e1630121b1d866203a1bae`.
- Previous release retained for rollback: `/opt/zhajinhua/releases/20260819T094341`.
- Previous application image retained: `local/zhajinhua:20260819T094341` (`sha256:e199ecd820f7505922fa063a4cbdf693c78839fdc0044456e7caa12db72461a8`).

## Health and ingress

- `zhajinhua-app-1`: running/healthy; in-container `/healthz` returned `200`.
- `zhajinhua-db-1`: running/healthy.
- `ai-platform-domestic-nginx-1`: running/healthy; `nginx -t` passed.
- `ai-platform-domestic-cloudflared-1`: running/healthy; Cloudflared version readback passed.
- Local SNI/TLS HTTPS `/healthz`: `200`.
- Certificate SAN: `DNS:crazythursdayplay.bbroot.com`; validity `2026-08-18 18:32:03Z` through `2026-11-16 18:32:02Z`.
- The six approved AI Nginx configuration hashes matched the pre-release baseline.

## Rollback boundary

The previous release, previous image archive, previous Compose file, database dump, recovery manifest, schema receipts, and AI hash manifest were retained under `/opt/zhajinhua/backups/20260819T182935Z-05b7cda9f086`. Application rollback is an atomic release/image restore followed by the same HTTPS/WSS and shared-ingress checks; the database dump is not restored automatically.

