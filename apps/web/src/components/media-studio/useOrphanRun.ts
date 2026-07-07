// 页面刷新/热更后，后台可能仍有创作台的 AI 任务在跑（run 活在 daemon，
// 不依赖页面存活）。本 hook 在「本页没有自己启动的任务」时查一次活跃
// run：发现就亮全局条（并驱动文章轮询），盯到它结束再提示刷新完成。
import { useEffect, useState } from 'react';
import { studioToast } from './StudioFeedback';

const STUDIO_PROJECT_ID = 'media-studio-hub';

export interface OrphanRun {
  id: string;
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
        const data = (await resp.json()) as { runs?: Array<{ id: string }> };
        const run = data.runs?.[0];
        if (run && !stopped) {
          setOrphan({ id: run.id });
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
