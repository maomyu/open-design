// 页面刷新/热更/切换导航后，后台可能仍有创作台的 AI 任务在跑（run 活在 daemon，
// 不依赖页面存活）。本 hook 在「本页没有自己启动的任务」时查一次活跃 run：发现就亮
// 全局条（并驱动文章轮询），盯到它结束再提示刷新完成。
import { useEffect, useState } from 'react';
import { studioToast } from './StudioFeedback';

const STUDIO_PROJECT_ID = 'media-studio-hub';

export interface OrphanRun {
  id: string;
  /** 后台 run 的真实开始时间(run.createdAt)。计时基准取它,切走导航/刷新
   *  后组件重挂载也能算出真实累计运行时长,不从 0 重来。 */
  startedAt: number;
}

/** 运行计时秒数格式化——「X 分 X 秒 / X 秒」,各创作台运行条统一用。 */
export function fmtRunElapsed(sec: number): string {
  return sec >= 60 ? `${Math.floor(sec / 60)} 分 ${sec % 60} 秒` : `${sec} 秒`;
}

/** AI 任务运行计时(单点正确)。基准优先用后台 run 的真实开始时间 `startedAt`
 *  ——切走左侧导航再切回、或页面刷新后组件重挂载,计时仍接着真实开始时间算,
 *  不会归零让人误以为写作中断了。本页刚启动、后台开始时间尚未拿到时,退回当前
 *  时刻起算(误差仅一次网络往返)。running 结束即归 0。 */
export function useAiRunElapsed(running: boolean, startedAt?: number | null): number {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const base = typeof startedAt === 'number' && startedAt > 0 ? startedAt : Date.now();
    const tick = (): void => setElapsed(Math.max(0, Math.floor((Date.now() - base) / 1000)));
    tick();
    const timer = window.setInterval(tick, 1000);
    return () => window.clearInterval(timer);
  }, [running, startedAt]);
  return elapsed;
}

export function useOrphanRun(enabled: boolean): {
  orphan: OrphanRun | null;
  cancelOrphan: () => void;
} {
  const [orphan, setOrphan] = useState<OrphanRun | null>(null);

  useEffect(() => {
    if (!enabled) {
      setOrphan(null);
      return;
    }
    let stopped = false;
    let timer: number | null = null;
    const watch = (id: string): void => {
      const tick = async (): Promise<void> => {
        if (stopped) return;
        try {
          const resp = await fetch(`/api/runs/${encodeURIComponent(id)}`);
          if (resp.ok) {
            const data = (await resp.json()) as { status?: string };
            if (data.status === 'running') {
              timer = window.setTimeout(() => void tick(), 4000);
              return;
            }
          }
        } catch {
          /* daemon 短暂不可达按结束处理 */
        }
        if (!stopped) {
          setOrphan(null);
          studioToast.ok('后台 AI 任务已结束，产物已写回并刷新');
        }
      };
      void tick();
    };
    void (async () => {
      try {
        const resp = await fetch(`/api/runs?projectId=${STUDIO_PROJECT_ID}&status=running`);
        if (!resp.ok) return;
        const data = (await resp.json()) as { runs?: Array<{ id: string; createdAt?: number }> };
        const run = data.runs?.[0];
        if (run && !stopped) {
          setOrphan({ id: run.id, startedAt: typeof run.createdAt === 'number' ? run.createdAt : Date.now() });
          watch(run.id);
        }
      } catch {
        /* ignore */
      }
    })();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [enabled]);

  const cancelOrphan = (): void => {
    if (!orphan) return;
    void fetch(`/api/runs/${encodeURIComponent(orphan.id)}/cancel`, { method: 'POST' }).then(() => {
      setOrphan(null);
      studioToast.info('后台任务已中止');
    });
  };

  return { orphan, cancelOrphan };
}
