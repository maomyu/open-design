// 读评论派发总线（读一条笔记的评论树 → 回结构化 CommentNode[]）。
//
// 与 collect-jobs / interaction-jobs 同构（内存 Map + TTL + 先到先得 claim + 无订阅者即失败）。
// 读操作不耗互动配额（配额只管写：评论/私信）。互动执行器「先读评论 → 关键词匹配 → 自动回复」
// 的读环节，也可 od studio read-comments 单独触发看评论。
import { randomUUID } from 'node:crypto';
import type {
  CommentNode,
  CreateStudioCommentReadRequest,
  StudioCommentReadJob,
  StudioCommentReadWaitResponse,
} from '@open-design/contracts';

const TERMINAL_TTL_MS = 10 * 60_000;
const STALE_TTL_MS = 30 * 60_000;

interface JobInternal {
  job: StudioCommentReadJob;
  waiters: Set<() => void>;
}

export type CommentReadListener = (job: StudioCommentReadJob) => void;

export class CommentReadError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

export interface CommentReadBus {
  subscriberCount(): number;
  subscribe(listener: CommentReadListener): () => void;
  create(req: CreateStudioCommentReadRequest): StudioCommentReadJob;
  claim(id: string): StudioCommentReadJob | null;
  progress(id: string, message: string): StudioCommentReadJob | null;
  setComments(id: string, comments: CommentNode[], needsLogin: boolean): StudioCommentReadJob | null;
  complete(id: string, ok: boolean, detail: string): StudioCommentReadJob | null;
  get(id: string): StudioCommentReadJob | null;
  wait(id: string, since: number, timeoutMs: number): Promise<StudioCommentReadWaitResponse | null>;
}

function snapshot(job: StudioCommentReadJob, since: number): StudioCommentReadWaitResponse {
  return {
    job: { ...job, progress: job.progress.slice(Math.max(0, since)) },
    cursor: job.progress.length,
  };
}

function isTerminal(job: StudioCommentReadJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createCommentReadBus(now: () => number = Date.now): CommentReadBus {
  const jobs = new Map<string, JobInternal>();
  const listeners = new Set<CommentReadListener>();

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
      for (const entry of jobs.values()) {
        if (entry.job.status === 'pending') listener({ ...entry.job });
      }
      return () => listeners.delete(listener);
    },
    create(req) {
      sweep();
      if (listeners.size === 0) {
        throw new CommentReadError(
          'desktop-offline',
          '桌面端未连接——读评论需要 social-auto 桌面应用在运行（登录态在桌面端浏览器标签里）。打开桌面应用后重试。',
        );
      }
      const t = now();
      const job: StudioCommentReadJob = {
        id: `cr-${randomUUID().slice(0, 12)}`,
        platform: req.platform,
        account: req.account ?? null,
        noteRef: req.noteRef,
        status: 'pending',
        progress: [],
        comments: [],
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
    setComments(id, comments, needsLogin) {
      const entry = jobs.get(id);
      if (!entry || isTerminal(entry.job)) return null;
      entry.job.comments = comments;
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
      entry.job.detail = detail;
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
