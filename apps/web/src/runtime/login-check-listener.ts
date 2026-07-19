// 登录态校验桥的桌面端执行侧(W6)。
//
// 心跳/账号页「检测」POST /api/media-studio/login-check 建 job，这里(桌面端 web)经 SSE 收 job →
// 认领 → 在【应用内标签】打开平台主站(openBrowserPane 带 loginCheck 载荷)→ BrowserPanesHost
// 在标签 webview 里跑登录探测、postLoginCheckResult 回写 → completeLoginCheckJob。
// 只在桌面端挂载：登录态在 <webview> 的 persist 分区里(cookie vault),网页版够不着。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioLoginCheckJob } from '@open-design/contracts';
import { claimLoginCheckJob } from '../providers/media-studio';
import { openBrowserPane } from './browser-panes';

const EVENTS_URL = '/api/media-studio/login-check/events';

export async function executeCheck(job: StudioLoginCheckJob): Promise<void> {
  if (!(await claimLoginCheckJob(job.id))) return; // 别的窗口抢到了
  // 探测在【该账号的登录分区】里进行——必须用 job.account 作为分区键,否则测的是别的档案。
  // 结果与终态由 BrowserPanesHost 的 runLoginCheck 直接回写(它探完 postLoginCheckResult +
  // completeLoginCheckJob),这里只负责认领 + 把标签开到平台主站。掉线时标签停在登录页,顺便当补登入口。
  openBrowserPane({
    platform: job.platform,
    account: job.account,
    url: 'about:blank',
    loginCheck: { jobId: job.id, platform: job.platform, account: job.account },
  });
}

/** 挂上登录态校验桥监听（桌面端专用；网页版返回空拆卸函数）。 */
export function startLoginCheckListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as StudioLoginCheckJob;
      if (job?.id) void executeCheck(job);
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
