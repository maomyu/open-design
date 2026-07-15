#!/usr/bin/env bash
# 查看日志：实时跟随调度器日志
set -euo pipefail
cd "$(dirname "$0")/.."
tail -n 100 -f logs/scheduler.log
