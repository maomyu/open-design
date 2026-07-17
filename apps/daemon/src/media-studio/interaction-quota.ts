/**
 * 互动风控台账 —— 纯决策层（无 DB、无副作用）。
 *
 * 合同「操作限流 / 养号节奏」的底座。真人行为模拟（拟人打字、坐标点击、换气停顿）复用现成的
 * webview 工具箱，属 intra-action；这里管 **inter-action**：一个账号一天能发多少、两次动作间的
 * 最小间隔、静默时段。决策是纯函数（给定配额行 + 策略 + 当前时刻 → 放行/拦截），DB 事务里的
 * 原子认领在 store.ts（`claimInteractionSlot`）调用它，保证「查—判—记」不被并发穿透。
 *
 * 时区：默认按客户所在的 UTC+8（中国）划天与判静默时段，deterministic —— 只依赖传入的 `now`。
 */

/** 每账号互动限流策略。 */
export interface InteractionPolicy {
  /** 单账号单日互动上限（评论+楼中楼+私信合计）。 */
  dailyCap: number;
  /** 两次互动之间的最小间隔（毫秒）——养号节奏的地板；实际抖动的更长间隔由执行器叠加。 */
  cooldownMs: number;
  /** 静默时段（本地整点，半开区间 [start, end)，支持跨零点如 {start:1,end:7}）。null=不设。 */
  quietHours?: { start: number; end: number } | null;
  /** 划天与静默判定用的时区偏移（分钟），默认 +480 = UTC+8。 */
  tzOffsetMinutes?: number;
}

export const DEFAULT_INTERACTION_POLICY: InteractionPolicy = {
  dailyCap: 50,
  cooldownMs: 30_000,
  quietHours: null,
  tzOffsetMinutes: 480,
};

export type QuotaBlockReason = 'daily-cap' | 'cooldown' | 'quiet-hours';

export interface QuotaDecision {
  allowed: boolean;
  reason?: QuotaBlockReason;
  /** 冷却拦截时：还需等待的毫秒数（供执行器排程或前端提示）。 */
  retryAfterMs?: number;
  /** 当日已用次数（含本次判定前的既有计数）。 */
  usedToday: number;
  dailyCap: number;
}

/** 配额行的最小快照（store 从 media_interaction_quota 读出后喂给纯决策）。 */
export interface QuotaState {
  /** 该 count 归属的「天序号」(epoch-day，按 tz 偏移)。 */
  day: number;
  count: number;
  lastActionAt: number;
}

const MS_PER_DAY = 86_400_000;

/** 当前时刻属于哪一「天」（按 tz 偏移的 epoch-day 整数，deterministic）。 */
export function dayKey(now: number, tzOffsetMinutes = 480): number {
  return Math.floor((now + tzOffsetMinutes * 60_000) / MS_PER_DAY);
}

/** 当前时刻的本地整点小时 [0,23]（按 tz 偏移）。 */
export function localHour(now: number, tzOffsetMinutes = 480): number {
  const msIntoDay = ((now + tzOffsetMinutes * 60_000) % MS_PER_DAY + MS_PER_DAY) % MS_PER_DAY;
  return Math.floor(msIntoDay / 3_600_000);
}

/** 小时是否落在静默区间（支持跨零点：start>end 时表示夜间跨天段）。 */
export function inQuietHours(hour: number, quiet: { start: number; end: number } | null | undefined): boolean {
  if (!quiet) return false;
  const { start, end } = quiet;
  if (start === end) return false; // 空区间
  if (start < end) return hour >= start && hour < end;
  return hour >= start || hour < end; // 跨零点，如 22:00–06:00
}

/**
 * 纯决策：给定当前配额状态、策略、当前时刻，判定这次互动能否放行。
 * 不改任何状态；放行与否都由调用方在事务里落库（放行则 bump 计数/时间）。
 */
export function decideQuota(
  state: QuotaState | null,
  policy: InteractionPolicy,
  now: number,
): QuotaDecision {
  const tz = policy.tzOffsetMinutes ?? 480;
  const today = dayKey(now, tz);
  // 跨天则当日计数归零（旧行的 count 属于昨天，不计入今天）。
  const usedToday = state && state.day === today ? state.count : 0;
  const lastActionAt = state ? state.lastActionAt : 0;

  // ① 静默时段：最高优先级，直接拦。
  if (inQuietHours(localHour(now, tz), policy.quietHours ?? null)) {
    return { allowed: false, reason: 'quiet-hours', usedToday, dailyCap: policy.dailyCap };
  }
  // ② 单日上限。
  if (usedToday >= policy.dailyCap) {
    return { allowed: false, reason: 'daily-cap', usedToday, dailyCap: policy.dailyCap };
  }
  // ③ 冷却窗：距上次动作不足 cooldownMs 则拦，并回传还需等待时长。
  const sinceLast = now - lastActionAt;
  if (lastActionAt > 0 && sinceLast < policy.cooldownMs) {
    return {
      allowed: false,
      reason: 'cooldown',
      retryAfterMs: policy.cooldownMs - sinceLast,
      usedToday,
      dailyCap: policy.dailyCap,
    };
  }
  return { allowed: true, usedToday, dailyCap: policy.dailyCap };
}
