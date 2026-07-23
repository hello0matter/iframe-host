"""Shared local-only SSH configuration and command helpers for iframe-host ops."""
from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path

import paramiko

OPS_ROOT = Path(__file__).resolve().parents[1]
ENV_FILE = OPS_ROOT / ".env"


def load_dotenv(path: Path = ENV_FILE) -> None:
    """Load simple KEY=VALUE pairs without overriding exported variables."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def require_settings() -> dict[str, str]:
    load_dotenv()
    settings = {
        "host": os.environ.get("IFRAME_HOST", ""),
        "username": os.environ.get("IFRAME_SSH_USER", ""),
        "password": os.environ.get("IFRAME_SSH_PASSWORD", ""),
        "key_file": os.environ.get("IFRAME_SSH_KEY_FILE", ""),
        "port": os.environ.get("IFRAME_SSH_PORT", "22"),
    }
    missing = [name for name in ("host", "username") if not settings[name]]
    if not settings["password"] and not settings["key_file"]:
        missing.append("IFRAME_SSH_PASSWORD or IFRAME_SSH_KEY_FILE")
    if missing:
        raise RuntimeError(
            "Missing local operational configuration: "
            + ", ".join(missing)
            + ". Copy iframe-host/ops/.env.example to iframe-host/ops/.env or export the variables."
        )
    return settings


def connect() -> paramiko.SSHClient:
    settings = require_settings()
    client = paramiko.SSHClient()
    client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
    kwargs = {
        "hostname": settings["host"],
        "port": int(settings["port"]),
        "username": settings["username"],
        "timeout": 30,
        "banner_timeout": 30,
        "look_for_keys": False,
        "allow_agent": False,
    }
    if settings["key_file"]:
        kwargs["key_filename"] = settings["key_file"]
    else:
        kwargs["password"] = settings["password"]
    client.connect(**kwargs)
    return client


def run(client: paramiko.SSHClient, command: str, timeout: int = 120) -> tuple[int, str, str]:
    _, stdout, stderr = client.exec_command(command, timeout=timeout)
    output = stdout.read().decode("utf-8", "replace")
    errors = stderr.read().decode("utf-8", "replace")
    return stdout.channel.recv_exit_status(), output, errors


def _safe_print(text: str, *, file=None) -> None:
    stream = file or sys.stdout
    encoding = getattr(stream, "encoding", None) or "utf-8"
    try:
        stream.write(text)
    except UnicodeEncodeError:
        stream.write(text.encode(encoding, errors="replace").decode(encoding, errors="replace"))
    stream.flush()


def print_result(result: tuple[int, str, str]) -> int:
    code, output, errors = result
    if output:
        _safe_print(output)
    if errors:
        _safe_print(errors, file=sys.stderr)
    return code


def shell_join(parts: list[str]) -> str:
    return " ".join(shlex.quote(part) for part in parts)
