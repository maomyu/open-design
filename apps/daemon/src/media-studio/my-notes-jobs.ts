// 「我的笔记」抓取派发总线(桌面端读某账号主页的已发笔记,给互动回复当笔记选择器)。
//
// 笔记列表在登录分区里(要登录态才看得全、链接才带 xsec_token),daemon 够不着,必须桌面端抓:
// UI 点「我的笔记」建 job → SSE 派给桌面端 → 打开该账号主页抓笔记卡(标题+带 token 链接)→ 回写。
// 与 comment-read / login-check 同构(内存 Map + TTL + 先到先得 claim + 无订阅者即失败)。
import { randomUUID } from 'node:crypto';
import type {
  CreateStudioMyNotesRequest,
  StudioMyNotesJob,
  StudioMyNotesWaitResponse,
  StudioNoteCard,
} from '@open-design/contracts';

const TERMINAL_TTL_MS = 5 * 60_000;
const STALE_TTL_MS = 15 * 60_000;

interface JobInternal {
  job: StudioMyNotesJob;
  waiters: Set<() => void>;
}

export type MyNotesListener = (job: StudioMyNotesJob) => void;

export class MyNotesError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

export interface MyNotesBus {
  subscriberCount(): number;
  subscribe(listener: MyNotesListener): () => void;
  create(req: CreateStudioMyNotesRequest): StudioMyNotesJob;
  claim(id: string): StudioMyNotesJob | null;
  progress(id: string, message: string): StudioMyNotesJob | null;
  setResult(id: string, notes: StudioNoteCard[], needsLogin: boolean): StudioMyNotesJob | null;
  complete(id: string, ok: boolean, detail: string): StudioMyNotesJob | null;
  get(id: string): StudioMyNotesJob | null;
  wait(id: string, since: number, timeoutMs: number): Promise<StudioMyNotesWaitResponse | null>;
}

function snapshot(job: StudioMyNotesJob, since: number): StudioMyNotesWaitResponse {
  return { job: { ...job, progress: job.progress.slice(Math.max(0, since)) }, cursor: job.progress.length };
}

function isTerminal(job: StudioMyNotesJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createMyNotesBus(now: () => number = Date.now): MyNotesBus {
  const jobs = new Map<string, JobInternal>();
  const listeners = new Set<MyNotesListener>();

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
        throw new MyNotesError('desktop-offline', '桌面端未连接——抓「我的笔记」需要 social-auto 桌面应用在运行。');
      }
      const t = now();
      const job: StudioMyNotesJob = {
        id: `mn-${randomUUID().slice(0, 12)}`,
        platform: req.platform,
        account: req.account ?? null,
        status: 'pending',
        progress: [],
        notes: [],
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
    setResult(id, notes, needsLogin) {
      const entry = jobs.get(id);
      if (!entry || isTerminal(entry.job)) return null;
      entry.job.notes = notes;
      entry.job.needsLogin = needsLogin;
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
