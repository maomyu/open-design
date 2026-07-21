"""三层文本模型路由（可切换 + fallback + 成本记录）。

low  分类/去重/初筛   mid  爆点拆解/结构分析   high  脚本/标题/评论引导
兼容 OpenAI 风格 /chat/completions（DeepSeek、火山方舟等均适用）。
模型别名与 Key 全部来自 .env，绝不写死；主模型失败自动切备用。
"""
from __future__ import annotations

import json
import os
import platform
import subprocess
from typing import Any

import requests
from tenacity import retry, stop_after_attempt, wait_exponential

from config import settings as S

_COST: dict[str, int] = {"prompt": 0, "completion": 0, "calls": 0}


def _chat_via_cli(cli_cmd: str, messages: list[dict], *, json_mode: bool) -> str:
    """经【本地 CLI 智能体】(如 claude -p)拿一次补全——用用户的 CLI 登录态,不需任何
    LLM API key。daemon 把已扫描到的 CLI 命令注入 LLM_CLI_CMD(全路径)+ 认证 env。
    2026-07-22 用户拍板:引擎 AI 统一走本地 CLI,不再各自接 deepseek/ARK(交付版洗空
    key 导致 win 采集 0 条的根因)。"""
    sys_txt = next((m.get("content", "") for m in messages if m.get("role") == "system"), "")
    usr_txt = "\n\n".join(m.get("content", "") for m in messages if m.get("role") != "system")
    prompt = (sys_txt + "\n\n" + usr_txt).strip() if sys_txt else usr_txt
    if json_mode:
        prompt += "\n\n【严格输出要求】只输出一个 JSON 对象本身,不要 markdown 代码块、不要任何解释或前后缀文字。"
    cmd = cli_cmd.split() if " " in cli_cmd else [cli_cmd]
    if platform.system() == "Windows" and cmd and cmd[0].lower().endswith(".ps1"):
        # npm 在 win 同时装 claude.cmd(cmd.exe 可执行)和 claude.ps1(只 PowerShell 能跑)。
        # 交给 cmd.exe(shell=True)跑 .ps1 会被当"打开文件"卡死到 180s 超时(2026-07-22 win
        # 实测)→ 采集评分全挂 0 条。解析出 .ps1 就换同目录同名 .cmd。
        _alt = cmd[0][:-4] + ".cmd"
        if os.path.exists(_alt):
            cmd[0] = _alt
    # prompt 走 stdin(避开中文/换行/引号当命令行参数的转义地狱);命令行只留固定 flag。
    args = cmd + ["-p", "--output-format", "text"]
    run_kw: dict[str, Any] = dict(
        input=prompt, capture_output=True, text=True,
        encoding="utf-8", errors="replace", timeout=180,
    )
    if platform.system() == "Windows":
        # win 的 claude 是 .cmd/.ps1 包装,不能直接 CreateProcess → 走 shell(args 只有固定
        # flag,list2cmdline 安全;prompt 在 stdin 不进命令行)。
        r = subprocess.run(subprocess.list2cmdline(args), shell=True, **run_kw)
    else:
        r = subprocess.run(args, **run_kw)
    out = (r.stdout or "").strip()
    if not out:
        raise RuntimeError(f"本地CLI({cmd[0]})无输出 rc={r.returncode}: {(r.stderr or '')[:200]}")
    _COST["calls"] += 1
    try:
        from src import store as _store
        _store.add_cost("llm-cli", len(prompt) + len(out), detail=cmd[0])
    except Exception:  # noqa: BLE001
        pass
    return out


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
def _chat_once(model: str, base: str, key: str, messages: list[dict], *,
               json_mode: bool, temperature: float, max_tokens: int) -> str:
    """单模型调用(超时重试 2 次由 tenacity 管)。"""
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
    # 成本台账(模块9):tokens 落本地库,供日报/周报
    try:
        from src import store as _store
        _store.add_cost("llm", usage.get("prompt_tokens", 0) + usage.get("completion_tokens", 0),
                        detail=model)
    except Exception:  # noqa: BLE001
        pass
    return data["choices"][0]["message"]["content"]


def chat(messages: list[dict], *, tier: str = "mid", json_mode: bool = False,
         temperature: float = 0.7, max_tokens: int = 2048) -> str:
    if os.getenv("DRY_RUN") == "1":
        _COST["calls"] += 1
        return _dry_response(messages)
    # 本地 CLI 智能体优先(用户拍板:AI 统一走本地 CLI)。没注入 LLM_CLI_CMD 才退回 HTTP。
    cli_cmd = os.getenv("LLM_CLI_CMD", "").strip()
    if cli_cmd:
        return _chat_via_cli(cli_cmd, messages, json_mode=json_mode)
    base, key, model = _endpoint(tier)
    kw = dict(json_mode=json_mode, temperature=temperature, max_tokens=max_tokens)
    try:
        return _chat_once(model, base, key, messages, **kw)
    except Exception as e:  # noqa: BLE001
        # 验收11:主模型失败(重试后仍失败)→ 自动切备用模型;备用也挂才向上抛(进失败队列)。
        backup = os.getenv("LLM_FALLBACK_MODEL", "deepseek-chat")
        if not backup or backup == model:
            raise
        from loguru import logger
        logger.warning(f"主模型 {model} 失败({type(e).__name__}),切备用 {backup} 重试")
        return _chat_once(backup, base, key, messages, **kw)


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
