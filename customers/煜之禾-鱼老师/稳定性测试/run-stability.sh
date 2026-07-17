#!/bin/bash
# 3天稳定性测试 wrapper(合同交付物):每2小时跑一轮 od baokuan scheduled,
# 结果按行记 JSONL(时间/耗时/exit/结果摘要),3天后汇总成功率交付。
REPO="/Users/maoyu/开发/自媒体营销"
LOG="$REPO/customers/煜之禾-鱼老师/稳定性测试/stability-log.jsonl"
# 本机同时开发多个客户包:必须钉死到爆创专属 namespace(baochuang)的 daemon socket。
# 钉死失败 CLI 会硬报错退出(绝不回退扫描连到别的客户的 daemon)。
export OD_SIDECAR_IPC_PATH="/tmp/open-design/ipc/baochuang/daemon.sock"
TS=$(date "+%Y-%m-%dT%H:%M:%S")
START=$(date +%s)
OUT=$(cd "$REPO" && timeout 1500 node apps/daemon/dist/cli.js baokuan scheduled --json 2>&1)
CODE=$?
DUR=$(( $(date +%s) - START ))
SUMMARY=$(echo "$OUT" | head -c 400 | tr '\n' ' ' | sed 's/"/\\"/g')
echo "{\"ts\":\"$TS\",\"exit\":$CODE,\"durationSec\":$DUR,\"summary\":\"$SUMMARY\"}" >> "$LOG"
