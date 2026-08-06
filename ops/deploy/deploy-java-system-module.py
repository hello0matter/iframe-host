#!/usr/bin/env python3
"""Publish a complete Yudao server JAR while preserving production modules."""
from __future__ import annotations

import argparse
import shlex
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, run

REMOTE_JAR = "/root/yudao-server.jar"
REMOTE_BACKUPS = "/root/iframe-host-backups"
REMOTE_UPLOAD = "/root/.yudao-server-source-full.jar"


def default_jar() -> Path:
    candidates = (
        Path(r"D:\study\tmp\ruoyi-vue-pro\yudao-server\target\yudao-server.jar"),
        Path(__file__).resolve().parents[3]
        / "ruoyi-vue-pro"
        / "yudao-server"
        / "target"
        / "yudao-server.jar",
    )
    return next((path for path in candidates if path.is_file()), candidates[0])


def upload_file(client, source: Path, remote_path: str) -> None:
    sftp = client.open_sftp()
    try:
        offset = 0
        remote_exists = True
        try:
            offset = sftp.stat(remote_path).st_size
        except FileNotFoundError:
            remote_exists = False
        if offset > source.stat().st_size:
            raise RuntimeError(f"Remote upload is larger than source: {remote_path}")
        mode = "r+" if remote_exists else "w"
        with source.open("rb") as source_file, sftp.open(remote_path, mode) as remote_file:
            source_file.seek(offset)
            remote_file.seek(offset)
            while chunk := source_file.read(1024 * 1024):
                remote_file.write(chunk)
        if sftp.stat(remote_path).st_size != source.stat().st_size:
            raise RuntimeError(f"Remote upload size mismatch: {remote_path}")
    finally:
        sftp.close()


def checked(result: tuple[int, str, str], label: str) -> str:
    code, output, errors = result
    if code:
        raise RuntimeError(f"{label} failed:\n{errors or output}")
    return output


