#!/usr/bin/env bash
# 爆创 平台一键启动(node24 + 独立命名空间/数据目录/端口,不撞 multimedia)
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd "$(dirname "$0")"
export OD_DATA_DIR="$HOME/.baochuang"
pnpm exec tools-dev "${1:-start}" --namespace baochuang --daemon-port 4700 --web-port 4800
