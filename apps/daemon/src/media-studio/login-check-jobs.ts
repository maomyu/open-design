// 登录态校验派发总线（W6:桌面端探测某 平台×账号 是否还登录着）。
//
// 登录态在 persist:od-browser-* 分区里(cookie vault,daemon 够不着),故必须桌面端探测:
// 心跳/手动触发建 job → SSE 派给桌面端 → 打开平台主站看登录标记 → 回 loggedIn → daemon 落状态。
// 与 comment-read/interaction 同构(内存 Map + TTL + 先到先得 claim + 无订阅者即失败)。
import { randomUUID } from 'node:crypto';
import type {
  CreateStudioLoginCheckRequest,
  StudioLoginCheckJob,
  StudioLoginCheckWaitResponse,
} from '@open-design/contracts';

const TERMINAL_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 15 * 60_000;

interface JobInternal {
  job: StudioLoginCheckJob;
  waiters: Set<() => void>;
}

export type LoginCheckListener = (job: StudioLoginCheckJob) => void;

export class LoginCheckError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

export interface LoginCheckBus {
  subscriberCount(): number;
  subscribe(listener: LoginCheckListener): () => void;
  create(req: CreateStudioLoginCheckRequest): StudioLoginCheckJob;
  claim(id: string): StudioLoginCheckJob | null;
  progress(id: string, message: string): StudioLoginCheckJob | null;
  setResult(id: string, loggedIn: boolean, detail: string): StudioLoginCheckJob | null;
  complete(id: string, ok: boolean, detail: string): StudioLoginCheckJob | null;
  get(id: string): StudioLoginCheckJob | null;
  wait(id: string, since: number, timeoutMs: number): Promise<StudioLoginCheckWaitResponse | null>;
}

function snapshot(job: StudioLoginCheckJob, since: number): StudioLoginCheckWaitResponse {
  return { job: { ...job, progress: job.progress.slice(Math.max(0, since)) }, cursor: job.progress.length };
}

function isTerminal(job: StudioLoginCheckJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createLoginCheckBus(now: () => number = Date.now): LoginCheckBus {
  const jobs = new Map<string, JobInternal>();
  const listeners = new Set<LoginCheckListener>();

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
  const touch = (entry: JobInternal) => {
    entry.job.updatedAt = now();
    for (const wake of [...entry.waiters]) wake();
  };

  return {
    subscriberCount: () => listeners.size,
    subscribe(listener) {
      listeners.add(listener);
      for (const entry of jobs.values()) if (entry.job.status === 'pending') listener({ ...entry.job });
      return () => listeners.delete(listener);
    },
    create(req) {
      sweep();
      if (listeners.size === 0) {
        throw new LoginCheckError('desktop-offline', '桌面端未连接——登录态校验需要 social-auto 桌面应用在运行。');
      }
      const t = now();
      const job: StudioLoginCheckJob = {
        id: `lc-${randomUUID().slice(0, 12)}`,
        platform: req.platform,
        account: req.account,
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
    setResult(id, loggedIn, detail) {
      const entry = jobs.get(id);
      if (!entry || isTerminal(entry.job)) return null;
      entry.job.loggedIn = loggedIn;
      entry.job.detail = detail;
      if (entry.job.status === 'claimed') entry.job.status = 'running';
      touch(entry);
      return { ...entry.job };
    },
    complete(id, ok, detail) {
      const entry = jobs.get(id);
      if (!entry) return null;
      if (isTerminal(entry.job)) return { ...entry.job };
      entry.job.status = ok ? 'done' : 'error';
      if (detail) entry.job.detail = detail;
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
      if (isTerminal(entry.job) || entry.job.progress.length > since) return snapshot(entry.job, since);
      await new Promise<void>((resolve) => {
        let settled = false;
        const wake = () => { if (settled) return; settled = true; entry.waiters.delete(wake); clearTimeout(timer); resolve(); };
        entry.waiters.add(wake);
        const timer = setTimeout(wake, Math.min(Math.max(timeoutMs, 0), 25_000));
      });
      return jobs.has(id) ? snapshot(jobs.get(id)!.job, since) : null;
    },
  };
}
