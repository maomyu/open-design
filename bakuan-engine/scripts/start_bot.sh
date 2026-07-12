#!/usr/bin/env bash
# 一键启动飞书机器人（后台常驻）。在飞书 @机器人 说“帮我爬取 长期单身”即可。
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs
[ -d .venv ] && source .venv/bin/activate || true
if [ -f logs/bot.pid ] && kill -0 "$(cat logs/bot.pid)" 2>/dev/null; then
  echo "机器人已在运行 (PID $(cat logs/bot.pid))"; exit 0
fi
nohup python scripts/feishu_bot.py >> logs/bot.out 2>&1 &
echo $! > logs/bot.pid
echo "✅ 飞书机器人已启动。现在去飞书 @机器人 说：帮我爬取 长期单身"
echo "   停止：kill \$(cat logs/bot.pid)   看日志：tail -f logs/bot.out"
