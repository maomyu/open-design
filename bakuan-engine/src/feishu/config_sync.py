"""从飞书「系统配置表」拉取配置，运行期覆盖 config.settings 的默认阈值。

验收点：客户在飞书改阈值/频率/TopK/默认模型 → 下次运行读取生效，无需改代码。
配置项名称约定（系统配置表·配置项 单选）：
  点赞阈值.0-5000 / 低粉最低点赞 / 低粉赞粉比 / 检测频率 / TopK / 默认模型.high ...
"""
from __future__ import annotations

import os

from config import settings as S

# 飞书配置项名 → (settings 属性, 类型转换)
_MAP = {
    "低粉最低点赞": ("LOW_FANS_MIN_LIKE", int),
    "低粉赞粉比": ("LOW_FANS_LIKE_RATE", float),
    "低粉粉丝上限": ("LOW_FANS_MAX", int),
    "账号异常观察倍数": ("ANOMALY_OBSERVE", float),
    "账号异常A倍数": ("ANOMALY_A", float),
    "账号异常S倍数": ("ANOMALY_S", float),
    "关键词头部比例": ("KEYWORD_TOP_RATIO", float),
    "快速起量窗口": ("FAST_RISE_HOURS", int),
}


def sync_from_feishu(bitable) -> dict:
    """读系统配置表→覆盖 settings。返回本次生效的覆盖项，便于日志/回测。"""
    applied = {}
    try:
        rows = bitable.list_records("系统配置表", filter_="CurrentValue.[是否启用]=true")
    except Exception:
        return applied
    for r in rows:
        f = r.get("fields", {})
        item = _txt(f.get("配置项"))
        val = _txt(f.get("当前值"))
        if item in _MAP and val:
            attr, cast = _MAP[item]
            try:
                setattr(S, attr, cast(val))
                applied[item] = getattr(S, attr)
            except (ValueError, TypeError):
                continue
        elif item == "检测频率" and val:
            os.environ["DEFAULT_DETECT_INTERVAL_MIN"] = str(int(float(val)))
            applied[item] = val
        elif item == "TopK" and val:
            os.environ["RAG_TOPK"] = str(int(float(val)))
            applied[item] = val
        elif item.startswith("默认模型") and val:
            tier = item.split(".")[-1]
            if tier in S.LLM_TIERS:
                S.LLM_TIERS[tier] = val
                applied[item] = val
    return applied


def _txt(v) -> str:
    if isinstance(v, list) and v:
        return v[0].get("text", "") if isinstance(v[0], dict) else str(v[0])
    return str(v or "")
