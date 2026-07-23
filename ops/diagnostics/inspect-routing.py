#!/usr/bin/env python3
"""Inspect the active iframe-host/Nginx routing configuration without changes."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, print_result, run

COMMAND = r'''set -euo pipefail
printf '=== services and listeners ===\n'
systemctl is-active iframe-host || true
ss -ltnp | grep -E ':(80|443|3030|48080)\b' || true
printf '\n=== configured proxy sites ===\n'
python3 - <<'PY'
import json
from pathlib import Path
path = Path('/etc/iframe-host/config.production.json')
if not path.exists():
    print('missing:', path)
else:
    for site in json.loads(path.read_text()).get('sites', []):
        print(json.dumps({key: site.get(key) for key in ('id', 'name', 'enabled', 'target_url', 'proxy_prefix')}, ensure_ascii=False))
PY
printf '\n=== active proxy/API locations ===\n'
nginx -T 2>/dev/null | grep -n -A16 -B2 -E 'location (\^~ )?/(yudao-api|internal-content)|location = /(yudao-api|index)|location / \{' || true
printf '\n=== static resource regex locations ===\n'
nginx -T 2>/dev/null | grep -n -A10 -B2 -E 'location ~ .*\.(gif|jpg|jpeg|png|bmp|swf)|location ~ .*\.(js|css)' || true
printf '\n=== yudao-api collisions ===\n'
grep -RIn --include='*.conf' -E 'location[[:space:]]+.*yudao-api|/yudao-api' /www/server/panel/vhost/nginx 2>/dev/null || true
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
