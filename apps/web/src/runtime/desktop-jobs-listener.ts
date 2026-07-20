// 桌面端派发任务的【单连接多路复用】监听器。
//
// 为什么合一:创作台有 5 类需要桌面端(<webview> 登录分区)执行的 daemon 派发任务——
// handoff / 采集 / 读评论 / 互动 / 登录态校验。原来每类各开一条 SSE(EventSource),
// 但 dev 代理是 HTTP/1.1,同源并发连接上限 6;5 条常驻 SSE + 记忆面板等再占几条就撑爆,
// 结果【所有】SSE 都收不到事件(实测:加到第 5 条 login-check 时,连已验证的读评论都不再认领)。
// 定稿:daemon 侧合成一个 /desktop-jobs/events,把 5 条总线的事件打上 kind 标签并到一条流;
// web 侧只开【这一条】EventSource,按 kind 分派到各自的执行器。连接数 5→1,彻底躲开上限。
//
// 各执行器(executeXxx)仍是原文件里的那套逻辑(认领→在应用内标签跑→回写 daemon),这里只换
// 【事件入口】。只在桌面端挂载(host 桥不可用时空载)。
import { isOpenDesignHostBrowserAvailable } from '@open-design/host';
import { executeJob as executeHandoff } from './handoff-listener';
import { executeCollect } from './collect-listener';
import { executeRead } from './comment-read-listener';
import { executeInteraction } from './interaction-listener';
import { executeCheck } from './login-check-listener';
import { executeMyNotes } from './my-notes-listener';

const EVENTS_URL = '/api/media-studio/desktop-jobs/events';

/** 挂上桌面端派发任务的合流监听（桌面端专用；网页版返回空拆卸函数）。 */
export function startDesktopJobsListener(): () => void {
  if (!isOpenDesignHostBrowserAvailable()) return () => undefined;
  const es = new EventSource(EVENTS_URL);
  es.addEventListener('job', (ev) => {
    try {
      const { kind, job } = JSON.parse((ev as MessageEvent).data) as { kind?: string; job?: { id?: string } };
      if (!job?.id || !kind) return;
      switch (kind) {
        case 'handoff': void executeHandoff(job as never); break;
        case 'collect': void executeCollect(job as never); break;
        case 'comment-read': void executeRead(job as never); break;
        case 'interaction': void executeInteraction(job as never); break;
        case 'login-check': void executeCheck(job as never); break;
        case 'my-notes': void executeMyNotes(job as never); break;
        default: break; // 未知类型丢弃(向后兼容:daemon 新增类型时旧客户不炸)
      }
    } catch {
      /* 坏帧丢弃 */
    }
  });
  return () => es.close();
}
