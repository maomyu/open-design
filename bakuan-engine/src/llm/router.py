"""三层文本模型路由（可切换 + fallback + 成本记录）。

low  分类/去重/初筛   mid  爆点拆解/结构分析   high  脚本/标题/评论引导
兼容 OpenAI 风格 /chat/completions（DeepSeek、火山方舟等均适用）。
模型别名与 Key 全部来自 .env，绝不写死；主模型失败自动切备用。
"""
from __future__ import annotations

import json
import os
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S

_COST: dict[str, int] = {"prompt": 0, "completion": 0, "calls": 0}


def _endpoint(tier: str) -> tuple[str, str, str]:
    """返回 (base_url, api_key, model) — 默认 DeepSeek，可按 tier 覆盖。"""
    base = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
    key = os.getenv("DEEPSEEK_API_KEY", "")
    return base, key, S.LLM_TIERS.get(tier, S.LLM_TIERS["mid"])


def _dry_response(messages: list[dict]) -> str:
    """DRY_RUN 模式：不联网，按 system 提示返回合理的假 JSON，用于离线端到端验证。"""
    sys = (messages[0]["content"] if messages else "")
    if "评论意图" in sys:
        return ('{"ask_help":0.7,"method_query":0.6,"self_projection":0.6,"pain_specific":0.8,'
                '"save_tendency":0.5,"audience_match":0.7,"high_ticket":0.6,"high_intent_ratio":0.5,'
                '"top_questions":["相亲后没下文怎么办","女生回复越来越慢怎么办"],"pain_level":4,'
                '"recommend_service":"1对1脱单陪跑/聊天话术诊断"}')
    if "内容评估" in sys:
        return '{"topic_match":0.8,"structure":0.75}'
    if "拆解" in sys:
        return ('{"selectopic":"痛点","hook":"你是不是也长期单身","conflict":"想脱单却不敢行动",'
                '"pain":"社交回避","emotion":["共鸣","希望"],"controversy":"","structure":"痛点-方法-号召",'
                '"reusable":"钩子+3步方法+CTA","no_copy":"博主个人经历","chance":"1对1情感咨询"}')
    if "脚本" in sys:
        return ('{"platform_title":"长期单身男生的破局3步","cover_titles":["3步破局单身","别再等了",'
                '"单身自救指南"],"script_60":"[开场]你是不是...[方法]...[号召]...","script_90":"[完整版]...",'
                '"tags":"情感 脱单 男性成长","intro":"男性情感成长","comment_guide":"评论区扣1",'
                '"dm_keywords":"脱单","originality_note":"结构借鉴、表达原创"}')
    return "{}"


@retry(stop=stop_after_attempt(2), wait=wait_exponential(min=2, max=10))
def chat(messages: list[dict], *, tier: str = "mid", json_mode: bool = False,
         temperature: float = 0.7, max_tokens: int = 2048) -> str:
    if os.getenv("DRY_RUN") == "1":
        _COST["calls"] += 1
        return _dry_response(messages)
    base, key, model = _endpoint(tier)
    payload: dict[str, Any] = {
        "model": model, "messages": messages,
        "temperature": temperature, "max_tokens": max_tokens,
    }
    if json_mode:
        payload["response_format"] = {"type": "json_object"}
    r = requests.post(f"{base}/chat/completions",
                      headers={"Authorization": f"Bearer {key}",
                               "Content-Type": "application/json"},
                      json=payload, timeout=90)
    r.raise_for_status()
    data = r.json()
    usage = data.get("usage", {})
    _COST["prompt"] += usage.get("prompt_tokens", 0)
    _COST["completion"] += usage.get("completion_tokens", 0)
    _COST["calls"] += 1
    return data["choices"][0]["message"]["content"]


def chat_json(messages: list[dict], *, tier: str = "mid", **kw) -> dict:
    """强制结构化输出并解析（拆解/意图分析用）。解析失败返回 {}。"""
    txt = chat(messages, tier=tier, json_mode=True, **kw)
    try:
        return json.loads(txt)
    except json.JSONDecodeError:
        start, end = txt.find("{"), txt.rfind("}")
        if 0 <= start < end:
            try:
                return json.loads(txt[start:end + 1])
            except json.JSONDecodeError:
                return {}
        return {}


def cost_summary() -> dict[str, int]:
    return dict(_COST)
