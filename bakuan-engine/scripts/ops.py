"""运维原子 CLI(模块9/10,验收11/13):成本报表 / 失败队列 / 重试 / 备份 / 恢复。

均输出一行 JSON(daemon 从首个 { 解析):
  cost-report [--days 7]                 近N天成本汇总(llm tokens/asr次/image张/tikhub次,按天分布)
  failed-list [--limit 50]               待重试的失败任务
  retry [--limit 5]                      重跑失败队列(link/keyword/account/regenerate/candidate)
  backup [--out 路径.tar.gz] [--daemon-data 目录]   引擎数据+.env(+daemon数据)打包
  restore --from 路径.tar.gz [--daemon-data 目录]   还原备份(重启应用后生效)
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import tarfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from config import settings as S  # noqa: E402,F401  载入 .env
from src import store  # noqa: E402


def _out(obj: dict) -> None:
    print(json.dumps(obj, ensure_ascii=False))


def retry(limit: int) -> dict:
    """重跑失败队列。逐条按 kind 分发到管道入口;成功标 done、再失败标回 pending(保留重试机会)。"""
    from src.pipeline import Pipeline
    rows = store.list_failures("pending", limit=limit)
    if not rows:
        return {"ok": True, "retried": 0, "results": []}
    pipe = Pipeline()
    results = []
    for r in rows:
        fid, kind, p = r["id"], r["kind"], r["payload"]
        os.environ["BC_TASK"] = f"retry:{kind}#{fid}"
        try:
            if kind in ("link", "candidate") and p.get("url"):
                res = pipe.run_single_link(p["url"])
                ok = not res.get("error")
            elif kind == "keyword" and p.get("keyword"):
                res = pipe.run_keyword(p["keyword"], p.get("platforms") or list(S.PLATFORMS),
                                       min_threshold=int(p.get("min_threshold") or 0))
                ok = True
            elif kind == "account" and p.get("keyword"):
                res = pipe.run_account(p["keyword"], p.get("platforms") or list(S.PLATFORMS),
                                       time_window=str(p.get("time_window") or "7d"))
                ok = True
            elif kind == "regenerate":
                res = pipe.regenerate()
                ok = True
            else:
                res = {"skip": f"无法分发的任务:kind={kind} payload缺关键字段"}
                ok = False
            store.mark_failure(fid, "done" if ok else "pending")
            results.append({"id": fid, "kind": kind, "ok": ok,
                            "summary": str(res)[:120]})
        except Exception as e:  # noqa: BLE001
            store.mark_failure(fid, "pending")
            results.append({"id": fid, "kind": kind, "ok": False,
                            "summary": f"{type(e).__name__}: {str(e)[:100]}"})
    return {"ok": True, "retried": len(results), "results": results}


def backup(out: str, daemon_data: str) -> dict:
    """备份:引擎 data/(去重库+成本台账+失败队列+封面) + .env(全部 Key/配置)
    + daemon 数据目录(知识库/文章/账号配置 SQLite 等)。产物一个 tar.gz,拷走即迁移。"""
    root = Path(__file__).resolve().parent.parent
    out = out or str(Path.home() / f"WorkBuild备份-{time.strftime('%Y%m%d-%H%M%S')}.tar.gz")
    added = []
    with tarfile.open(out, "w:gz") as tar:
        if (root / "data").exists():
            tar.add(root / "data", arcname="engine-data",
                    filter=lambda ti: None if "__pycache__" in ti.name else ti)
            added.append("engine-data")
        if (root / ".env").exists():
            tar.add(root / ".env", arcname="engine-env/.env")
            added.append("engine-env/.env")
        if daemon_data and Path(daemon_data).exists():
            # 排除可再生目录:bakuan-engine/engine-runtime 新机器装应用会重新 provision
            # (且 .venv/python-runtime 里的符号链接是本机绝对路径,备了也没法用);
            # 引擎自己的 data/ 已在 engine-data 里单独备份。
            _skip = ("daemon-data/bakuan-engine", "daemon-data/engine-runtime")

            def _fil(ti):
                if any(ti.name == s or ti.name.startswith(s + "/") for s in _skip):
                    return None
                if "__pycache__" in ti.name or ti.issym() or ti.islnk():
                    return None
                return ti
            tar.add(daemon_data, arcname="daemon-data", filter=_fil)
            added.append("daemon-data(不含引擎运行时,新机自动重建)")
    size = os.path.getsize(out)
    return {"ok": True, "path": os.path.abspath(out), "bytes": size, "included": added,
            "note": "迁移新机器:装好应用后跑 restore --from 本文件"}


def restore(src: str, daemon_data: str) -> dict:
    """还原备份到当前机器(引擎 data/.env + daemon 数据)。重启应用后生效。"""
    root = Path(__file__).resolve().parent.parent
    if not os.path.exists(src):
        return {"ok": False, "error": f"备份文件不存在:{src}"}
    restored = []
    with tarfile.open(src, "r:gz") as tar:
        for m in tar.getmembers():
            if m.name.startswith("engine-data"):
                dest = root / "data" / os.path.relpath(m.name, "engine-data")
            elif m.name.startswith("engine-env"):
                dest = root / ".env"
            elif m.name.startswith("daemon-data") and daemon_data:
                dest = Path(daemon_data) / os.path.relpath(m.name, "daemon-data")
            else:
                continue
            if m.isdir():
                dest.mkdir(parents=True, exist_ok=True)
                continue
            if not m.isfile():   # 符号链接/设备等特殊成员跳过(链接目标是原机绝对路径,还原无意义)
                continue
            dest.parent.mkdir(parents=True, exist_ok=True)
            f = tar.extractfile(m)
            if f:
                dest.write_bytes(f.read())
                restored.append(str(dest))
    return {"ok": True, "restored_files": len(restored), "note": "重启应用后生效"}


def main() -> None:
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    p1 = sub.add_parser("cost-report")
    p1.add_argument("--days", type=int, default=7)
    p2 = sub.add_parser("failed-list")
    p2.add_argument("--limit", type=int, default=50)
    p3 = sub.add_parser("retry")
    p3.add_argument("--limit", type=int, default=5)
    p4 = sub.add_parser("backup")
    p4.add_argument("--out", default="")
    p4.add_argument("--daemon-data", default="")
    p5 = sub.add_parser("restore")
    p5.add_argument("--from", dest="src", required=True)
    p5.add_argument("--daemon-data", default="")
    a = ap.parse_args()
    try:
        if a.cmd == "cost-report":
            _out(store.cost_report(a.days))
        elif a.cmd == "failed-list":
            _out({"rows": store.list_failures("pending", a.limit)})
        elif a.cmd == "retry":
            _out(retry(a.limit))
        elif a.cmd == "backup":
            _out(backup(a.out, a.daemon_data))
        else:
            _out(restore(a.src, a.daemon_data))
    except Exception as e:  # noqa: BLE001
        _out({"ok": False, "error": f"{type(e).__name__}: {str(e)[:200]}"})


if __name__ == "__main__":
    main()
