// 互动执行桥的桌面端执行侧(自动评论回复/楼中楼/私信)。
//
// CLI/routine/规则引擎 POST /api/media-studio/interaction(建 job 前已过 W1 风控台账)→ 这里
// (桌面端 web)通过 SSE 收 job → 认领 → 在【应用内标签】打开目标页(openBrowserPane 带 interact
// 载荷)→ BrowserPanesHost 的 interact 分支跑拟人回复注入、reportInteractionProgress 回写进度、
// completeInteractionJob 落终态(daemon 端据此写互动审计)。只在桌面端挂载(依赖 <webview> 与登录分区)。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioInteractionJob, StudioInteractionTerminalReason } from '@open-design/contracts';
import { claimInteractionJob } from '../providers/media-studio';
import { fetchPlatformAccounts } from '../providers/daemon';
import { openBrowserPane } from './browser-panes';
import { buildNoteUrl, type CommentPlatform } from './comment-extractors';
import { navigate, parseRoute } from '../router';

const EVENTS_URL = '/api/media-studio/interaction/events';

async function fetchInteractionStatus(
  id: string,
): Promise<{ status: string | null; reason?: StudioInteractionTerminalReason }> {
  try {
    const resp = await fetch(`/api/media-studio/interaction/${encodeURIComponent(id)}`);
    if (!resp.ok) return { status: null };
    const data = (await resp.json()) as { job?: { status?: string; reason?: StudioInteractionTerminalReason } };
    return { status: data.job?.status ?? null, reason: data.job?.reason };
  } catch {
    return { status: null };
  }
}

export async function executeInteraction(job: StudioInteractionJob): Promise<void> {
  if (!(await claimInteractionJob(job.id))) return; // 别的窗口抢到了
  // 发之前记住当前页面(通常是互动页);发完切回去——否则批量发时第一条发完就把用户困在浏览器标签,
  // 看不到后续进度,会以为"没反应"。同读评论桥的 returnRoute 处理。
  const returnRoute = parseRoute(window.location.pathname);
  const acctResp = await fetchPlatformAccounts();
  const account =
    job.account ||
    acctResp?.platforms.find((x) => x.id === job.platform)?.accounts?.[0]?.name ||
    'main';
  // 要打开的页面:楼中楼用 noteRef(笔记 URL,targetRef 是父评论 id);一级评论 noteRef 省略即用 targetRef。
  const pageRef = job.noteRef || job.targetRef;
  const url =
    job.action === 'dm'
      ? 'about:blank'
      : buildNoteUrl(job.platform as CommentPlatform, pageRef) || 'about:blank';
  let stayOnPane = false;
  try {
    openBrowserPane({
      platform: job.platform,
      account,
      url,
      interact: {
        jobId: job.id,
        platform: job.platform,
        action: job.action,
        targetRef: job.targetRef,
        ...(job.noteRef ? { noteRef: job.noteRef } : {}),
        ...(job.authorName ? { authorName: job.authorName } : {}),
        text: job.text,
      },
    });
    // 等这条发完(job 到终态)或超时(90s),再切回原页面。让用户看到这条发出去,又不被困在浏览器标签。
    const deadline = Date.now() + 90_000;
    let terminalReason: StudioInteractionTerminalReason | undefined;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const { status, reason } = await fetchInteractionStatus(job.id);
      if (status === 'done' || status === 'error') { terminalReason = reason; break; }
      if (!status) break;
    }
    // 撞登录墙/触发风控:【不切回】,把标签留在这一页——用户要在这个浏览器里扫码登录 / 人工过验证,
    // daemon 探到登录恢复会自动接着发;切回去用户就没法处理了(用户明确要:留在浏览器等我扫码再继续)。
    stayOnPane = terminalReason === 'needs-login' || terminalReason === 'risk-control';
  } finally {
    if (returnRoute.kind !== 'browser' && !stayOnPane) navigate(returnRoute);
  }
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
