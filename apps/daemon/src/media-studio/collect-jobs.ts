// 内置浏览器采集的派发总线（爆款雷达 · 2026-07-12）。
//
// 为什么存在：爆款雷达要用【应用内标签 webview】抓各平台真实爆款（登录态在
// persist:od-browser-* 分区里，daemon 够不着；且用户要求不弹独立窗口）。CLI/引擎
// 无法直接驱动桌面端 webview，这里提供一条 daemon 内存总线：
//
//   引擎/CLI POST /collect 建 job → SSE 广播给桌面端 web → web claim 认领 →
//   在应用内标签打开搜索页 executeJavaScript 抓 → progress 回写 → result 回传条目 →
//   complete 终态 → 调用方 wait 长轮询取增量。
//
// 与 handoff-jobs 同构（内存 Map + TTL + 先到先得 claim + 无订阅者即失败），
// 差别是 job 携带 keyword/platforms 且 result 回传采集条目。
import { randomUUID } from 'node:crypto';
import type {
  CreateStudioCollectRequest,
  StudioCollectJob,
  StudioCollectOrder,
  StudioCollectPlatform,
  StudioCollectPlatformResult,
  StudioCollectWaitResponse,
} from '@open-design/contracts';

export const COLLECT_PLATFORMS: readonly StudioCollectPlatform[] = [
  'xiaohongshu',
  'douyin',
  'bilibili',
  'kuaishou',
];

export function isCollectPlatform(v: unknown): v is StudioCollectPlatform {
  return typeof v === 'string' && (COLLECT_PLATFORMS as readonly string[]).includes(v);
}

const TERMINAL_TTL_MS = 10 * 60_000;
const STALE_TTL_MS = 30 * 60_000;

interface CollectJobInternal {
  job: StudioCollectJob;
  waiters: Set<() => void>;
}

export type CollectListener = (job: StudioCollectJob) => void;

export class CollectError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

export interface CollectBus {
  subscriberCount(): number;
  subscribe(listener: CollectListener): () => void;
  create(req: Required<Pick<CreateStudioCollectRequest, 'keyword'>> & {
    platforms: StudioCollectPlatform[];
    scrolls: number;
    per: number;
    order: StudioCollectOrder;
    timeWindow: string;
    pages: number;
  }): StudioCollectJob;
  claim(id: string): StudioCollectJob | null;
  progress(id: string, message: string): StudioCollectJob | null;
  /** 追加某平台采集结果（不改状态；complete 才落终态）。 */
  addResult(id: string, results: StudioCollectPlatformResult[]): StudioCollectJob | null;
  complete(id: string, ok: boolean, detail: string): StudioCollectJob | null;
  get(id: string): StudioCollectJob | null;
  wait(id: string, since: number, timeoutMs: number): Promise<StudioCollectWaitResponse | null>;
}

function snapshot(job: StudioCollectJob, since: number): StudioCollectWaitResponse {
  return {
    job: { ...job, progress: job.progress.slice(Math.max(0, since)) },
    cursor: job.progress.length,
  };
}

function isTerminal(job: StudioCollectJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createCollectBus(now: () => number = Date.now): CollectBus {
  const jobs = new Map<string, CollectJobInternal>();
  const listeners = new Set<CollectListener>();

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

  const touch = (entry: CollectJobInternal) => {
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
        throw new CollectError(
          'desktop-offline',
          '桌面端未连接——内置浏览器采集需要 爆创 桌面应用在运行（登录态在桌面端浏览器标签里）。打开桌面应用后重试。',
        );
      }
      const t = now();
      const job: StudioCollectJob = {
        id: `cj-${randomUUID().slice(0, 12)}`,
        keyword: req.keyword,
        platforms: req.platforms,
        scrolls: req.scrolls,
        per: req.per,
        order: req.order,
        timeWindow: req.timeWindow,
        pages: req.pages,
        status: 'pending',
        progress: [],
        results: [],
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
    addResult(id, results) {
      const entry = jobs.get(id);
      if (!entry || isTerminal(entry.job)) return null;
      entry.job.results.push(...results);
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
