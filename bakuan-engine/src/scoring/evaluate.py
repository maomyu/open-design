"""把一条内容跑完整评分：数据分项(程序) + 内容/意图分项(模型) → 双通道分 + 榜单。

对应主链路 步骤5 爆款评分。严格遵循"数据分项由程序算、内容分项由模型给"的原则。
"""
from __future__ import annotations

import math
import os
from dataclasses import dataclass

from src.adapters.normalize import RawContent
from src.llm import prompts, router
from src.scoring import hot_score as H


def _norm(x: float, cap: float) -> float:
    """把绝对量压到 0~1（对数归一，避免大 V 一家独大）。"""
    if x <= 0:
        return 0.0
    return min(1.0, math.log10(1 + x) / math.log10(1 + cap))


@dataclass
class Evaluation:
    content_id: str
    traffic: float
    intent: float
    traffic_grade: str
    intent_grade: str
    reason: str
    top_questions: list[str]
    pain_level: int
    recommend_service: str
    detail: dict


def evaluate(rc: RawContent, *, transcript: str = "", comments: list[str] | None = None,
             account_recent_likes: list[int] | None = None,
             keyword_sample_likes: list[int] | None = None,
             growth_per_hour: float | None = None,
             cdims: dict | None = None) -> Evaluation:
    comments = comments or []

    # ── 流量爆款分：数据类维度(程序)。数据缺失 → None(交给可用权重归一化)，不算 0 ──
    interaction = None
    if rc.plays or rc.likes:
        denom = max(rc.plays, rc.likes, 1)
        interaction = min(1.0, (rc.collects + rc.comments + rc.shares) / denom * 5)
    account_excess = None   # 未采集账号近作品时视为缺失，不惩罚
    if account_recent_likes and len(account_recent_likes) >= H.S.ANOMALY_MIN_WORKS:
        import statistics
        med = statistics.median(account_recent_likes)
        if med > 0:
            account_excess = min(1.0, (rc.likes / med) / H.S.ANOMALY_S)
    growth = _norm(growth_per_hour, 5000) if growth_per_hour is not None else None

    # RADAR_FAST(选题列表分页速采):跳过每条 2 次 LLM(内容维度 + 评论意图)与逐条取评论文本,
    # 纯用内联数据(点赞/播放/评论数/粉丝)算分。爆款列表本就按热度(点赞)排序,内容维度用中性
    # 默认 0.5,不影响"谁是爆款"的判断;换来分页多条也能秒出、且省 TikHub/LLM 成本。
    fast = os.getenv("RADAR_FAST") == "1"

    # ── 流量爆款分：内容类维度(模型) ── fast 模式下跳过 LLM,用中性默认。
    # cdims 预评分(2026-07-22 批量调用产出):调用方已批量评好就不再单条打 LLM。
    if cdims is None:
        cdims = {} if fast else router.chat_json(
            [{"role": "system", "content": prompts.CONTENT_DIM_SYS},
             {"role": "user", "content": prompts.content_dims_user(rc.title, transcript)}],
            tier="mid")

    traffic_dims = {
        "data_heat": _norm(max(rc.likes, rc.plays), 200_000),
        "growth": growth,
        "interaction": interaction,
        "account_excess": account_excess,
        "topic_match": float(cdims.get("topic_match", 0.5) or 0.5),
        "structure": float(cdims.get("structure", 0.5) or 0.5),
    }
    traffic_dims = {k: v for k, v in traffic_dims.items() if v is not None}
    traffic, tdetail = H.traffic_score(traffic_dims)

    # ── 精准意向分：评论意图(模型) + 互动密度(程序) ──
    top_questions: list[str] = []
    pain_level = 0
    recommend_service = ""
    intent_dims: dict[str, float] = {}
    if comments and not fast:
        idims = router.chat_json(
            [{"role": "system", "content": prompts.INTENT_SYS},
             {"role": "user", "content": prompts.intent_user(comments)}], tier="mid")
        top_questions = idims.get("top_questions", []) or []
        pain_level = int(idims.get("pain_level", 0) or 0)
        recommend_service = str(idims.get("recommend_service", "") or "")
        intent_dims = {k: float(idims.get(k, 0) or 0) for k in
                       ("ask_help", "method_query", "self_projection",
                        "pain_specific", "save_tendency", "audience_match", "high_ticket")}
        intent_dims["comment_density"] = min(1.0, len(comments) / 200)
    else:
        # 无评论文本(或 fast 模式):用【内联评论数】给个基线意向密度,不取评论文本、不打 LLM。
        # 这样意向分不至于恒为 0,评论多的爆款意向相应更高。
        if rc.comments:
            intent_dims = {"comment_density": min(1.0, rc.comments / 200)}
    intent, idetail = H.intent_score(intent_dims) if intent_dims else (0.0, {"missing": list(H.S.INTENT_WEIGHTS)})

    _f = lambda x: f"{x:.2f}" if x is not None else "缺失"
    reason = (f"流量{traffic}({H.grade(traffic)})/意向{intent}({H.grade(intent)})；"
              f"数据热度{traffic_dims['data_heat']:.2f}、增速{_f(growth)}、"
              f"账号超额{_f(account_excess)}")
    return Evaluation(
        content_id=rc.content_id, traffic=traffic, intent=intent,
        traffic_grade=H.grade(traffic), intent_grade=H.grade(intent),
        reason=reason, top_questions=top_questions, pain_level=pain_level,
        recommend_service=recommend_service,
        detail={"traffic": tdetail, "intent": idetail})


