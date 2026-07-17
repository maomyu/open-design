"""飞书机器人：在飞书里 @机器人 说一句话，就自动跑爆款监控并把结果回复给你。

原理：用 lark-cli 长连接订阅"收到消息"事件 → 解析关键词 → 跑主链路(写飞书) → 回复摘要。
启动：bash scripts/start_bot.sh   （需飞书应用已开启事件与权限，详见文末/README）
用法（在飞书里对机器人说）：
    帮我爬取 长期单身
    爬 相亲
    长期单身          ← 直接发关键词也行
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))
from dotenv import load_dotenv  # noqa: E402

load_dotenv(dotenv_path=str(ROOT / ".env"), override=True)

PROFILE = os.getenv("LARK_PROFILE", "yuzhihe")
BASE_URL = f"https://mcnkjk5ixiyt.feishu.cn/base/{os.getenv('FEISHU_BITABLE_APP_TOKEN','')}"
PLATFORMS = ["douyin", "xiaohongshu", "bilibili", "kuaishou", "gzh", "channels"]

# 去掉这些前缀词后剩下的就是关键词（前缀可叠加，如“请帮我搜一下”）
_PREFIX = re.compile(r"^((帮我|请|麻烦|我想|想|今天|一下|下)\s*)*"
                     r"(爬取|爬|搜索|搜|查一下|查|找|监控|跑)?\s*(一下|下)?\s*")
_MENTION = re.compile(r"@[^\s]+")


def reply(chat_id: str, text: str) -> None:
    subprocess.run(["lark-cli", "im", "+messages-send", "--profile", PROFILE, "--as", "bot",
                    "--chat-id", chat_id, "--msg-type", "text",
                    "--content", json.dumps({"text": text}, ensure_ascii=False)],
                   capture_output=True, text=True, encoding="utf-8", errors="replace")


def extract_keyword(content: str) -> str:
    txt = _MENTION.sub("", content or "").strip()
    txt = _PREFIX.sub("", txt).strip()
    return txt[:30]


def handle(evt: dict) -> None:
    chat_id = evt.get("chat_id", "")
    content = evt.get("content", "")
    kw = extract_keyword(content)
    if not chat_id or not kw:
        return
    reply(chat_id, f"收到 ✅ 正在全网爬取「{kw}」的爆款并生成脚本，约几分钟，稍等…")
    try:
        os.environ["FEISHU_BACKEND"] = "larkcli"
        from src.pipeline import Pipeline
        res = Pipeline(dry_run=False).run_keyword(kw, PLATFORMS)
        reply(chat_id,
              f"「{kw}」跑完啦 🎉\n"
              f"入库爆款 {res['candidates']} 条，生成脚本 {res['generated']} 组。\n"
              f"打开飞书多维表格看结果：{BASE_URL}\n"
              f"（今日爆款选题池=选题+评分，成品内容审核库=口播脚本）")
    except Exception as e:
        reply(chat_id, f"「{kw}」跑的时候出了点问题：{str(e)[:80]}。稍后我看下日志。")


def main() -> None:
    proc = subprocess.Popen(
        ["lark-cli", "event", "consume", "im.message.receive_v1",
         "--profile", PROFILE, "--as", "bot", "--quiet"],
        stdout=subprocess.PIPE, text=True, encoding="utf-8", errors="replace", bufsize=1)
    print("🤖 飞书机器人已启动，正在监听消息…（在飞书里 @机器人 说『帮我爬取 长期单身』试试）")
    assert proc.stdout
    for line in proc.stdout:
        line = line.strip()
        if not line or not line.startswith("{"):
            continue
        try:
            evt = json.loads(line)
        except json.JSONDecodeError:
            continue
        data = evt.get("data", evt)   # 事件负载
        if isinstance(data, dict) and data.get("chat_id"):
            handle(data)


if __name__ == "__main__":
    main()
