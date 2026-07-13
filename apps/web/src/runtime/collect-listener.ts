// 爆款雷达采集桥的桌面端执行侧（2026-07-12）。
//
// 引擎/CLI POST /api/media-studio/collect 建 job，这里(桌面端 web)通过 SSE 收 job →
// 认领 → 为每个平台在【应用内标签】打开搜索页（openBrowserPane 带 collect 载荷）→
// BrowserPanesHost 在各标签 webview 里滚动+抓卡片，逐平台 postCollectResult 回写 →
// 这里轮询到各平台都回来后 completeCollectJob。全程不弹独立窗口。
//
// 只在桌面端挂载：采集依赖 <webview> 与登录分区，网页版没有。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioCollectJob } from '@open-design/contracts';
import { claimCollectJob, completeCollectJob } from '../providers/media-studio';
import { openBrowserPane } from './browser-panes';
import { buildSearchUrl } from './collect-extractors';

const EVENTS_URL = '/api/media-studio/collect/events';

async function fetchJob(id: string): Promise<StudioCollectJob | null> {
  try {
    const resp = await fetch(`/api/media-studio/collect/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { job?: StudioCollectJob };
    return data.job ?? null;
  } catch {
    return null;
  }
}

async function executeCollect(job: StudioCollectJob): Promise<void> {
  if (!(await claimCollectJob(job.id))) return; // 别的窗口抢到了
  try {
    // 每个平台在应用内标签打开搜索页 + 挂采集载荷（BrowserPanesHost 执行翻页抓取）。
    const nowSec = Math.floor(Date.now() / 1000);
    for (const platform of job.platforms) {
      const url = buildSearchUrl(platform, job.keyword, {
        order: job.order, timeWindow: job.timeWindow, page: 1, nowSec,
      });
      if (!url) continue;
      openBrowserPane({
        platform,
        account: 'main',
        url,
        collect: {
          jobId: job.id, platform, keyword: job.keyword,
          scrolls: job.scrolls, per: job.per,
          order: job.order, timeWindow: job.timeWindow, pages: job.pages, nowSec,
        },
      });
    }
    // 轮询到各平台都回写了结果（或超时）→ 落终态。多平台并发采集时,重平台(小红书/抖音)
    // 首页暖场+懒加载重试较慢,给足 6 分钟避免慢平台没采完就被截断。
    const deadline = Date.now() + 6 * 60_000;
    let last: StudioCollectJob | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2500));
      last = await fetchJob(job.id);
      if (!last || last.status === 'done' || last.status === 'error') return;
      if (last.results.length >= job.platforms.length) break;
    }
    const total = last?.results.reduce((n, r) => n + r.items.length, 0) ?? 0;
    const needLogin = (last?.results ?? []).filter((r) => r.needsLogin).map((r) => r.platform);
    const detail = needLogin.length
      ? `采到 ${total} 条；${needLogin.join('、')} 需登录（已在标签打开，扫码后重跑）`
      : `采到 ${total} 条`;
    completeCollectJob(job.id, total > 0 || needLogin.length > 0, detail);
  } catch (err) {
    completeCollectJob(job.id, false, `采集异常：${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 挂上采集桥监听（桌面端专用；网页版返回空拆卸函数）。 */
export function startCollectListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as StudioCollectJob;
      if (job?.id) void executeCollect(job);
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
