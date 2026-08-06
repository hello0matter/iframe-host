#!/usr/bin/env python3
"""Keep high-volume Hyperliquid samples bounded while retaining trade records."""
import argparse
import sqlite3
import time

DB = "/opt/hyperliquid-monitor/altcoin_monitor.sqlite3"
POLICY = {
    "scan_rows": 14,
    "scans": 14,
    "live_account_snapshots": 30,
    "paper_equity": 30,
    "new_coin_snapshots": 30,
    "hotspot_topic_snapshots": 90,
}

parser = argparse.ArgumentParser()
parser.add_argument("--vacuum", action="store_true")
args = parser.parse_args()

con = sqlite3.connect(DB, timeout=120)
con.execute("PRAGMA busy_timeout=120000")
now = time.time()
removed = {}
for table, days in POLICY.items():
    cutoff = now - days * 86400
    total = 0
    while True:
        cur = con.execute(
            f'DELETE FROM "{table}" WHERE rowid IN '
            f'(SELECT rowid FROM "{table}" WHERE ts < ? LIMIT 50000)',
            (cutoff,),
        )
        con.commit()
        count = max(cur.rowcount, 0)
        total += count
        if count < 50000:
            break
    removed[table] = total
con.execute("PRAGMA optimize")
con.commit()
if args.vacuum:
    con.execute("VACUUM")
con.close()
print(" ".join(f"{name}={count}" for name, count in removed.items()))
