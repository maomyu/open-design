"""一键上线：凭据齐了就跑这个，自动完成实盘交付的最后一公里。

步骤：自检 Key → 建飞书 12 表(缺则建) → 实盘跑多平台一轮(采集→评分→脚本→封面→回写飞书)
     → 打印验收报告。任一 Key 缺失会明确指出，并降级跳过对应环节而非报错。
用法：填好 .env 后  ./.venv/bin/python scripts/go_live.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(dotenv_path=str(ROOT / ".env"))


def _has(k: str) -> bool:
    v = os.getenv(k, "")
    return bool(v) and "待填" not in v and not v.endswith("xxxx")


def main():
    print("=" * 48)
    print("  自媒体爆款监控 · 一键上线")
    print("=" * 48)
    report = []

    tik = _has("TIKHUB_API_KEY")
    llm = _has("DEEPSEEK_API_KEY")
    ark = _has("ARK_API_KEY")
    feishu = _has("FEISHU_APP_ID") and _has("FEISHU_BITABLE_APP_TOKEN")
    print(f"\n[凭据] TikHub={tik} DeepSeek={llm} 火山ARK={ark} 飞书App={feishu}")

    if not (tik and llm):
        print("\n✋ TikHub + DeepSeek 是主干必需，请先填这两个再运行。")
        return

    # 1) 飞书建表
    if feishu:
        try:
            import subprocess
            print("\n[1/3] 建飞书 12 表 …")
            subprocess.run([sys.executable, str(ROOT / "scripts" / "init_feishu.py")], check=False)
            report.append("✅ 飞书建表已执行")
        except Exception as e:
            report.append(f"⚠️ 飞书建表异常：{e}")
    else:
        report.append("⬜ 跳过飞书（未配置 App）——产物暂不回写")

    # 2) 实盘跑一轮
    print("\n[2/3] 实盘采集→评分→脚本 …")
    from src.pipeline import Pipeline
    pipe = Pipeline(dry_run=not feishu)   # 无飞书则 dry-run 收集到本地
    platforms = ["douyin", "xiaohongshu", "bilibili", "kuaishou"]
    res = pipe.run_keyword("长期单身", platforms)
    report.append(f"✅ 实盘跑通：候选 {res['candidates']} 条，生成 {res['generated']} 组脚本")

    # 3) 封面
    print("\n[3/3] 生成封面 …")
    try:
        from src.cover.seedream import CoverRequest, SeedreamCover
        out = str(ROOT / "data" / "covers" / "go_live_demo.png")
        SeedreamCover().render(CoverRequest(platform="douyin",
                                            main_title="上线自检封面", subtitle="Seedream+叠字"), out)
        report.append(f"✅ 封面已出图：{out}" + ("（Seedream 背景）" if ark else "（渐变底，待 ARK）"))
    except Exception as e:
        report.append(f"⚠️ 封面：{e}")

    print("\n" + "=" * 48 + "\n  验收报告\n" + "=" * 48)
    for r in report:
        print(" ", r)
    print("\n下一步：视频号/公众号如需，去 TikHub 后台开『微信』权限。")


if __name__ == "__main__":
    main()
