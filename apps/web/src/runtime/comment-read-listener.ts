// 读评论桥的桌面端执行侧。
//
// CLI/routine POST /api/media-studio/read-comments 建 job，这里(桌面端 web)通过 SSE 收 job →
// 认领 → 在【应用内标签】打开笔记页(openBrowserPane 带 readComments 载荷)→ BrowserPanesHost
// 在标签 webview 里跑评论树提取器、postCommentReadResult 回写 → 轮询到结果后 completeCommentReadJob。
// 只在桌面端挂载：读评论依赖 <webview> 与登录分区，网页版没有。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioCommentReadJob } from '@open-design/contracts';
import { claimCommentReadJob, completeCommentReadJob } from '../providers/media-studio';
import { fetchPlatformAccounts } from '../providers/daemon';
import { openBrowserPane } from './browser-panes';
import { navigate, parseRoute } from '../router';

const EVENTS_URL = '/api/media-studio/read-comments/events';

async function fetchJob(id: string): Promise<StudioCommentReadJob | null> {
  try {
    const resp = await fetch(`/api/media-studio/read-comments/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    const data = (await resp.json()) as { job?: StudioCommentReadJob };
    return data.job ?? null;
  } catch {
    return null;
  }
}

async function executeRead(job: StudioCommentReadJob): Promise<void> {
  if (!(await claimCommentReadJob(job.id))) return; // 别的窗口抢到了
  const returnRoute = parseRoute(window.location.pathname);
  // 用账号中心该平台第一个账号(登录态所在分区);缺则 job.account,再缺 'main'。
  const acctResp = await fetchPlatformAccounts();
  const account =
    job.account ||
    acctResp?.platforms.find((x) => x.id === job.platform)?.accounts?.[0]?.name ||
    'main';
  try {
    openBrowserPane({
      platform: job.platform,
      account,
      url: 'about:blank',
      readComments: { jobId: job.id, platform: job.platform, noteRef: job.noteRef },
    });
    // 轮询到 result 回写(comments 非空或 needsLogin)或超时(2 分钟)→ 落终态。
    const deadline = Date.now() + 2 * 60_000;
    let last: StudioCommentReadJob | null = null;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      last = await fetchJob(job.id);
      if (!last || last.status === 'done' || last.status === 'error') return;
      if (last.comments.length > 0 || last.needsLogin) break;
    }
    const n = last?.comments.length ?? 0;
    const detail = last?.needsLogin ? '需登录（已在标签打开，扫码后重跑）' : `读到 ${n} 条一级评论`;
    completeCommentReadJob(job.id, n > 0 || Boolean(last?.needsLogin), detail);
  } catch (err) {
    completeCommentReadJob(job.id, false, `读评论异常：${err instanceof Error ? err.message : String(err)}`);
  } finally {
    if (returnRoute.kind !== 'browser') navigate(returnRoute);
  }
}

/** 挂上读评论桥监听（桌面端专用；网页版返回空拆卸函数）。 */
export function startCommentReadListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as StudioCommentReadJob;
      if (job?.id) void executeRead(job);
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
