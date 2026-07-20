// 登录态校验桥的桌面端执行侧(W6;2026-07-20 改静默探测)。
//
// 心跳/账号页「检测」POST /api/media-studio/login-check 建 job,这里(桌面端 web)经 SSE 收 job →
// 认领 → 【主进程静默探测】该 平台×账号 分区的登录票据 cookie(+可选服务端验)→ 回写结果。
// 全程不开 webview、不导航到平台网址——用户明确要求"检测不许跳标签/网址"(2026-07-20)。
//
// 只在桌面端挂载:登录态在 <webview> 的 persist 分区里,主进程 session.cookies 才够得着,
// 网页版没有 host bridge。probeLogin 不可用(旧包/网页)时报 unknown(daemon 不改判,保留上次态,
// 绝不误报失效)——也【不再退回开可见标签】,静默是硬约束。
import { getOpenDesignHost, isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioLoginCheckJob } from '@open-design/contracts';
import {
  claimLoginCheckJob,
  completeLoginCheckJob,
  postLoginCheckResult,
  reportLoginCheckProgress,
} from '../providers/media-studio';

const EVENTS_URL = '/api/media-studio/login-check/events';

export async function executeCheck(job: StudioLoginCheckJob): Promise<void> {
  if (!(await claimLoginCheckJob(job.id))) return; // 别的窗口抢到了
  const probe = getOpenDesignHost()?.browser?.probeLogin;
  if (!probe) {
    // 旧包/网页版:没有静默探测能力。报 unknown(daemon 保留上次态,不误报),绝不开可见标签。
    await postLoginCheckResult(job.id, 'unknown', '当前宿主不支持后台静默探测');
    completeLoginCheckJob(job.id, true, 'probe 不可用');
    return;
  }
  reportLoginCheckProgress(job.id, '后台校验登录态(不跳转)…');
  try {
    const r = await probe({ platform: job.platform, account: job.account });
    const state = r.ok ? r.state : 'unknown';
    const detail = (r.ok && r.detail) || (state === 'logged-in' ? '登录中' : state === 'logged-out' ? '登录已失效' : '判不了');
    await postLoginCheckResult(job.id, state, detail);
    completeLoginCheckJob(job.id, true, detail);
  } catch (err) {
    await postLoginCheckResult(job.id, 'unknown', err instanceof Error ? err.message : String(err));
    completeLoginCheckJob(job.id, true, '探测异常(不改判)');
  }
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
