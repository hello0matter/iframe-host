#!/usr/bin/env python3
"""Apply bounded retention to high-volume Yudao/CDK database log tables."""
import os
import re
import subprocess
import zipfile

JAR = "/root/yudao-server.jar"
MYSQL = "/www/server/mysql/bin/mysql"
with zipfile.ZipFile(JAR) as archive:
    text = archive.read("BOOT-INF/classes/application-dev.yaml").decode("utf-8", "replace")
block = text[text.index("        master:"):text.index("        slave:")]
username = re.search(r"^\s*username:\s*([^#\r\n]+)", block, re.M).group(1).strip().strip("\"'")
password = re.search(r"^\s*password:\s*([^#\r\n]+)", block, re.M).group(1).strip().strip("\"'")
statements = [
    "SET SESSION lock_wait_timeout=60",
    "DELETE FROM infra_api_access_log WHERE create_time < NOW() - INTERVAL 30 DAY",
    "DELETE FROM infra_api_error_log WHERE create_time < NOW() - INTERVAL 90 DAY",
    "DELETE FROM cdk_cdklog WHERE create_time < NOW() - INTERVAL 90 DAY",
]
sql = ";\n".join(statements) + ";\n"
env = os.environ.copy()
env["MYSQL_PWD"] = password
result = subprocess.run(
    [MYSQL, "--connect-timeout=10", "--batch", "--skip-column-names", "-h", "127.0.0.1", "-P", "6078", "-u", username, "ruoyi-vue-pro"],
    input=sql,
    text=True,
    capture_output=True,
    env=env,
    timeout=1800,
)
if result.returncode:
    raise SystemExit((result.stderr or "MySQL retention failed").strip().splitlines()[0])
print("mysql_log_retention=ok")
