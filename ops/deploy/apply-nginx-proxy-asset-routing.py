#!/usr/bin/env python3
"""Guardedly repair Nginx static asset handlers for dynamic proxy sites."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, print_result, run

CONF = "/www/server/panel/vhost/nginx/50.114.113.121.conf"

INSPECT = rf'''set -euo pipefail
printf '=== target ===\n{CONF}\n'
printf '\n=== matching static locations ===\n'
grep -n -A14 -B2 -E 'location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)|location ~ .*\.(js|css)' {CONF} || true
printf '\n=== expected behavior ===\n'
printf '%s\n' 'Dynamic proxy assets must use proxy_pass http://127.0.0.1:3030; (no trailing slash).'
'''

APPLY = rf"""set -euo pipefail
CONF={CONF}
STAMP=$(date +%Y%m%d-%H%M%S)
BACKUP=/www/server/panel/vhost/nginx/backup-${{STAMP}}-proxy-static-assets
mkdir -p "$BACKUP"
cp -a "$CONF" "$BACKUP/$(basename "$CONF")"
python3 - <<'PY'
from pathlib import Path
p = Path('/www/server/panel/vhost/nginx/50.114.113.121.conf')
s = p.read_text()
old_image = '''    location ~ .*\\.(gif|jpg|jpeg|png|bmp|swf)$
    {{
        expires      30d;
        error_log /dev/null;
        access_log /dev/null;
    }}'''
new_image = '''    # Dynamic proxy sites can use any prefix (including /). These asset
    # requests must reach Node so it can select the site and strip its prefix.
    location ~ .*\\.(gif|jpg|jpeg|png|bmp|swf)$
    {{
        expires 30d;
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400;
        error_log /dev/null;
        access_log /dev/null;
    }}'''
old_code = '''    location ~ .*\\.(js|css)?$
    {{
        expires      12h;
        error_log /dev/null;
        access_log /dev/null;
    }}'''
new_code = '''    location ~ .*\\.(js|css)?$
    {{
        expires 12h;
        proxy_pass http://127.0.0.1:3030;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 86400;
        error_log /dev/null;
        access_log /dev/null;
    }}'''
if old_image not in s or old_code not in s:
    raise SystemExit('Expected legacy static handlers were not found; no configuration changed.')
p.write_text(s.replace(old_image, new_image, 1).replace(old_code, new_code, 1))
PY
nginx -t
nginx -s reload
printf 'BACKUP=%s\n' "$BACKUP"
for uri in /a/style.css /a/logo.png; do
    printf '\n--- %s ---\n' "$uri"
    curl -sS --max-time 20 -H 'Host: 50.114.113.121' -D /tmp/headers -o /tmp/body "http://127.0.0.1$uri"
    grep -Ei '^(HTTP/|content-type:)' /tmp/headers || true
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
