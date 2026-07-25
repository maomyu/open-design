// 风控冻结台账（内存，当天有效）——自动评论直发的「确认撞风控就整批停」安全闸。
//
// 不变式:某 平台×账号 一旦【确认】触发平台风控(派发器已暂停等过用户人工处理验证、重试仍被拦,
// 或等了 10 分钟没人处理),当天【冻结自动直发】。之后该账号的每一条外发(包括还在管道里、别的
// 笔记刚排队的)派发前都查这张表,冻着就整批停——风控后继续猛发只会加速封号,所以宁可整批停也
// 绝不再自动发。解冻只有三条路:本地当天结束(次日 0 点)自动解冻、daemon 重启清空(重启=用户
// 主动介入)、用户人工完成平台验证后手动 unfreeze(「验证完成」没有可靠的自动信号,交还给人)。
//
// 纯内存 + 纯函数,便于单测锁死这条安全语义(见 tests/interaction-freeze.test.ts)。

/** 给定时刻所在【本地当天】的结束时间戳(次日 0 点,ms)。tzMin=时区相对 UTC 的分钟偏移(默认 +8=480)。 */
export function endOfLocalDay(now: number, tzMin = 480): number {
  const dayMs = 86_400_000;
  return (Math.floor((now + tzMin * 60_000) / dayMs) + 1) * dayMs - tzMin * 60_000;
}

export interface AutoSendFreeze {
  /** 该 平台×账号 当天是否处于风控冻结中(到期自动解冻)。 */
  isFrozen(platform: string, account: string | null, now?: number): boolean;
  /** 触发风控:冻结该 平台×账号 的自动直发到本地当天结束。 */
  freeze(platform: string, account: string | null, now?: number): void;
  /** 手动解冻:用户已人工完成平台验证后,立即恢复该 平台×账号 的自动直发资格。 */
  unfreeze(platform: string, account: string | null): void;
}

/** 建一张风控冻结台账(内存)。tzMin 决定「当天」按哪个时区切(默认 +8)。 */
export function createAutoSendFreeze(tzMin = 480): AutoSendFreeze {
  const until = new Map<string, number>(); // key=platform|account → 解冻时间戳(ms)
  const key = (platform: string, account: string | null): string => `${platform}|${account ?? ''}`;
  return {
    isFrozen(platform, account, now = Date.now()) {
      const t = until.get(key(platform, account));
      if (t === undefined) return false;
      if (t <= now) { until.delete(key(platform, account)); return false; } // 到期:解冻并清掉
      return true;
    },
    freeze(platform, account, now = Date.now()) {
      until.set(key(platform, account), endOfLocalDay(now, tzMin));
    },
    unfreeze(platform, account) {
      until.delete(key(platform, account));
    },
  };
}
