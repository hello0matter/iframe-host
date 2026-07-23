#!/usr/bin/env python3
"""Deploy the complete Yudao Vue build under its dedicated production path."""
from __future__ import annotations

import argparse
import base64
import shlex
import sys
import tarfile
import tempfile
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, run

REMOTE_LIVE = "/opt/iframe-host/yudao-admin"
REMOTE_CONF = "/www/server/panel/vhost/nginx/extension/50.114.113.121/iframe-host.conf"
REMOTE_BACKUPS = "/root/iframe-host-backups"

FRONTEND_LOCATION = r'''# Serve the compiled Yudao admin only under its dedicated namespace.
location = /yudao-admin {
    return 308 /yudao-admin/;
}

location ^~ /yudao-admin/ {
    alias /opt/iframe-host/yudao-admin/;
    index index.html;
    try_files $uri $uri/ /yudao-admin/index.html;
}
'''


def default_dist() -> Path:
    # The official frontend is kept beside iframe-host, not nested in it.
    candidates = (
        Path(r"D:\tmp\rouyi-ui-admin-vue2-full\dist"),
        Path(__file__).resolve().parents[3] / "rouyi-ui-admin-vue2-full" / "dist",
    )
    return next((path for path in candidates if (path / "index.html").is_file()), candidates[0])


def checked(result: tuple[int, str, str], command: str) -> str:
    code, output, errors = result
    if code:
        raise RuntimeError(f"Remote command failed: {command}\n{errors or output}")
    return output


def upload_archive(client, archive: Path, remote_path: str) -> None:
    stdin, stdout, stderr = client.exec_command(f"cat > {shlex.quote(remote_path)}", timeout=180)
    try:
        with archive.open("rb") as source:
            while chunk := source.read(1024 * 1024):
                stdin.channel.sendall(chunk)
        stdin.channel.shutdown_write()
        code = stdout.channel.recv_exit_status()
        if code:
            errors = stderr.read().decode("utf-8", "replace")
            raise RuntimeError(f"Remote archive upload failed: {errors}")
    finally:
        stdin.close()
        stdout.close()
        stderr.close()


def build_config(current: str) -> str:
    marker = "# Serve the existing Yudao frontend without letting it reclaim the proxy root."
    if marker in current:
        current = current[: current.index(marker)].rstrip() + "\n\n"
    elif "alias /opt/iframe-host/yudao-admin/;" in current:
        return current
    elif "location ^~ /yudao-admin/" in current:
        raise RuntimeError("Cannot safely identify the existing /yudao-admin/ block")
    return current + FRONTEND_LOCATION


def deploy(dist: Path) -> None:
    index = dist / "index.html"
    if not index.is_file():
        raise RuntimeError(f"Frontend build not found: {index}")
    index_text = index.read_text(encoding="utf-8")
    if "/yudao-admin/" not in index_text:
        raise RuntimeError("dist/index.html is not built for /yudao-admin/")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    stage = f"/opt/iframe-host/.yudao-admin-{stamp}.tmp"
    remote_conf_tmp = f"{REMOTE_CONF}.{stamp}.new"
    backup = f"{REMOTE_BACKUPS}/yudao-admin-{stamp}"
    remote_archive = f"/opt/iframe-host/.yudao-admin-{stamp}.tar.gz"

    client = connect()
    sftp = client.open_sftp()
    archive_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix="yudao-admin-", suffix=".tar.gz", delete=False) as archive:
            archive_path = Path(archive.name)
        with tarfile.open(archive_path, "w:gz") as tar:
            tar.add(dist, arcname=".")
        checked(
            run(client, f"rm -rf {shlex.quote(stage)} {shlex.quote(remote_archive)} && mkdir -p /opt/iframe-host"),
            "prepare staging",
        )
        upload_archive(client, archive_path, remote_archive)
        checked(
            run(
                client,
                f"mkdir -p {shlex.quote(stage)} && tar -xzf {shlex.quote(remote_archive)} -C {shlex.quote(stage)} && rm -f {shlex.quote(remote_archive)}",
            ),
            "extract staging archive",
        )
        current_conf = sftp.open(REMOTE_CONF, "r").read().decode("utf-8")
        new_conf = build_config(current_conf).encode("utf-8")
        with sftp.open(remote_conf_tmp, "w") as remote_file:
            remote_file.write(base64.b64encode(new_conf).decode("ascii"))
        checked(
            run(
                client,
                "\n".join(
                    [
                        "set -e",
                        f"mkdir -p {shlex.quote(backup)}",
                        f"cp -a {shlex.quote(REMOTE_CONF)} {shlex.quote(backup + '/iframe-host.conf')}",
                        f"if [ -e {shlex.quote(REMOTE_LIVE)} ]; then mv {shlex.quote(REMOTE_LIVE)} {shlex.quote(backup + '/yudao-admin')}; fi",
                        f"mv {shlex.quote(stage)} {shlex.quote(REMOTE_LIVE)}",
                        f"base64 -d {shlex.quote(remote_conf_tmp)} > {shlex.quote(REMOTE_CONF + '.candidate')}",
                        f"mv {shlex.quote(REMOTE_CONF + '.candidate')} {shlex.quote(REMOTE_CONF)}",
                        f"rm -f {shlex.quote(remote_conf_tmp)}",
                        "if ! nginx -t; then",
                        f"  mv {shlex.quote(backup + '/iframe-host.conf')} {shlex.quote(REMOTE_CONF)}",
                        f"  rm -rf {shlex.quote(REMOTE_LIVE)}",
                        f"  if [ -e {shlex.quote(backup + '/yudao-admin')} ]; then mv {shlex.quote(backup + '/yudao-admin')} {shlex.quote(REMOTE_LIVE)}; fi",
                        "  exit 1",
                        "fi",
                        "nginx -s reload",
                        f"test -s {shlex.quote(REMOTE_LIVE + '/index.html')}",
                        f"printf 'BACKUP=%s\\n' {shlex.quote(backup)}",
                    ],
                ),
                timeout=180,
            ),
            "switch frontend and reload nginx",
        )
        print(f"Deployed {dist} to {REMOTE_LIVE}")
        print(checked(run(client, "curl -sS -I --max-time 20 -H 'Host: 50.114.113.121' http://127.0.0.1/yudao-admin/"), "verify frontend"))
        print(checked(run(client, "curl -sS --max-time 20 -H 'Host: 50.114.113.121' http://127.0.0.1/yudao-admin/index.html | grep -o '/yudao-admin/static/js/[^\" ]*' | head -1"), "verify asset path"))
    except Exception:
        checked(
            run(
                client,
                f"rm -rf {shlex.quote(stage)} {shlex.quote(remote_archive)} {shlex.quote(remote_conf_tmp)}",
            ),
            "clean staging",
        )
        raise
    finally:
        sftp.close()
        client.close()
        if archive_path:
            archive_path.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dist", type=Path, default=default_dist(), help="built Vue dist directory")
    args = parser.parse_args()
    deploy(args.dist.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
