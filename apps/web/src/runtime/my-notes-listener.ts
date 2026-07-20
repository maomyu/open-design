// 「我的笔记」抓取桥的桌面端执行侧。
//
// UI 点「拉取/刷新」建 job → 经合流 SSE 收 job → 认领 → 在【应用内标签】进账号主页抓已发笔记 →
// BrowserPanesHost.runMyNotes 回写。UI 侧 fetchMyNotes 长轮询拿结果填进选择器。
//
// 为什么要把标签切到前台(而不是后台悄悄抓):后台标签宿主是 visibility:hidden,Electron <webview>
// 在隐藏宿主里 executeJavaScript 打不通(实测抓取卡在「打开主站」)。故认领后 openBrowserPane
// 前台化(宿主 hostActive、webview 可执行),抓完把视图切回用户原来的页(通常是「互动」/interaction)。
// 只在桌面端有意义(登录态在 webview 分区里)。
import type { StudioMyNotesJob } from '@open-design/contracts';
import { claimMyNotesJob } from '../providers/media-studio';
import { openBrowserPane } from './browser-panes';
import { navigate, parseRoute } from '../router';

async function fetchMyNotesJob(id: string): Promise<StudioMyNotesJob | null> {
  try {
    const resp = await fetch(`/api/media-studio/my-notes/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return ((await resp.json()) as { job?: StudioMyNotesJob }).job ?? null;
  } catch {
    return null;
  }
}

export async function executeMyNotes(job: StudioMyNotesJob): Promise<void> {
  if (!(await claimMyNotesJob(job.id))) return; // 别的窗口抢到了
  const account = job.account ?? 'main';
  const returnRoute = parseRoute(window.location.pathname); // 抓完切回用户原来的页
  try {
    openBrowserPane({
      platform: job.platform,
      account,
      url: 'about:blank',
      myNotes: { jobId: job.id, platform: job.platform, account },
    });
    // 轮询到【真·终态】再切回去——绝不能因一次瞬时取不到(!j)就提前 navigate:切回后宿主
    // visibility:hidden、webview 脱离,正在跑的 runMyNotes 抽取就被掐断(实测=抓到 0 条)。
    // 只认 done/error;真丢了(过期)就靠 deadline 兜底。
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1500));
      const j = await fetchMyNotesJob(job.id);
      if (j && (j.status === 'done' || j.status === 'error')) break;
    }
  } finally {
    if (returnRoute.kind !== 'browser') navigate(returnRoute);
  }
}
