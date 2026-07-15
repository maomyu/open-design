"""清空原始库+4张下游表的全部记录，并删去重缓存。为"干净重跑"做准备。
运行：FEISHU_BACKEND=larkcli LARK_PROFILE=yuzhihe ./.venv/bin/python scripts/wipe_tables.py
"""
import json, os, subprocess, sys
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
from config import settings  # noqa: F401  载入 .env

BASE = os.getenv("FEISHU_BITABLE_APP_TOKEN", "GUlpbqXX9a94tWsseUlcNb67nae")
PROFILE = os.getenv("LARK_PROFILE", "yuzhihe")
TABLES = ["爆款内容原始库", "今日爆款选题池", "爆点拆解库", "成品内容审核库", "发布复盘库"]


def run(args):
    r = subprocess.run(["lark-cli", "base", *args, "--profile", PROFILE,
                        "--as", "user", "--base-token", BASE, "--format", "json"],
                       capture_output=True, text=True, timeout=60)
    s = r.stdout.strip()
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        return {}


def all_ids(table):
    d = run(["+record-list", "--table-id", table, "--page-size", "200"])
    return d.get("data", {}).get("record_id_list", [])


for t in TABLES:
    ids = all_ids(t)
    total = len(ids)
    deleted = 0
    while ids:
        batch, ids = ids[:100], ids[100:]
        d = run(["+record-delete", "--table-id", t, "--yes",
                 "--json", json.dumps({"record_id_list": batch})])
        if d.get("ok"):
            deleted += len(batch)
    # 删完可能还有分页残留，再扫一轮
    left = all_ids(t)
    if left:
        run(["+record-delete", "--table-id", t, "--yes",
             "--json", json.dumps({"record_id_list": left})])
        deleted += len(left)
    print(f"{t}: 删除 {deleted}/{total} 条")

# 删去重缓存
db = os.getenv("DB_PATH", "./data/cache.sqlite")
if os.path.exists(db):
    os.remove(db)
    print(f"已删去重缓存 {db}")
print("✅ 清空完成")
