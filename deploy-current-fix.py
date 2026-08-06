#!/usr/bin/env python3
"""Upload current local server.js + public/admin.html and restart iframe-host."""
from __future__ import annotations

import hashlib
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
sys.path.insert(0, str(ROOT / "ops" / "lib"))
from remote import connect, print_result, run  # type: ignore

FILES = [
    (ROOT / "server.js", "/opt/iframe-host/server.js"),
    (ROOT / "public" / "admin.html", "/opt/iframe-host/public/admin.html"),
]
FALLBACK_CACHE = ROOT / ".cache" / "fallback-cache.json"


def must_run(client, command: str, timeout: int = 120) -> str:
    code, output, errors = run(client, command, timeout=timeout)
    if output:
        print(output, end="")
    if errors:
        print(errors, end="", file=sys.stderr)
    if code != 0:
        raise RuntimeError(f"remote command failed ({code}): {command}")
    return output


def main() -> int:
    client = connect()
    try:
        files = [*FILES]
        if FALLBACK_CACHE.exists():
            files.append((FALLBACK_CACHE, "/etc/iframe-host/fallback-cache.json"))
        backup = must_run(
            client,
            'set -euo pipefail; STAMP=$(date +%Y%m%d-%H%M%S); '
            'BACKUP=/root/iframe-host-backups/deploy-$STAMP; mkdir -p "$BACKUP"; '
            'cp -a /opt/iframe-host/server.js /opt/iframe-host/public/admin.html "$BACKUP"/; '
            '[ ! -f /etc/iframe-host/fallback-cache.json ] || cp -a /etc/iframe-host/fallback-cache.json "$BACKUP"/; '
            'echo "$BACKUP"',
        ).strip()
        print("backup=" + backup)
        sftp = client.open_sftp()
        for local, remote in files:
            data = local.read_bytes()
            print(f"upload {local.name} sha256={hashlib.sha256(data).hexdigest()}")
            with sftp.file(remote + ".new", "wb") as handle:
                handle.write(data)
            validation = (
                "temp=$(mktemp --suffix=.js); cp /opt/iframe-host/server.js.new \"$temp\"; "
                "node --check \"$temp\"; rm -f \"$temp\"; "
                if remote.endswith("server.js")
                else ""
            )
            must_run(
                client,
                f"set -euo pipefail; {validation}mkdir -p $(dirname {remote}); chown iframehost:iframehost {remote}.new; "
                f"chmod {'640' if remote.endswith('fallback-cache.json') else '644'} {remote}.new; mv {remote}.new {remote}; sha256sum {remote}",
            )
        sftp.close()
        must_run(
            client,
            "set -euo pipefail; node --check /opt/iframe-host/server.js; "
            "systemctl restart iframe-host.service; "
            "for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do "
            "curl -sS -o /dev/null --max-time 2 http://127.0.0.1:3030/admin/ && break; sleep 0.5; done; "
            "systemctl is-active iframe-host.service; "
            "ls -1dt /root/iframe-host-backups/deploy-* 2>/dev/null | tail -n +4 | xargs -r rm -rf --",
        )
        print("deployed")
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