# ── 5 大榜单分类 ──
def classify_boards(ev: Evaluation) -> list[str]:
    boards = []
    if ev.traffic >= 65:
        boards.append("流量爆款榜")
    if ev.intent >= 65:
        boards.append("精准需求榜")
    if ev.intent >= 75:
        boards.append("高咨询意向榜")
    if ev.traffic >= 75 and ev.intent >= 75:
        boards.append("双高榜")
    if ev.pain_level >= 4 and ev.traffic < 75:
        boards.append("新兴小众需求榜")
    return boards


def content_type(ev: Evaluation) -> str:
    hi_t, hi_i = ev.traffic >= 75, ev.intent >= 75
    if hi_t and hi_i:
        return "双高型"
    if hi_i:
        return "精准型"
    return "流量型"


def batch_content_dims(pairs: list[tuple[str, str]], *, batch_size: int = 6) -> list[dict]:
    """多条 (标题, 文案) 一次 LLM 调用评出内容维度——本地 CLI 智能体一调用一进程,
    逐条评 N 条 = N 次进程启动(2026-07-22 用户反馈整轮运行特别慢的根因之一)。
    返回值与 pairs 等长;批量失败或缺条的条目回退逐条单评,绝不整批丢;
    RADAR_FAST 模式直接全空(dict),走 evaluate() 的中性默认,与 fast 语义一致。"""
    results: list[dict] = [{} for _ in pairs]
    if not pairs or os.getenv("RADAR_FAST") == "1":
        return results
    for start in range(0, len(pairs), batch_size):
        end = min(start + batch_size, len(pairs))
        chunk = [(i + 1, pairs[start + i][0], pairs[start + i][1]) for i in range(end - start)]
        arr: list = []
        try:
            data = router.chat_json(
                [{"role": "system", "content": prompts.CONTENT_DIM_BATCH_SYS},
                 {"role": "user", "content": prompts.content_dims_batch_user(chunk)}],
                tier="mid")
            raw = data.get("items")
            if isinstance(raw, list):
                arr = raw
        except Exception:  # noqa: BLE001 — 批量调用失败,整 chunk 回退逐条单评
            arr = []
        got: dict[int, dict] = {}
        for entry in arr:
            if not isinstance(entry, dict):
                continue
            try:
                i = int(entry.get("i", 0))
            except (TypeError, ValueError):
                continue
            if 1 <= i <= len(chunk):
                got[i] = entry
        for seq, title, transcript in chunk:
            entry = got.get(seq)
            if entry is None:
                # 缺条回退逐条单评(与 evaluate() 内的单次调用同提示词)
                entry = router.chat_json(
                    [{"role": "system", "content": prompts.CONTENT_DIM_SYS},
                     {"role": "user", "content": prompts.content_dims_user(title, transcript)}],
                    tier="mid")
            results[start + seq - 1] = {
                "topic_match": float(entry.get("topic_match", 0.5) or 0.5),
                "structure": float(entry.get("structure", 0.5) or 0.5),
            }
    return results
