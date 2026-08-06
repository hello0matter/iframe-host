# Production long-run maintenance

This directory mirrors the storage and service controls installed on the
production server on 2026-08-06.

## Retention policy

- iframe-host request/response auditing is hard-disabled in `server.js`.
- Hyperliquid raw scans are kept for 14 days.
- Hyperliquid account, equity, and new-coin snapshots are kept for 30 days.
- Yudao API access logs are kept for 30 days.
- Yudao API error and CDK logs are kept for 90 days.
- BaoTa panel archives are limited to the seven newest files.
- MySQL binlogs expire after 10 days and rotate at 128 MiB.
- systemd journal storage is capped at 100 MiB with 14-day retention.

## Scheduling

The files under `systemd/` run daily retention, weekly SQLite compaction,
15-minute disk checks, and two-minute Yudao health checks. The health check
gives a newly started Java process a ten-minute grace period because a cold
startup currently takes about five minutes.

`redis-bt.service` and `yudao-server.service` provide boot startup and automatic
process recovery. The production `/root/test.sh` is mirrored here and restarts
Java through systemd only after verifying at least 1 GiB of free disk space.

## Installed paths

- `bin/*` -> `/usr/local/sbin/`
- `systemd/*` -> `/etc/systemd/system/`
- `logrotate/yudao-server` -> `/etc/logrotate.d/yudao-server`
- `journald/20-storage-limits.conf` ->
  `/etc/systemd/journald.conf.d/20-storage-limits.conf`
- `test.sh` -> `/root/test.sh`
- merge `mysql-storage.cnf` into `/etc/my.cnf`

After updating unit files, run `systemctl daemon-reload` and enable the matching
timers/services. Do not start a second Redis or Java process outside systemd.