def deploy(source_jar: Path) -> None:
    if not source_jar.is_file():
        raise RuntimeError(f"Server JAR not found: {source_jar}")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    remote_upload = REMOTE_UPLOAD
    backup = f"{REMOTE_BACKUPS}/yudao-server-{stamp}"
    client = connect()
    try:
        upload_file(client, source_jar, remote_upload)
        script = "\n".join(
            [
                "set -eu",
                f"BACKUP={shlex.quote(backup)}",
                f"REMOTE_JAR={shlex.quote(REMOTE_JAR)}",
                f"REMOTE_UPLOAD={shlex.quote(remote_upload)}",
                "JAR_BIN=/www/server/java/jdk-21.0.2/bin/jar",
                "WORK_DIR=$(mktemp -d /tmp/yudao-full-deploy-XXXXXX)",
                "SOURCE_DIR=$WORK_DIR/source",
                "PRODUCTION_DIR=$WORK_DIR/production",
                "COMBINED=$WORK_DIR/yudao-server.jar.new",
                "mkdir -p \"$BACKUP\" \"$SOURCE_DIR\" \"$PRODUCTION_DIR\"",
                "cp -a \"$REMOTE_UPLOAD\" \"$COMBINED\"",
                "cp -a \"$REMOTE_JAR\" \"$BACKUP/yudao-server.jar\"",
                "(cd \"$SOURCE_DIR\" && $JAR_BIN xf \"$REMOTE_UPLOAD\")",
                "(cd \"$PRODUCTION_DIR\" && $JAR_BIN xf \"$REMOTE_JAR\")",
                "for ENTRY in $(find \"$PRODUCTION_DIR/BOOT-INF/lib\" -maxdepth 1 -type f -printf '%f\\n' | grep -E '^yudao-module-(cdk|bclog|repair)-.*\\.jar$' || true); do",
                "  if [ -e \"$SOURCE_DIR/BOOT-INF/lib/$ENTRY\" ]; then continue; fi",
                "  (cd \"$PRODUCTION_DIR\" && $JAR_BIN uf \"$COMBINED\" \"BOOT-INF/lib/$ENTRY\")",
                "  LINE=\"- \\\"BOOT-INF/lib/$ENTRY\\\"\"",
                "  grep -Fqx -- \"$LINE\" \"$SOURCE_DIR/BOOT-INF/classpath.idx\" || printf '%s\\n' \"$LINE\" >> \"$SOURCE_DIR/BOOT-INF/classpath.idx\"",
                "done",
                "(cd \"$SOURCE_DIR\" && $JAR_BIN uf \"$COMBINED\" BOOT-INF/classpath.idx)",
                "if ! $JAR_BIN tf \"$COMBINED\" | grep -q 'BOOT-INF/lib/yudao-module-system-biz-2.0.1-snapshot.jar'; then",
                "  rm -rf \"$WORK_DIR\"",
                "  exit 1",
                "fi",
                "if ! $JAR_BIN tf \"$COMBINED\" | grep -q 'BOOT-INF/lib/yudao-module-cdk-biz-2.0.1-snapshot.jar'; then",
                "  rm -rf \"$WORK_DIR\"",
                "  exit 1",
                "fi",
                "mv \"$COMBINED\" \"$REMOTE_JAR.new\"",
                "$JAR_BIN tf \"$REMOTE_JAR.new\" >/dev/null",
                "mv -f \"$REMOTE_JAR.new\" \"$REMOTE_JAR\"",
                "OLD_PID=$(pgrep -f 'java .* -jar /root/yudao-server.jar' | head -1 || true)",
                "if [ -n \"$OLD_PID\" ]; then kill \"$OLD_PID\"; fi",
                "for i in $(seq 1 45); do",
                "  if [ -z \"$OLD_PID\" ] || ! kill -0 \"$OLD_PID\" 2>/dev/null; then break; fi",
                "  sleep 1",
                "done",
                "nohup java -server -Xms512m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/root/heapError -jar /root/yudao-server.jar --spring.profiles.active=dev > /root/yudao-server-dev-1.log 2>&1 &",
                "READY=0",
                "NEW_PID=",
                # Production startup includes datasource, Redis, Quartz, and module initialization.
                # Allow enough time for a cold restart before triggering the rollback path.
                "for i in $(seq 1 300); do",
                "  NEW_PID=$(pgrep -f '^java .* -jar /root/yudao-server.jar' | head -n 1 || true)",
                "  if [ -n \"$NEW_PID\" ]; then",
                "    CODE=$(curl -sS -o /tmp/yudao-tenant-simple-list-body -w '%{http_code}' --max-time 3 http://127.0.0.1:48080/admin-api/system/tenant/simple-list || true)",
                "    if [ \"$CODE\" = 200 ] && ! grep -q '\"code\":500' /tmp/yudao-tenant-simple-list-body; then READY=1; break; fi",
                "  fi",
                "  sleep 1",
                "done",
                "if [ \"$READY\" != 1 ]; then",
                "  kill \"$NEW_PID\" 2>/dev/null || true",
                "  cp -a \"$BACKUP/yudao-server.jar\" \"$REMOTE_JAR\"",
                "  nohup java -server -Xms512m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/root/heapError -jar /root/yudao-server.jar --spring.profiles.active=dev > /root/yudao-server-dev-1.log 2>&1 &",
                "  rm -rf \"$WORK_DIR\" \"$REMOTE_UPLOAD\"",
                "  exit 1",
                "fi",
                "rm -rf \"$WORK_DIR\" \"$REMOTE_UPLOAD\"",
                f"ls -1dt {shlex.quote(REMOTE_BACKUPS)}/yudao-server-* 2>/dev/null | tail -n +3 | xargs -r rm -rf --",
                "printf 'BACKUP=%s\\nPID=%s\\nENDPOINT_STATUS=%s\\nENDPOINT_BODY=' \"$BACKUP\" \"$NEW_PID\" \"$CODE\"",
                "cat /tmp/yudao-tenant-simple-list-body",
            ]
        )
        print(checked(run(client, script, timeout=360), "publish and restart complete Yudao server"))
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path, default=default_jar(), help="complete locally built yudao-server.jar")
    args = parser.parse_args()
    deploy(args.jar.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
