#!/usr/bin/env python3
"""Verify public iframe-host routes without modifying production configuration."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, print_result, run

COMMAND = r'''set -euo pipefail
check() {
    url="$1"
    printf '\n--- %s ---\n' "$url"
    curl -skS --max-time 30 -D /tmp/iframe-host-headers -o /tmp/iframe-host-body "$url"
    grep -Ei '^(HTTP/|content-type:|content-length:|location:)' /tmp/iframe-host-headers || true
    printf 'bytes='; wc -c </tmp/iframe-host-body
    if grep -Eiq '^content-type: (application/json|text/html|text/css|image/)' /tmp/iframe-host-headers; then
        printf 'preview='; head -c 160 /tmp/iframe-host-body | tr '\n' ' '; printf '\n'
    fi
}
printf '=== public HTTPS route verification ===\n'
for url in \
    https://hacket.top/a/ \
    https://hacket.top/a/style.css \
    https://hacket.top/a/logo.png \
    https://hacket.top/internal-content-admin/ \
    https://hacket.top/yudao-api/; do
    check "$url"
done
printf '\n=== Java API canonical redirect, without following redirects ===\n'
for uri in /yudao-api /yudao-api/; do
    printf '\n--- http://127.0.0.1%s ---\n' "$uri"
    curl -sS --max-time 20 -H 'Host: 50.114.113.121' -D - -o /dev/null "http://127.0.0.1$uri" | tr -d '\r'
done
'''


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.parse_args()
    client = connect()
    try:
        return print_result(run(client, COMMAND, timeout=180))
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
