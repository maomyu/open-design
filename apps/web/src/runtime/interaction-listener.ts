// 互动执行桥的桌面端执行侧(自动评论回复/楼中楼/私信)。
//
// CLI/routine/规则引擎 POST /api/media-studio/interaction(建 job 前已过 W1 风控台账)→ 这里
// (桌面端 web)通过 SSE 收 job → 认领 → 在【应用内标签】打开目标页(openBrowserPane 带 interact
// 载荷)→ BrowserPanesHost 的 interact 分支跑拟人回复注入、reportInteractionProgress 回写进度、
// completeInteractionJob 落终态(daemon 端据此写互动审计)。只在桌面端挂载(依赖 <webview> 与登录分区)。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioInteractionJob } from '@open-design/contracts';
import { claimInteractionJob } from '../providers/media-studio';
import { fetchPlatformAccounts } from '../providers/daemon';
import { openBrowserPane } from './browser-panes';
import { buildNoteUrl, type CommentPlatform } from './comment-extractors';

const EVENTS_URL = '/api/media-studio/interaction/events';

async function executeInteraction(job: StudioInteractionJob): Promise<void> {
  if (!(await claimInteractionJob(job.id))) return; // 别的窗口抢到了
  const acctResp = await fetchPlatformAccounts();
  const account =
    job.account ||
    acctResp?.platforms.find((x) => x.id === job.platform)?.accounts?.[0]?.name ||
    'main';
  // 一级评论:targetRef 是笔记链接,打开它;楼中楼:也先打开笔记页(注入器在页内定位父评论)。
  const url =
    job.action === 'dm'
      ? 'about:blank'
      : buildNoteUrl(job.platform as CommentPlatform, job.targetRef) || 'about:blank';
  openBrowserPane({
    platform: job.platform,
    account,
    url,
    interact: { jobId: job.id, platform: job.platform, action: job.action, targetRef: job.targetRef, text: job.text },
  });
}

/** 挂上互动执行桥监听(桌面端专用;网页版返回空拆卸函数)。 */
export function startInteractionListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as StudioInteractionJob;
      if (job?.id) void executeInteraction(job);
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
