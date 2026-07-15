"""本地 SQLite 缓存：去重指纹 + 多期数据快照（算增速/快速起量）。

飞书是对客数据中心；本地库承担高频去重、快照增速计算与运行状态，减少飞书 API 压力。
"""
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
    feishu_record_id TEXT,
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


def mark_seen(content_id: str, fingerprint: str, platform: str, feishu_record_id: str = "") -> None:
    now = int(time.time())
    with _conn() as con:
        con.execute(
            "INSERT INTO seen(content_id,fingerprint,platform,feishu_record_id,first_seen,last_seen) "
            "VALUES(?,?,?,?,?,?) ON CONFLICT(content_id) DO UPDATE SET last_seen=?",
            (content_id, fingerprint, platform, feishu_record_id, now, now, now))


def add_snapshot(content_id: str, likes: int, comments: int, collects: int, plays: int) -> None:
    with _conn() as con:
        con.execute(
            "INSERT OR REPLACE INTO snapshot(content_id,ts,likes,comments,collects,plays) "
            "VALUES(?,?,?,?,?,?)",
            (content_id, int(time.time()), likes, comments, collects, plays))


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
