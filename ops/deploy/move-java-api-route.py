#!/usr/bin/env python3
"""Move the Java Yudao API off the proxy root and keep its native API path."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, print_result, run

CONF = "/www/server/panel/vhost/nginx/extension/50.114.113.121/iframe-host.conf"

INSPECT = rf'''set -euo pipefail
printf '=== target ===\n{CONF}\n'
printf '\n=== current Java route blocks ===\n'
grep -n -A28 -B3 -E 'location (\^~ )?/(index|admin-api|yudao-api)' {CONF} || true
printf '\n=== all yudao-api definitions ===\n'
grep -RIn --include='*.conf' -E 'location[[:space:]]+.*yudao-api|/yudao-api' /www/server/panel/vhost/nginx 2>/dev/null || true
'''

APPLY = r"""set -euo pipefail
CONF=/www/server/panel/vhost/nginx/extension/50.114.113.121/iframe-host.conf
if grep -RIn --include='*.conf' -E 'location[[:space:]]+.*(admin-api|yudao-api)' /www/server/panel/vhost/nginx 2>/dev/null | grep -v -F "$CONF" | grep -v '/backup-'; then
    echo 'A conflicting Java API location exists outside the target file; no changes made.' >&2
    exit 1
fi
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/www/server/panel/vhost/nginx/backup-${STAMP}-yudao-api-route
mkdir -p "$BACKUP"
cp -a "$CONF" "$BACKUP/iframe-host.conf"
python3 - <<'PY'
from pathlib import Path
p = Path('/www/server/panel/vhost/nginx/extension/50.114.113.121/iframe-host.conf')
s = p.read_text()
old = '''location = /index {
    return 302 /index/;
}

location ^~ /index/ {
    # The trailing slash deliberately removes /index/ before Java receives the URI.
    proxy_pass http://127.0.0.1:48080/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Prefix /index;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_redirect / /index/;
    proxy_cookie_path / /index/;
    proxy_read_timeout 86400;
}
'''
new = '''# Yudao is an API service, not a browser frontend. Keep it off the proxy
# root and remove this prefix before forwarding requests to its native routes.
location = /yudao-api {
    return 308 /yudao-api/;
}

location ^~ /yudao-api/ {
    proxy_pass http://127.0.0.1:48080/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Prefix /yudao-api;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_redirect / /yudao-api/;
    proxy_cookie_path / /yudao-api/;
    proxy_read_timeout 86400;
}
'''
compat = '''# Keep the Java application's native /admin-api/ path available for its
# existing frontend bundles. This route is still separate from the proxy root.
location = /admin-api {
    return 308 /admin-api/;
}

location ^~ /admin-api/ {
    proxy_pass http://127.0.0.1:48080;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Prefix /admin-api;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    proxy_read_timeout 86400;
}
'''
frontend = '''# Serve the existing Yudao frontend without letting it reclaim the proxy root.
location = /yudao-admin {
    return 308 /yudao-admin/;
}

location ^~ /yudao-admin/ {
    rewrite ^/yudao-admin/?$ /index.html break;
    rewrite ^/yudao-admin/(.*)$ /$1 break;
    root /www/wwwroot/50.114.113.121;
    index index.html;
    try_files $uri /yudao-admin/index.html;

    # The existing build was produced with a root asset path. Rewrite only
    # this frontend response so its static files remain inside this namespace.
    sub_filter_types application/javascript text/css;
    sub_filter '"/static/' '"/yudao-admin/static/';
    sub_filter "'/static/" "'/yudao-admin/static/";
    sub_filter '"/dist/' '"/yudao-admin/dist/';
    sub_filter "'/dist/" "'/yudao-admin/dist/";
    sub_filter '"/libs/' '"/yudao-admin/libs/';
    sub_filter "'/libs/" "'/yudao-admin/libs/";
    sub_filter '"/favicon.ico"' '"/yudao-admin/favicon.ico"';
    sub_filter "'/favicon.ico'" "'/yudao-admin/favicon.ico'";
    sub_filter '__webpack_require__.p = "/"' '__webpack_require__.p = "/yudao-admin/"';
    sub_filter 'publicPath = "/"' 'publicPath = "/yudao-admin/"';
    sub_filter '}).VUE_APP_APP_NAME : \\\"/\\\"' '}).VUE_APP_APP_NAME : \\\"/yudao-admin/\\\"';
    sub_filter_once off;
}
'''
if old in s:
    s = s.replace(old, new, 1)
elif 'location ^~ /yudao-api/' not in s:
    raise SystemExit('Expected Java route was not found; no configuration changed.')
if 'location ^~ /admin-api/' not in s:
    s += '\n' + compat
frontend_marker = '# Serve the existing Yudao frontend without letting it reclaim the proxy root.'
if frontend_marker in s:
    s = s[:s.index(frontend_marker)] + frontend
elif 'location ^~ /yudao-admin/' not in s:
    s += '\n' + frontend
p.write_text(s)
PY
nginx -t
nginx -s reload
printf 'BACKUP=%s\n' "$BACKUP"
for uri in /yudao-api /yudao-api/ /yudao-admin/ /yudao-admin/static/js/app.js; do
    printf '\n--- %s ---\n' "$uri"
    curl -sS --max-time 20 -H 'Host: 50.114.113.121' -D /tmp/headers -o /tmp/body "http://127.0.0.1$uri"
    grep -Ei '^(HTTP/|content-type:|location:)' /tmp/headers || true
    head -c 160 /tmp/body; printf '\n'
done
"""


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="back up, update, test, and reload Nginx")
    args = parser.parse_args()
    client = connect()
    try:
        if not args.apply:
            print("Dry run only. Re-run with --apply to modify production.")
            return print_result(run(client, INSPECT))
        return print_result(run(client, APPLY, timeout=180))
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
