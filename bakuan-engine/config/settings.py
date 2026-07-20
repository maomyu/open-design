"""全局配置：从 .env 读取 + 爆款判定默认阈值/权重。

飞书「系统配置表」可在运行期覆盖这里的默认值（见 src/feishu/config_sync.py，后续实现）。
所有阈值集中在此，便于《系统全参数配置对照表》一一对应。
"""
from __future__ import annotations

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

# override=False：已注入的环境变量（daemon 从「媒体设置」读用户配的 key 注入）优先，
# .env 只补它没有的键。此前 override=True 会用出厂 .env 的【空值】反噬 daemon 注入的真 key
# ——客户机上 TikHub/dajiala/ARK 全被空 .env 洗掉、视频号静默采 0(2026-07-20 审计撞出)。
# dev 机没有注入环境变量，.env 里的真 key 照常加载，不受影响。
load_dotenv(override=False)


def _env(key: str, default: str = "") -> str:
    return os.getenv(key, default)


# ── 平台清单（6 平台）──
PLATFORMS = ["douyin", "xiaohongshu", "bilibili", "kuaishou", "channels", "gzh"]
PLATFORM_CN = {
    "douyin": "抖音", "xiaohongshu": "小红书", "bilibili": "B站",
    "kuaishou": "快手", "channels": "视频号", "gzh": "公众号",
}


@dataclass
class Keys:
    feishu_app_id: str = field(default_factory=lambda: _env("FEISHU_APP_ID"))
    feishu_app_secret: str = field(default_factory=lambda: _env("FEISHU_APP_SECRET"))
    feishu_bitable_token: str = field(default_factory=lambda: _env("FEISHU_BITABLE_APP_TOKEN"))
    tikhub_base: str = field(default_factory=lambda: _env("TIKHUB_API_BASE", "https://api.tikhub.io"))
    tikhub_key: str = field(default_factory=lambda: _env("TIKHUB_API_KEY"))
    dajiala_base: str = field(default_factory=lambda: _env("DAJIALA_API_BASE", "https://www.dajiala.com"))
    dajiala_key: str = field(default_factory=lambda: _env("DAJIALA_KEY"))
    ark_base: str = field(default_factory=lambda: _env("ARK_API_BASE"))
    ark_key: str = field(default_factory=lambda: _env("ARK_API_KEY"))
    image_model: str = field(default_factory=lambda: _env("IMAGE_MODEL", "doubao-seedream-5.0"))


# ── 文本模型三层路由 ──
LLM_TIERS = {
    "low": _env("LLM_TIER_LOW", "deepseek-chat"),
    "mid": _env("LLM_TIER_MID", "deepseek-chat"),
    "high": _env("LLM_TIER_HIGH", "deepseek-reasoner"),
}

# ── 爆款判定：第一阶段规则初筛默认阈值（客户标准，可在飞书改）──
# 绝对热度：按粉丝分层的最低点赞门槛 [(粉丝上限, 最低点赞)]，升序
FANS_LIKE_THRESHOLDS = [
    (5_000, 500),
    (10_000, 800),
    (50_000, 1_500),
    (100_000, 3_000),
    (500_000, 5_000),
    (1_000_000, 10_000),
    (float("inf"), 20_000),
]
LOW_FANS_MAX = 5_000          # 低粉高表现：粉丝上限
LOW_FANS_MIN_LIKE = 300       # 低粉高表现：最低点赞
LOW_FANS_LIKE_RATE = 0.20     # 低粉高表现：点赞/粉丝 ≥ 20%
ANOMALY_MIN_WORKS = 10        # 账号异常值：作品数下限（<10 不收录）
ANOMALY_OBSERVE = 2.0         # ≥ 中位数 2 倍 → 观察池
ANOMALY_A = 3.0               # ≥ 3 倍 → A 级异常
ANOMALY_S = 5.0               # ≥ 5 倍 → S 级异常
GZH_READ_MIN = 3000           # 公众号无粉丝数，按阅读量初筛门槛（10万+算爆款）
CHANNELS_ENGAGE_MIN = 100     # 视频号无粉丝/播放数，按综合互动(赞+藏+评+转)初筛
PLAYS_HOT_MIN = 100_000       # 浏览器采集只拿到播放没点赞时(如B站搜索卡片)，按播放兜底初筛
KEYWORD_TOP_RATIO = 0.10      # 关键词头部 Top 10%
KEYWORD_MIN_SAMPLE = 20       # 启用 Top10% 的最小样本量
FAST_RISE_HOURS = 72          # 快速起量：发布时长窗口

# ── 爆款判定：第二阶段评分维度权重 ──
TRAFFIC_WEIGHTS = {           # 流量爆款分 0-100
    "data_heat": 20, "growth": 20, "interaction": 15,
    "account_excess": 15, "topic_match": 15, "structure": 15,
}
INTENT_WEIGHTS = {            # 精准意向分 0-100
    "ask_help": 20, "method_query": 15, "self_projection": 15,
    "pain_specific": 10, "save_tendency": 10, "comment_density": 10,
    "audience_match": 10, "high_ticket": 10,
}
GRADE_CUTOFFS = [("S", 85), ("A", 75), ("B", 65)]   # 低于 65 → 归档(C)

KEYS = Keys()
