// 浏览器注入发布的派发总线（2026-07-10 全功能 CLI 化）。
//
// 为什么存在:知乎/微博/小红书/抖音/快手的「一键填稿/一键发布」跑在桌面端
// webview 里(登录态在 persist:od-browser-* 分区,daemon 够不着),CLI 无法
// 直接执行注入。这里提供一条 daemon 内存总线:
//
//   CLI POST /handoff 建 job → SSE 广播给桌面端 web → web claim 认领 →
//   注入进度 progress 回写 → complete 终态 → CLI wait 长轮询取增量。
//
// 设计取舍:
//  - job 只是「派发态」,存内存 Map + TTL,不落 SQLite(发布结果本就有
//    publishes/mark-published 落库)。daemon 重启丢 job 是可接受语义——
//    注入本身也随桌面端一起没了。
//  - 无订阅者(桌面端没开)时 create 直接失败,让 CLI 立即拿到可行动的报错,
//    而不是挂一个永远没人认领的 job。
//  - 多桌面窗口同时订阅时靠 claim 先到先得防双跑。
import { randomUUID } from 'node:crypto';
import type {
  CreateStudioHandoffRequest,
  StudioHandoffJob,
  StudioHandoffPlatform,
  StudioHandoffWaitResponse,
} from '@open-design/contracts';

export const HANDOFF_PLATFORMS: readonly StudioHandoffPlatform[] = [
  'zhihu',
  'weibo',
  'xiaohongshu',
  'douyin',
  'kuaishou',
];

export function isHandoffPlatform(v: unknown): v is StudioHandoffPlatform {
  return typeof v === 'string' && (HANDOFF_PLATFORMS as readonly string[]).includes(v);
}

/** 终态 job 的保留时长(过期 sweep 掉,避免内存无限涨)。 */
const TERMINAL_TTL_MS = 10 * 60_000;
/** 非终态 job 的兜底保留时长(桌面端认领后崩溃等极端情形)。 */
const STALE_TTL_MS = 30 * 60_000;

interface HandoffJobInternal {
  job: StudioHandoffJob;
  waiters: Set<() => void>;
}

export type HandoffListener = (job: StudioHandoffJob) => void;

export interface HandoffBus {
  /** 当前 SSE 订阅者数(=已连接的桌面端窗口数)。 */
  subscriberCount(): number;
  /** 订阅新 job 广播;返回退订函数。订阅瞬间会补发所有 pending job。 */
  subscribe(listener: HandoffListener): () => void;
  /** 建 job 并广播。无订阅者时抛 HandoffError(desktop-offline)。 */
  create(req: Required<Pick<CreateStudioHandoffRequest, 'platform' | 'articleId'>> & {
    articlePlatform: string;
    account?: string;
    autoPublish?: boolean;
  }): StudioHandoffJob;
  /** 认领:pending→claimed。已被认领/不存在返回 null(调用方回 409/404)。 */
  claim(id: string): StudioHandoffJob | null;
  /** 追加一行进度(claimed→running),唤醒 wait 长轮询。 */
  progress(id: string, message: string): StudioHandoffJob | null;
  /** 终态:done/error。幂等——已终态的 job 忽略后续 complete。 */
  complete(id: string, ok: boolean, detail: string): StudioHandoffJob | null;
  get(id: string): StudioHandoffJob | null;
  /** wait 长轮询:since 之后有增量/已终态立即返回,否则挂到 timeoutMs。 */
  wait(id: string, since: number, timeoutMs: number): Promise<StudioHandoffWaitResponse | null>;
}

export class HandoffError extends Error {
  constructor(readonly code: 'desktop-offline', message: string) {
    super(message);
  }
}

function snapshot(job: StudioHandoffJob, since: number): StudioHandoffWaitResponse {
  return {
    job: { ...job, progress: job.progress.slice(Math.max(0, since)) },
    cursor: job.progress.length,
  };
}

function isTerminal(job: StudioHandoffJob): boolean {
  return job.status === 'done' || job.status === 'error';
}

export function createHandoffBus(now: () => number = Date.now): HandoffBus {
  const jobs = new Map<string, HandoffJobInternal>();
  const listeners = new Set<HandoffListener>();

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

  const touch = (entry: HandoffJobInternal) => {
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
        throw new HandoffError(
          'desktop-offline',
          '桌面端未连接——浏览器注入发布需要 social-auto 桌面应用在运行(登录态在桌面端浏览器分区里)。打开桌面应用后重试。',
        );
      }
      const t = now();
      const job: StudioHandoffJob = {
        id: `hj-${randomUUID().slice(0, 12)}`,
        platform: req.platform,
        articleId: req.articleId,
        articlePlatform: req.articlePlatform,
        ...(req.account ? { account: req.account } : {}),
        autoPublish: req.autoPublish === true,
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
      // job 可能已被 sweep 掉(极端 TTL 情形)——按已消失处理。
      return jobs.has(id) ? snapshot(jobs.get(id)!.job, since) : null;
    },
  };
}
