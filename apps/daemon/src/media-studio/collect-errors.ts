/**
 * Turning a dead data source into a sentence the user can act on.
 *
 * The 抓爆款 pipeline reports each platform's collection failure as
 * `{ platform, status, reason }`. Without this translation the route
 * would hand the UI a bare `count: 0`, which is indistinguishable from
 * "this keyword genuinely has no hits" — and that ambiguity has real
 * cost: on a customer machine (2026-07-26) the TikHub token had expired,
 * every request came back 401, and the app quietly showed an empty list
 * for days while the customer assumed their keywords were bad.
 */

export type CollectError = {
  platform?: unknown;
  status?: unknown;
  reason?: unknown;
};

const PLATFORM_LABELS: Record<string, string> = {
  douyin: '抖音',
  xiaohongshu: '小红书',
  bilibili: 'B站',
  kuaishou: '快手',
  channels: '视频号',
};

/** Which upstream a platform's 爆款 data actually comes from. */
function sourceOf(platform: string): { name: string; keyLabel: string } {
  return platform === 'channels'
    ? { name: '极致数据(dajiala)', keyLabel: '极致数据 key' }
    : { name: 'TikHub', keyLabel: 'TikHub API Key' };
}

function labelFor(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}

/**
 * A user-facing explanation for why collection came back empty, or null
 * when nothing failed (i.e. the keyword really had no qualifying hits and
 * the caller should keep reporting "0 条" as-is).
 *
 * Status codes are translated rather than echoed: the customer cannot do
 * anything with "HTTP 401", but "令牌无效或已过期，去设置里更新" is a
 * complete instruction.
 */
export function describeCollectFailure(errors: unknown): string | null {
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const parsed = errors
    .filter((e): e is CollectError => Boolean(e) && typeof e === 'object')
    .map((e) => ({
      platform: String(e.platform ?? '').trim(),
      status: typeof e.status === 'number' ? e.status : null,
      reason: String(e.reason ?? '').trim(),
    }));
  if (parsed.length === 0) return null;

  const platforms = [...new Set(parsed.map((e) => labelFor(e.platform)).filter(Boolean))];
  const scope = platforms.length > 0 ? platforms.join('、') : '数据源';
  const { name: source, keyLabel } = sourceOf(parsed[0]?.platform ?? '');
  const status = parsed.find((e) => e.status !== null)?.status ?? null;

  switch (status) {
    case 401:
    case 403:
      return `${scope}采集失败：${source} 返回 ${status}，令牌无效或已过期——到「设置 → 接口与密钥」更新${keyLabel}后重试。这不是"没有爆款"，是数据源没放行。`;
    case 402:
      return `${scope}采集失败：${source} 返回 402，账户余额或套餐额度已用尽——去 ${source} 充值/续费后重试。`;
    case 429:
      return `${scope}采集失败：${source} 返回 429，请求过于频繁被限流——等几分钟再试；持续出现说明套餐并发不够。`;
    default:
      break;
  }
  if (status !== null && status >= 500) {
    return `${scope}采集失败：${source} 服务端返回 ${status}，是对方接口在抖动——稍后重试即可，不用改配置。`;
  }
  const detail = parsed.find((e) => e.reason)?.reason ?? '未知错误';
  return `${scope}采集失败：${detail}（数据源 ${source}）。这不是"没有爆款"——请检查网络与${keyLabel}后重试。`;
}
