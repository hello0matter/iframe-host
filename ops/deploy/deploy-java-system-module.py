#!/usr/bin/env python3
"""Patch the system module into the existing production Yudao fat JAR."""
from __future__ import annotations

import argparse
import shlex
import sys
from datetime import datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "lib"))
from remote import connect, run

REMOTE_JAR = "/root/yudao-server.jar"
MODULE_ENTRY = "BOOT-INF/lib/yudao-module-system-biz-2.2.0-jdk8-snapshot.jar"
REMOTE_BACKUPS = "/root/iframe-host-backups"


def default_module() -> Path:
    candidates = (
        Path(
            r"D:\study\tmp\rouyi\ruoyi-vue-pro\yudao-module-system\yudao-module-system-biz\target\yudao-module-system-biz-2.2.0-jdk8-snapshot.jar"
        ),
        Path(__file__).resolve().parents[3]
        / "rouyi-vue-pro"
        / "yudao-module-system"
        / "yudao-module-system-biz"
        / "target"
        / "yudao-module-system-biz-2.2.0-jdk8-snapshot.jar",
    )
    return next((path for path in candidates if path.is_file()), candidates[0])


def upload_file(client, source: Path, remote_path: str) -> None:
    stdin, stdout, stderr = client.exec_command(f"cat > {shlex.quote(remote_path)}", timeout=180)
    try:
        with source.open("rb") as source_file:
            while chunk := source_file.read(1024 * 1024):
                stdin.channel.sendall(chunk)
        stdin.channel.shutdown_write()
        code = stdout.channel.recv_exit_status()
        if code:
            message = stderr.read().decode("utf-8", "replace")
            raise RuntimeError(f"Remote upload failed: {message}")
    finally:
        stdin.close()
        stdout.close()
        stderr.close()


def checked(result: tuple[int, str, str], label: str) -> str:
    code, output, errors = result
    if code:
        raise RuntimeError(f"{label} failed:\n{errors or output}")
    return output


def deploy(module: Path) -> None:
    if not module.is_file():
        raise RuntimeError(f"Module JAR not found: {module}")

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    remote_module = f"/root/.yudao-system-module-{stamp}.jar"
    backup = f"{REMOTE_BACKUPS}/yudao-server-{stamp}"
    client = connect()
    try:
        upload_file(client, module, remote_module)
        script = "\n".join(
            [
                "set -eu",
                f"BACKUP={shlex.quote(backup)}",
                f"REMOTE_JAR={shlex.quote(REMOTE_JAR)}",
                f"REMOTE_MODULE={shlex.quote(remote_module)}",
                f"MODULE_ENTRY={shlex.quote(MODULE_ENTRY)}",
                "JAR_BIN=/www/server/java/jdk-21.0.2/bin/jar",
                "PATCH_DIR=/tmp/yudao-system-module-patch-$$",
                "mkdir -p \"$BACKUP\" \"$PATCH_DIR/BOOT-INF/lib\"",
                "cp -a \"$REMOTE_JAR\" \"$BACKUP/yudao-server.jar\"",
                "cp -a \"$REMOTE_MODULE\" \"$PATCH_DIR/$MODULE_ENTRY\"",
                "$JAR_BIN uf \"$REMOTE_JAR\" -C \"$PATCH_DIR\" \"$MODULE_ENTRY\"",
                "rm -rf \"$PATCH_DIR\" \"$REMOTE_MODULE\"",
                "if ! $JAR_BIN tf \"$REMOTE_JAR\" | grep -q \"$MODULE_ENTRY\"; then",
                "  cp -a \"$BACKUP/yudao-server.jar\" \"$REMOTE_JAR\"",
                "  exit 1",
                "fi",
                "OLD_PID=$(pgrep -f 'java .* -jar /root/yudao-server.jar' | head -1 || true)",
                "if [ -n \"$OLD_PID\" ]; then kill \"$OLD_PID\"; fi",
                "for i in $(seq 1 30); do",
                "  if [ -z \"$OLD_PID\" ] || ! kill -0 \"$OLD_PID\" 2>/dev/null; then break; fi",
                "  sleep 1",
                "done",
                "nohup java -server -Xms512m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/root/heapError -jar /root/yudao-server.jar --spring.profiles.active=dev > /root/yudao-server-dev-1.log 2>&1 &",
                "NEW_PID=$!",
                "READY=0",
                "for i in $(seq 1 60); do",
                "  if ! kill -0 \"$NEW_PID\" 2>/dev/null; then break; fi",
                "  CODE=$(curl -sS -o /tmp/yudao-tenant-simple-list-body -w '%{http_code}' --max-time 2 http://127.0.0.1:48080/admin-api/system/tenant/simple-list || true)",
                "  if [ \"$CODE\" = 200 ] || [ \"$CODE\" = 401 ] || [ \"$CODE\" = 403 ]; then READY=1; break; fi",
                "  sleep 1",
                "done",
                "if [ \"$READY\" != 1 ]; then",
                "  kill \"$NEW_PID\" 2>/dev/null || true",
                "  cp -a \"$BACKUP/yudao-server.jar\" \"$REMOTE_JAR\"",
                "  nohup java -server -Xms512m -Xmx512m -XX:+HeapDumpOnOutOfMemoryError -XX:HeapDumpPath=/root/heapError -jar /root/yudao-server.jar --spring.profiles.active=dev > /root/yudao-server-dev-1.log 2>&1 &",
                "  exit 1",
                "fi",
                "printf 'BACKUP=%s\\nPID=%s\\nENDPOINT_STATUS=%s\\n' \"$BACKUP\" \"$NEW_PID\" \"$CODE\"",
            ]
        )
        print(checked(run(client, script, timeout=180), "patch and restart Java"))
    finally:
        client.close()


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--module", type=Path, default=default_module(), help="built yudao-module-system-biz JAR")
    args = parser.parse_args()
    deploy(args.module.resolve())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
