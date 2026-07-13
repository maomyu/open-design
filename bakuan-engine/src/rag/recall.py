"""素材库 RAG 召回：主题标签过滤 + 向量语义检索 TopK + 风格画像固定规则。

不把整库塞进 Prompt（降本增稳）。素材来自飞书「我的素材库」，更新后可重建索引。
向量后端用 Chroma；嵌入用兼容 OpenAI 的 embeddings 接口（可切换）。
"""
from __future__ import annotations

import os

from config import settings as S

_COLLECTION = "my_materials"


def _client():
    import chromadb   # 缺失/异常时由调用方降级（recall→[]，rebuild→0）
    path = os.getenv("CHROMA_PATH", "./data/chroma")
    os.makedirs(path, exist_ok=True)
    return chromadb.PersistentClient(path=path)


def _embed(texts: list[str]) -> list[list[float]]:
    """调用嵌入接口。默认走 DeepSeek/OpenAI 兼容 /embeddings。"""
    import requests
    base = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
    key = os.getenv("DEEPSEEK_API_KEY", "")
    r = requests.post(f"{base}/embeddings",
                      headers={"Authorization": f"Bearer {key}"},
                      json={"model": os.getenv("EMBED_MODEL", "embedding-2"), "input": texts},
                      timeout=60)
    r.raise_for_status()
    return [d["embedding"] for d in r.json()["data"]]


def rebuild_index(materials: list[dict]) -> int:
    """用飞书「我的素材库」记录重建向量索引。materials: [{id,title,content,tags,recallable}]"""
    try:
        col = _client().get_or_create_collection(_COLLECTION)
    except Exception as e:   # chromadb 未装/损坏 → 明确报错但不崩全局
        from loguru import logger
        logger.warning(f"向量库不可用，跳过建索引：{e}")
        return 0
    try:
        col.delete(where={})   # 清空重建
    except Exception:
        pass
    usable = [m for m in materials if m.get("recallable", True) and m.get("content")]
    if not usable:
        return 0
    docs = [f"{m.get('title','')}\n{m['content']}" for m in usable]
    col.add(ids=[str(m["id"]) for m in usable], documents=docs,
            embeddings=_embed(docs),
            metadatas=[{"tags": ",".join(m.get("tags", []))} for m in usable])
    return len(usable)


def recall(query: str, *, tags: list[str] | None = None, topk: int | None = None) -> list[str]:
    """主题标签过滤 + 语义 TopK 召回，返回素材文本列表。

    向量库不可用（chromadb 未装/损坏）时降级为空召回，脚本仍能生成（不带自有素材）。
    """
    topk = topk or int(os.getenv("RAG_TOPK", "8"))
    try:
        col = _client().get_or_create_collection(_COLLECTION)
    except Exception:
        return []
    where = None
    if tags:
        # Chroma 简单包含匹配（生产可换更精细的标签过滤）
        where = {"tags": {"$in": tags}} if len(tags) > 1 else {"tags": {"$eq": tags[0]}}
    try:
        res = col.query(query_embeddings=_embed([query]), n_results=topk,
                        where=where if tags else None)
        return res.get("documents", [[]])[0]
    except Exception:
        return []
