#!/usr/bin/env python3
"""Inspect proxied assets and Nginx static-resource routing without changes."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, print_result, run

COMMAND = r'''set -euo pipefail
printf '=== configured prefixes ===\n'
python3 - <<'PY'
import json
from pathlib import Path
path = Path('/etc/iframe-host/config.production.json')
for site in json.loads(path.read_text()).get('sites', []):
    if site.get('enabled'):
        print(site.get('proxy_prefix') or '/', site.get('name') or site.get('id'))
PY
printf '\n=== representative /a assets through the IP vhost ===\n'
for uri in /a/ /a/style.css /a/logo.png /a/favicon.svg /a/img/Binance.svg /a/Cortex_AI_Demo.mp4; do
    printf '\n--- %s ---\n' "$uri"
    curl -sS --max-time 25 -H 'Host: 50.114.113.121' -D /tmp/iframe-host-headers -o /tmp/iframe-host-body "http://127.0.0.1$uri"
    grep -Ei '^(HTTP/|content-type:|content-length:|location:)' /tmp/iframe-host-headers || true
    printf 'bytes='; wc -c </tmp/iframe-host-body
    printf 'first-bytes='; head -c 16 /tmp/iframe-host-body | od -An -tx1 | tr -d ' \n'; printf '\n'
done
printf '\n=== static handlers in the effective Nginx configuration ===\n'
nginx -T 2>/dev/null | grep -n -A16 -B2 -E 'location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)|location ~ .*\.(js|css)' || true
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    client = connect()
    try:
        return print_result(run(client, COMMAND))
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
