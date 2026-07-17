"""本地 SQLite 缓存：去重指纹 + 多期数据快照（算增速/快速起量）+ 成本台账 + 失败队列。"""
from __future__ import annotations

import json
import sqlite3
import time
from contextlib import contextmanager

from config import settings as S

_DDL = """
CREATE TABLE IF NOT EXISTS seen (
    content_id TEXT PRIMARY KEY,
    fingerprint TEXT,
    platform TEXT,
    first_seen INTEGER,
    last_seen INTEGER
);
CREATE TABLE IF NOT EXISTS snapshot (
    content_id TEXT,
    ts INTEGER,
    likes INTEGER, comments INTEGER, collects INTEGER, plays INTEGER,
    PRIMARY KEY (content_id, ts)
);
CREATE INDEX IF NOT EXISTS idx_fp ON seen(fingerprint);
CREATE TABLE IF NOT EXISTS cost_ledger (
    ts INTEGER, kind TEXT, task TEXT, units INTEGER, detail TEXT
);
CREATE INDEX IF NOT EXISTS idx_cost_ts ON cost_ledger(ts);
CREATE TABLE IF NOT EXISTS failed_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts INTEGER, kind TEXT, payload TEXT, reason TEXT, status TEXT DEFAULT 'pending'
);
"""


@contextmanager
def _conn():
    import os
    os.makedirs(os.path.dirname(S._env("DB_PATH", "./data/cache.sqlite")) or ".", exist_ok=True)
    con = sqlite3.connect(S._env("DB_PATH", "./data/cache.sqlite"))
    try:
        con.executescript(_DDL)
        yield con
        con.commit()
    finally:
        con.close()


def is_duplicate(content_id: str, fingerprint: str) -> bool:
    """作品级去重：content_id 或 指纹 命中即视为重复。"""
    with _conn() as con:
        row = con.execute(
            "SELECT 1 FROM seen WHERE content_id=? OR fingerprint=? LIMIT 1",
            (content_id, fingerprint)).fetchone()
        return row is not None


def mark_seen(content_id: str, fingerprint: str, platform: str) -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "INSERT INTO seen(content_id,fingerprint,platform,first_seen,last_seen) "
            "VALUES(?,?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET last_seen=?",
            (content_id, fingerprint, platform, now, now, now))


def add_snapshot(content_id: str, likes: int, comments: int, collects: int, plays: int) -> None:
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO snapshot(content_id,ts,likes,comments,collects,plays) "
            "VALUES(?,?,?,?,?,?)",
            (content_id, int(time.time()), likes, comments, collects, plays))


def add_cost(kind: str, units: int, *, task: str = "", detail: str = "") -> None:
    """成本台账(模块9):每次外部调用落一笔。kind: llm/asr/image/tikhub;
    units: tokens总数/次数/张数;task 来自 env BC_TASK(管道入口设置);detail=模型名等。
    失败绝不抛(记账不能影响主流程)。"""
    try:
        with _conn() as con:
            con.execute("INSERT INTO cost_ledger(ts,kind,task,units,detail) VALUES(?,?,?,?,?)",
                        (int(time.time()), kind, task or _task_ctx(), units, detail))
    except Exception:  # noqa: BLE001
        pass


def _task_ctx() -> str:
    import os
    return os.getenv("BC_TASK", "")


def cost_report(days: int = 7) -> dict:
    """近 N 天成本汇总:按 kind 聚合 + 按天分布。"""
    since = int(time.time()) - days * 86400
    with _conn() as con:
        by_kind = con.execute(
            "SELECT kind, COUNT(*), SUM(units) FROM cost_ledger WHERE ts>=? GROUP BY kind",
            (since,)).fetchall()
        by_day = con.execute(
            "SELECT date(ts,'unixepoch','localtime') d, kind, SUM(units) FROM cost_ledger "
            "WHERE ts>=? GROUP BY d, kind ORDER BY d", (since,)).fetchall()
    return {"days": days,
            "by_kind": [{"kind": k, "calls": c, "units": u or 0} for k, c, u in by_kind],
            "by_day": [{"date": d, "kind": k, "units": u or 0} for d, k, u in by_day]}


def enqueue_failure(kind: str, payload: dict, reason: str) -> int:
    """失败队列(验收11):失败不丢任务。返回队列 id。"""
    import json as _j
    with _conn() as con:
        cur = con.execute("INSERT INTO failed_queue(ts,kind,payload,reason) VALUES(?,?,?,?)",
                          (int(time.time()), kind, _j.dumps(payload, ensure_ascii=False), reason[:500]))
        return int(cur.lastrowid or 0)


def list_failures(status: str = "pending", limit: int = 50) -> list[dict]:
    import json as _j
    with _conn() as con:
        rows = con.execute(
            "SELECT id,ts,kind,payload,reason,status FROM failed_queue WHERE status=? "
            "ORDER BY id DESC LIMIT ?", (status, limit)).fetchall()
    out = []
    for i, ts, k, p, r, s in rows:
        try:
            payload = _j.loads(p or "{}")
        except Exception:  # noqa: BLE001
            payload = {}
        out.append({"id": i, "ts": ts, "kind": k, "payload": payload, "reason": r, "status": s})
    return out


def mark_failure(fid: int, status: str) -> None:
    with _conn() as con:
        con.execute("UPDATE failed_queue SET status=? WHERE id=?", (status, fid))


def growth_per_hour(content_id: str) -> float | None:
    """用最早与最新快照算点赞单位时间增速（供「快速起量」判定）。"""
    with _conn() as con:
        rows = con.execute(
            "SELECT ts,likes FROM snapshot WHERE content_id=? ORDER BY ts", (content_id,)).fetchall()
    if len(rows) < 2:
        return None
    (t0, l0), (t1, l1) = rows[0], rows[-1]
    hours = (t1 - t0) / 3600
    return (l1 - l0) / hours if hours > 0 else None
