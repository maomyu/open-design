// handoff 桥的桌面端执行侧(2026-07-10 全功能 CLI 化)。
//
// CLI `od studio handoff` 在 daemon 建 job,这里(桌面端 web)通过 SSE 收
// job → 认领 → 按文章组稿(draft-builders,与创作台按钮同一份逻辑)→ 打开
// 平台面板注入。注入进度/终态由 BrowserPanesHost 按 draftJobId 回写。
//
// 只在桌面端挂载:注入引擎依赖 <webview> 与登录分区,网页版没有。多桌面
// 窗口同时在线时靠 daemon 的 claim 先到先得防双跑。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import type { StudioHandoffJob } from '@open-design/contracts';
import { fetchPlatformAccounts } from '../providers/daemon';
import {
  claimHandoffJob,
  completeHandoffJob,
  fetchStudioArticle,
  openStudioBrowser,
  reportHandoffProgress,
} from '../providers/media-studio';
import { buildStudioDraft } from '../components/media-studio/draft-builders';

const EVENTS_URL = '/api/media-studio/handoff/events';

export async function executeJob(job: StudioHandoffJob): Promise<void> {
  if (!(await claimHandoffJob(job.id))) return; // 别的窗口抢到了
  const fail = (detail: string) => completeHandoffJob(job.id, false, detail);
  try {
    const article = await fetchStudioArticle(job.articlePlatform, job.articleId);
    if (!article) return fail('文章不存在或已删除——od studio articles 核对 id');
    // 账号解析:CLI 未指定时按账号中心该平台第一个绑定账号(与创作台下拉
    // 默认一致)。没绑定=没有登录档案可用,直接失败并指路。
    let account = job.account?.trim() ?? '';
    if (!account) {
      const accounts = await fetchPlatformAccounts();
      account = accounts?.platforms.find((p) => p.id === job.platform)?.accounts[0]?.name ?? '';
      if (!account) {
        return fail(`「${job.platform}」未绑定账号——到「账号」页新增,或 handoff 时带 --account 指定`);
      }
    }
    const draft = await buildStudioDraft(job.platform, article);
    if (!draft) return fail('稿件没准备好(图集/成片缺失)——回创作台对应步骤检查');
    reportHandoffProgress(job.id, `稿件已组装(${account}),打开「${job.platform}」面板…`);
    const result = await openStudioBrowser({
      platform: job.platform,
      account,
      draft: { ...draft, autoPublish: job.autoPublish },
      draftJobId: job.id,
    });
    if (result.error) return fail(result.error);
    // 到这注入已交给 BrowserPanesHost,后续进度/终态由它按 draftJobId 回写。
  } catch (err) {
    fail(`执行异常:${err instanceof Error ? err.message : String(err)}`);
  }
}

/**
 * 挂上 handoff 桥监听(桌面端专用;网页版返回空拆卸函数)。
 * EventSource 自带断线重连,daemon 端重连时会补发 pending job。
 */
export function startHandoffListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const job = JSON.parse((ev as MessageEvent).data) as StudioHandoffJob;
      if (job?.id) void executeJob(job);
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
