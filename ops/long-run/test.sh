#!/usr/bin/env bash
set -Eeuo pipefail
MIN_FREE_MB=${MIN_FREE_MB:-1024}
cleanup=/usr/local/sbin/server-disk-guard
[ ! -x "$cleanup" ] || "$cleanup"
free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
if [ "${free_mb:-0}" -lt "$MIN_FREE_MB" ]; then
    echo "[check] 磁盘剩余 ${free_mb}MB，小于 ${MIN_FREE_MB}MB；保留当前服务并拒绝重启" >&2
    df -h / >&2
    exit 1
fi
if [ ! -s /root/yudao-server.jar ]; then
    echo '[check] /root/yudao-server.jar 不存在或为空' >&2
    exit 1
fi
echo '[restart] 通过 systemd 重启 yudao-server.service'
systemctl restart yudao-server.service
for i in $(seq 1 420); do
    if systemctl is-active --quiet yudao-server.service; then
        code=$(curl -sS --max-time 3 -o /tmp/yudao-start-health.$$ -w '%{http_code}' http://127.0.0.1:48080/admin-api/system/tenant/simple-list 2>/dev/null || true)
        if [ "$code" = 200 ] && ! grep -q '"code":500' /tmp/yudao-start-health.$$ 2>/dev/null; then
            rm -f /tmp/yudao-start-health.$$
            echo '[restart] Java 48080 健康检查通过'
            systemctl --no-pager --full status yudao-server.service | head -n 12
            exit 0
        fi
    fi
    sleep 1
done
rm -f /tmp/yudao-start-health.$$
echo '[restart] 启动健康检查失败，最近日志：' >&2
journalctl -u yudao-server.service -n 150 --no-pager >&2
exit 1
