"""Hermes 总控层工具封装 + 常用口令表（≥10 条）。

Hermes 用自然语言调用这些工具；核心工作流不依赖 Hermes —— 即便 Hermes 停止，
src.pipeline 仍可通过命令行独立运行。
高成本批量、删除、发布类操作标记 need_confirm=True，需人工确认。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Callable

from src.llm import router
from src.pipeline import Pipeline


@dataclass
class Tool:
    name: str
    desc: str
    fn: Callable
    need_confirm: bool = False


def _status() -> dict:
    """检查系统状态：成本累计。"""
    return {"llm_cost": router.cost_summary()}


def _run_keyword(keyword: str, platforms: str = "douyin,xiaohongshu,bilibili,kuaishou,channels,gzh") -> dict:
    return Pipeline().run_keyword(keyword, platforms.split(","))


def _run_link(url: str) -> dict:
    return Pipeline().run_single_link(url)


def _last_errors(n: int = 20) -> list[str]:
    try:
        with open("./logs/scheduler.log", encoding="utf-8") as f:
            lines = [ln for ln in f if "ERROR" in ln or "失败" in ln]
        return lines[-n:]
    except FileNotFoundError:
        return ["暂无日志"]


def _switch_model(tier: str, model: str) -> str:
    from config import settings as S
    S.LLM_TIERS[tier] = model
    return f"已将 {tier} 层模型切换为 {model}"


TOOLS: list[Tool] = [
    Tool("check_status", "检查系统状态（成本）", _status),
    Tool("run_keyword", "按关键词跑一次爆款采集与生成", _run_keyword, need_confirm=True),
    Tool("run_link", "处理单条视频链接跑完整链路", _run_link),
    Tool("last_errors", "查看最近一次/若干错误日志", _last_errors),
    Tool("switch_model", "切换某一层的模型别名", _switch_model),
]

# ── 常用口令表（供客户复制即用）──
COMMANDS = [
    "帮我检查系统状态",
    "帮我爬取今天『长期单身』的爆款，平台抖音和小红书",
    "处理这个链接：<粘贴视频链接>",
    "查看最近一次错误",
    "把高质量层模型切换到 deepseek-reasoner",
    "统计今天的接口和模型成本",
]
