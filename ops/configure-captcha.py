"""Configure the production 2Captcha secret without logging it or enabling paid tasks."""
from __future__ import annotations

import getpass
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent / "lib"))
from remote import connect, run


def main() -> int:
    key = sys.stdin.read().strip() if sys.argv[1:] == ["--stdin"] else getpass.getpass("2Captcha API key: ").strip()
    if not re.fullmatch(r"[A-Za-z0-9]{20,128}", key):
        raise RuntimeError("Invalid API key format; value was not saved")
    client = connect()
    try:
        code, _, _ = run(client, "install -d -m 700 /etc/iframe-host/secrets; install -d -m 755 /etc/systemd/system/iframe-host.service.d")
        if code:
            raise RuntimeError("Cannot prepare secret directories")
        with client.open_sftp() as sftp:
            with sftp.file('/etc/iframe-host/secrets/2captcha.env', 'w') as handle:
                handle.chmod(0o600)
                handle.write('CAPTCHA_2CAPTCHA_API_KEY=' + key + '\nCAPTCHA_STATE_FILE=/var/lib/iframe-host/captcha-budget.json\n')
            with sftp.file('/etc/systemd/system/iframe-host.service.d/30-captcha.conf', 'w') as handle:
                handle.write('[Service]\nEnvironmentFile=/etc/iframe-host/secrets/2captcha.env\n')
            sftp.chmod('/etc/systemd/system/iframe-host.service.d/30-captcha.conf', 0o644)
        code, _, _ = run(client, 'systemctl daemon-reload')
        if code:
            raise RuntimeError('Cannot reload service configuration')
        print('Secret saved in root-only environment file. No paid task created; restart service to apply.')
    finally:
        client.close()
    return 0


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except Exception:
        print('Captcha secret configuration failed; no secret value is logged.', file=sys.stderr)
        raise SystemExit(1)
