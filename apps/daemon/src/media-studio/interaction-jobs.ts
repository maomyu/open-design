// 互动执行的派发总线（自动评论/楼中楼/私信 · 阶段一 W2）。
//
// 为什么存在：互动动作要在【应用内标签 webview】里执行（登录态在 persist:od-browser-* 分区，
// daemon 够不着；且要拟人操作真实页面）。CLI/routine 无法直接驱动桌面端 webview，这里提供
// 一条 daemon 内存总线：
//
//   CLI/routine POST /interaction（先过风控台账，放行才建 job）→ SSE 广播给桌面端 web →
//   web claim 认领 → 打开目标页拟人回复/私信 → progress 回写 → complete 终态 →
//   调用方 wait 长轮询取增量。
//
// 与 handoff-jobs / collect-jobs 同构（内存 Map + TTL + 先到先得 claim + 无订阅者即失败）。
// 差别：job 携带单平台+账号+动作+目标引用+文本；无 results 数组，只有进度与终态。
// 风控门控（限流/冷却/静默）在路由层建 job 之前用 claimInteractionSlot 完成，被拦的动作
// 根本不进总线；本文件只管派发与生命周期，不认识配额。
import { randomUUID } from 'node:crypto';
import type {
  CreateStudioInteractionRequest,
  StudioInteractionJob,
  StudioInteractionTerminalReason,
  StudioInteractionWaitResponse,
} from '@open-design/contracts';

const TERMINAL_TTL_MS = 10 * 60_000;
const STALE_TTL_MS = 30 * 60_000;

interface InteractionJobInternal {
  job: StudioInteractionJob;
  waiters: Set<() => void>;
}

export type InteractionListener = (job: StudioInteractionJob) => void;

export class InteractionError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

export interface InteractionBus {
  subscriberCount(): number;
  subscribe(listener: InteractionListener): () => void;
  create(req: CreateStudioInteractionRequest): StudioInteractionJob;
  claim(id: string): StudioInteractionJob | null;
  progress(id: string, message: string): StudioInteractionJob | null;
  complete(id: string, ok: boolean, detail: string, reason?: StudioInteractionTerminalReason): StudioInteractionJob | null;
  get(id: string): StudioInteractionJob | null;
  wait(id: string, since: number, timeoutMs: number): Promise<StudioInteractionWaitResponse | null>;
}

function snapshot(job: StudioInteractionJob, since: number): StudioInteractionWaitResponse {
  return {
    job: { ...job, progress: job.progress.slice(Math.max(0, since)) },
    cursor: job.progress.length,
  };
}

function isTerminal(job: StudioInteractionJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createInteractionBus(now: () => number = Date.now): InteractionBus {
  const jobs = new Map<string, InteractionJobInternal>();
  const listeners = new Set<InteractionListener>();

  const sweep = () => {
    const t = now();
    for (const [id, entry] of jobs) {
      const age = t - entry.job.updatedAt;
      if ((isTerminal(entry.job) && age > TERMINAL_TTL_MS) || age > STALE_TTL_MS) {
        for (const wake of entry.waiters) wake();
        jobs.delete(id);
      }
    }
  };

  const touch = (entry: InteractionJobInternal) => {
    entry.job.updatedAt = now();
    for (const wake of [...entry.waiters]) wake();
  };

  return {
    subscriberCount: () => listeners.size,
    subscribe(listener) {
      listeners.add(listener);
      for (const entry of jobs.values()) {
        if (entry.job.status === 'pending') listener({ ...entry.job });
      }
      return () => listeners.delete(listener);
    },
    create(req) {
      sweep();
      if (listeners.size === 0) {
        throw new InteractionError(
          'desktop-offline',
          '桌面端未连接——自动互动需要 social-auto 桌面应用在运行（登录态在桌面端浏览器标签里）。打开桌面应用后重试。',
        );
      }
      const t = now();
      const job: StudioInteractionJob = {
        id: `ix-${randomUUID().slice(0, 12)}`,
        platform: req.platform,
        account: req.account ?? null,
        action: req.action,
        targetRef: req.targetRef,
        ...(req.noteRef ? { noteRef: req.noteRef } : {}),
        ...(req.authorName ? { authorName: req.authorName } : {}),
        text: req.text,
        status: 'pending',
        progress: [],
        createdAt: t,
        updatedAt: t,
      };
      jobs.set(job.id, { job, waiters: new Set() });
      for (const listener of [...listeners]) listener({ ...job });
      return { ...job };
    },
    claim(id) {
      const entry = jobs.get(id);
      if (!entry || entry.job.status !== 'pending') return null;
      entry.job.status = 'claimed';
      touch(entry);
      return { ...entry.job };
    },
    progress(id, message) {
      const entry = jobs.get(id);
      if (!entry || isTerminal(entry.job)) return null;
      entry.job.progress.push(message);
      if (entry.job.status === 'claimed') entry.job.status = 'running';
      touch(entry);
      return { ...entry.job };
    },
    complete(id, ok, detail, reason) {
      const entry = jobs.get(id);
      if (!entry) return null;
      if (isTerminal(entry.job)) return { ...entry.job };
      entry.job.status = ok ? 'done' : 'error';
      entry.job.detail = detail;
      // 结构原因码(needs-login/risk-control):编排层据此暂停等登录、或触发风控整批停——
      // 不靠解析 detail 文本。只有 error 终态才带(成功不需要原因)。
      if (!ok && reason) entry.job.reason = reason;
      touch(entry);
      return { ...entry.job };
    },
    get(id) {
      const entry = jobs.get(id);
      return entry ? { ...entry.job } : null;
    },
    async wait(id, since, timeoutMs) {
      const entry = jobs.get(id);
      if (!entry) return null;
      if (isTerminal(entry.job) || entry.job.progress.length > since) {
        return snapshot(entry.job, since);
      }
      await new Promise<void>((resolve) => {
        let settled = false;
        const wake = () => {
          if (settled) return;
          settled = true;
          entry.waiters.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        entry.waiters.add(wake);
        const timer = setTimeout(wake, Math.min(Math.max(timeoutMs, 0), 25_000));
      });
      return jobs.has(id) ? snapshot(jobs.get(id)!.job, since) : null;
    },
  };
}
