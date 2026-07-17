#!/usr/bin/env bash
# social-auto 平台一键启动(node24 + 独立命名空间/数据目录/端口)
# 多客户并行开发红线:本机还同时跑着其他客户包(namespace baochuang / 端口 4700,4800 /
# 数据目录 ~/.baochuang 均属于其他客户)。本脚本一切生命周期操作(start/stop/status/logs)
# 都限定在 social-auto 命名空间内,tools-dev 按进程 stamp 的 namespace 匹配,绝不触碰其他客户实例。
export NVM_DIR="$HOME/.nvm"; source "$NVM_DIR/nvm.sh" >/dev/null 2>&1; nvm use 24 >/dev/null 2>&1
cd "$(dirname "$0")"
export OD_DATA_DIR="$HOME/.social-auto"
CMD="${1:-start}"; [ $# -gt 0 ] && shift
case "$CMD" in
  start|run)  # 端口参数只有 start/run 认;stop/status/logs 用 namespace 定位实例
    exec pnpm exec tools-dev "$CMD" "$@" --namespace social-auto --daemon-port 4720 --web-port 4820 ;;
  *)
    exec pnpm exec tools-dev "$CMD" "$@" --namespace social-auto ;;
esac
