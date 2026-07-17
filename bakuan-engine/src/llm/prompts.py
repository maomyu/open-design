"""Prompt 库。

集中管理：爆点拆解、评论意图分析、内容分维度打分、脚本生成（两种风格）、封面标题候选。
每个 Prompt 要求模型输出 JSON，便于程序解析与可回测。
"""
from __future__ import annotations

# ── 爆点拆解（mid 模型）──
DECONSTRUCT_SYS = "你是短视频爆款拆解专家，只输出 JSON，不要多余文字。"


def deconstruct_user(title: str, transcript: str, stats: dict) -> str:
    return f"""对下面这条爆款内容做结构化拆解，输出 JSON，字段：
selectopic(选题类型)、hook(前3秒钩子)、conflict(核心矛盾)、pain(用户痛点)、
emotion(情绪点数组)、controversy(争议点)、structure(内容结构)、
reusable(可借鉴结构，只保留结构不复制表达)、no_copy(不应复制的专有元素)、
chance(可自然承接的服务/CTA)。
标题：{title}
文案/字幕：{transcript[:1500]}
数据：{stats}"""


# ── 内容维度打分（mid 模型，产出 traffic_score 的内容类维度 0-1）──
CONTENT_DIM_SYS = "你是内容评估器，只输出 JSON，各维度取值 0~1。"


def content_dims_user(title: str, transcript: str) -> str:
    return f"""评估这条内容，输出 JSON，字段(0~1)：
topic_match(与男性情感赛道及目标用户相关度)、structure(钩子/情绪/争议/可复用性带来的传播潜力)。
标题：{title}
文案：{transcript[:1200]}"""


# ── 评论意图分析（mid 模型，产出 intent_score 的意图类维度 + 高频问题）──
INTENT_SYS = "你是评论意图分析器，只输出 JSON。"


def intent_user(comments: list[str]) -> str:
    joined = "\n".join(f"- {c}" for c in comments[:120])
    return f"""分析以下评论样本，输出 JSON，字段：
ask_help(求助意图 0~1)、method_query(方法/方案咨询 0~1)、self_projection(自我代入 0~1)、
pain_specific(痛点具体程度 0~1)、save_tendency(收藏倾向 0~1)、audience_match(目标人群匹配 0~1)、
high_ticket(高客单服务承接可能 0~1)、high_intent_ratio(高意向评论占比 0~1)、
top_questions(高频真实问题句数组，最多5条)、pain_level(焦虑强度1~5)、
recommend_service(一句话：根据评论里的真实问题与意向，建议承接什么咨询/服务，如「1对1脱单陪跑」「聊天话术诊断」)。
评论：
{joined}"""


# ── 脚本生成（high 模型，两种风格）──
SCRIPT_SYS = "你是资深男性情感赛道口播脚本撰稿人，产出可直接开录的成品，只输出 JSON。"


def script_user(deconstruct: dict, recalled_materials: list[str],
                style_profile: dict | None, mode: str) -> str:
    mode_desc = ("仿写原视频风格：贴近原爆款的开头/节奏/表达"
                 if mode == "imitate"
                 else "按我的自有风格改写：严格遵循下方风格画像的开头/结构/口头禅/禁用表达")
    style = f"风格画像：{style_profile}" if style_profile else "风格画像：未提供，用通用真诚口播风格"
    mats = "\n".join(f"- {m}" for m in recalled_materials[:8])
    return f"""基于爆点拆解 + 我的素材，生成原创口播脚本。要求：{mode_desc}。
{style}
可用的我的素材（择优融入，不要照抄爆款专有案例）：
{mats}
爆点拆解：{deconstruct}
输出 JSON，字段：platform_title(平台标题)、cover_titles(封面标题候选数组≥3)、
script_60(60秒脚本)、script_90(90秒脚本)、tags、intro(简介)、
comment_guide(评论引导)、dm_keywords(私信关键词)、originality_note(与原文相似度自查提醒)。"""
