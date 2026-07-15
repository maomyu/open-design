#!/usr/bin/env bash
# 一键启动：后台常驻运行定时调度器
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p logs data
[ -d .venv ] && source .venv/bin/activate || true
if [ -f logs/scheduler.pid ] && kill -0 "$(cat logs/scheduler.pid)" 2>/dev/null; then
  echo "已在运行 (PID $(cat logs/scheduler.pid))"; exit 0
fi
nohup python -m src.scheduler.run >> logs/scheduler.out 2>&1 &
echo $! > logs/scheduler.pid
echo "已启动，PID=$(cat logs/scheduler.pid)，日志：logs/scheduler.log"
