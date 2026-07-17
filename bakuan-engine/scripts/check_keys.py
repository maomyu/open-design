"""钥匙自检：填完 .env 后一键测各平台连通性，报告哪些通了。

用法：python scripts/check_keys.py
逐项：✅ 通  ⬜ 未配置  ❌ 报错(附原因)。只做最小只读探测，不产生费用/写入。
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from dotenv import load_dotenv

load_dotenv()

import requests  # noqa: E402


def _r(name: str, status: str, detail: str = ""):
    icon = {"ok": "✅", "skip": "⬜", "err": "❌"}[status]
    print(f"{icon} {name:14} {detail}")


def check_tikhub():
    key = os.getenv("TIKHUB_API_KEY")
    if not key or "待填" in key:
        return _r("TikHub", "skip", "未配置")
    try:
        base = os.getenv("TIKHUB_API_BASE", "https://api.tikhub.io").rstrip("/")
        r = requests.get(f"{base}/api/v1/tikhub/user/get_user_info",
                         headers={"Authorization": f"Bearer {key}"}, timeout=15)
        _r("TikHub", "ok" if r.status_code == 200 else "err",
           f"HTTP {r.status_code}（余额/账户接口）")
    except Exception as e:
        _r("TikHub", "err", str(e)[:80])


def check_deepseek():
    key = os.getenv("DEEPSEEK_API_KEY")
    if not key or "待填" in key:
        return _r("DeepSeek", "skip", "未配置")
    try:
        base = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com").rstrip("/")
        r = requests.get(f"{base}/models", headers={"Authorization": f"Bearer {key}"}, timeout=15)
        _r("DeepSeek", "ok" if r.status_code == 200 else "err", f"HTTP {r.status_code}")
    except Exception as e:
        _r("DeepSeek", "err", str(e)[:80])


def check_ark():
    key = os.getenv("ARK_API_KEY")
    if not key or "待填" in key:
        return _r("火山Ark", "skip", "未配置")
    try:
        base = os.getenv("ARK_API_BASE", "").rstrip("/")
        r = requests.get(f"{base}/models", headers={"Authorization": f"Bearer {key}"}, timeout=15)
        _r("火山Ark", "ok" if r.status_code in (200, 404) else "err",
           f"HTTP {r.status_code}（生图模型 {os.getenv('IMAGE_MODEL')}）")
    except Exception as e:
        _r("火山Ark", "err", str(e)[:80])


def check_dajiala():
    key = os.getenv("DAJIALA_KEY")
    if not key or "待填" in key:
        return _r("极致了", "skip", "未配置（公众号兜底，可选）")
    _r("极致了", "ok", "已配置 Key（连通以实际调用为准）")


def main():
    print("=== 平台连通自检（只读探测）===")
    for fn in (check_tikhub, check_deepseek, check_ark, check_dajiala):
        try:
            fn()
        except Exception as e:
            print(f"❌ {fn.__name__} 异常: {e}")
    print("\n提示：TikHub 各平台具体端点路径以其 Swagger 为准，实盘首跑我会逐个校对。")


if __name__ == "__main__":
    main()
