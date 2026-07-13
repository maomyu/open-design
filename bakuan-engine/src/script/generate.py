"""原创口播脚本生成（两种风格）+ 原创性检查。

对应主链路 步骤7 拆解 → 8 召回 → 9 脚本 → 10 原创性检查。
两种风格：imitate 仿写原视频风格 / rewrite 按客户自有风格改写，可同时生成。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

from src.llm import prompts, router


@dataclass
class ScriptResult:
    platform_title: str = ""
    cover_titles: list[str] = field(default_factory=list)
    script_60: str = ""
    script_90: str = ""
    tags: str = ""
    intro: str = ""
    comment_guide: str = ""
    dm_keywords: str = ""
    originality_note: str = ""
    similarity_warn: list[str] = field(default_factory=list)   # 高相似句提醒
    mode: str = ""

    def to_feishu(self, platform: str, version: int) -> dict:
        return {
            "平台版本": platform, "平台标题": self.platform_title,
            "封面标题候选": " / ".join(self.cover_titles),
            "60秒脚本": self.script_60, "90秒脚本": self.script_90,
            "标签": self.tags, "简介": self.intro, "评论引导": self.comment_guide,
            "原创性检查": self.originality_note + (
                "\n⚠️高相似：" + "；".join(self.similarity_warn) if self.similarity_warn else ""),
            "生成版本": version, "审核状态": "待审",
        }


def deconstruct(title: str, transcript: str, stats: dict) -> dict:
    return router.chat_json(
        [{"role": "system", "content": prompts.DECONSTRUCT_SYS},
         {"role": "user", "content": prompts.deconstruct_user(title, transcript, stats)}],
        tier="mid")


def generate(decon: dict, materials: list[str], style_profile: dict | None,
             mode: str, original_text: str = "") -> ScriptResult:
    data = router.chat_json(
        [{"role": "system", "content": prompts.SCRIPT_SYS},
         {"role": "user", "content": prompts.script_user(decon, materials, style_profile, mode)}],
        tier="high", max_tokens=3000)
    res = ScriptResult(
        platform_title=data.get("platform_title", ""),
        cover_titles=data.get("cover_titles", []) or [],
        script_60=data.get("script_60", ""), script_90=data.get("script_90", ""),
        tags=data.get("tags", ""), intro=data.get("intro", ""),
        comment_guide=data.get("comment_guide", ""), dm_keywords=data.get("dm_keywords", ""),
        originality_note=data.get("originality_note", ""), mode=mode)
    res.similarity_warn = _similarity_check(res.script_90 or res.script_60, original_text)
    return res


def _similarity_check(generated: str, original: str) -> list[str]:
    """朴素高相似句检测：与原文重合度高的句子给出提醒（避免复制表达）。"""
    if not original:
        return []
    orig_sents = {s.strip() for s in re.split(r"[。！？\n]", original) if len(s.strip()) >= 8}
    warns = []
    for s in re.split(r"[。！？\n]", generated):
        s = s.strip()
        if len(s) < 8:
            continue
        for o in orig_sents:
            if _overlap(s, o) >= 0.7:
                warns.append(s[:30])
                break
    return warns[:5]


def _overlap(a: str, b: str) -> float:
    sa, sb = set(a), set(b)
    return len(sa & sb) / max(1, len(sa | sb))
