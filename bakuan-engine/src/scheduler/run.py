"""定时调度（APScheduler，替代 n8n）。

按飞书「监控配置库 / 系统配置表」的检测频率定时跑主链路；支持后台常驻、优雅停止。
启动：python -m src.scheduler.run   停止：scripts/stop.sh
"""
from __future__ import annotations

import os
import signal
import sys

from loguru import logger

from src.pipeline import Pipeline


def main():
    interval = int(os.getenv("DEFAULT_DETECT_INTERVAL_MIN", "120"))
    logger.add(os.getenv("LOG_FILE", "./logs/scheduler.log"), rotation="10 MB", retention="30 days")
    from apscheduler.schedulers.blocking import BlockingScheduler

    pipe = Pipeline()
    sched = BlockingScheduler(timezone="Asia/Shanghai")

    @sched.scheduled_job("interval", minutes=interval, id="hot_monitor", max_instances=1)
    def _job():
        logger.info("定时任务触发")
        try:
            pipe.run_scheduled()
        except Exception as e:
            logger.exception(f"定时任务失败: {e}")

    def _graceful(*_):
        logger.info("收到停止信号，优雅退出")
        sched.shutdown(wait=False)
        sys.exit(0)

    signal.signal(signal.SIGTERM, _graceful)
    signal.signal(signal.SIGINT, _graceful)
    logger.info(f"调度器启动，检测频率 {interval} 分钟；首个周期后运行")
    sched.start()


if __name__ == "__main__":
    main()
