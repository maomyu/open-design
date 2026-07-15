#!/usr/bin/env bash
# 一键停止：优雅停止定时调度器
set -euo pipefail
cd "$(dirname "$0")/.."
if [ -f logs/scheduler.pid ]; then
  PID="$(cat logs/scheduler.pid)"
  if kill -0 "$PID" 2>/dev/null; then
    kill -TERM "$PID"; echo "已发送停止信号给 PID $PID"
  else
    echo "进程不存在"
  fi
  rm -f logs/scheduler.pid
else
  echo "未找到 PID 文件，可能未运行"
fi
