// 功能授权契约（2026-07-11 用户拍板:同一产品按客户签发功能组合）。
//
// 两种发行形态共用同一验证端,只差「未授权功能」的渲染策略:
//  - custom(定制版,本期):未授权功能彻底不渲染——客户看不到没买的能力
//  - consumer(C 端,将来):全渲染,未订阅时锁定并引导开通(本期只留契约位)
//
// 铁律:无授权文件 = 全功能解锁(开发机/CI/e2e/存量安装零影响)。
// 到期语义:锁功能、留数据——写操作拒绝,读端点放行(数据永不绑架)。

/** 可授权的功能单元。文章按平台细分(客户常只买单平台);短视频/笔记本期
 *  模块级(契约可扩展成平台级);cap.* 为横切能力项。 */
export type FeatureId =
  | 'article.wechat-mp'
  | 'article.zhihu'
  | 'article.weibo'
  | 'short-video'
  | 'note'
  | 'kb'
  | 'integrations'
  | 'cap.ai'
  | 'cap.image'
  | 'cap.tts'
  | 'cap.handoff'
  | 'cap.publish';

export const ALL_FEATURE_IDS: readonly FeatureId[] = [
  'article.wechat-mp',
  'article.zhihu',
  'article.weibo',
  'short-video',
  'note',
  'kb',
  'integrations',
  'cap.ai',
  'cap.image',
  'cap.tts',
  'cap.handoff',
  'cap.publish',
];

export function isFeatureId(v: unknown): v is FeatureId {
  return typeof v === 'string' && (ALL_FEATURE_IDS as readonly string[]).includes(v);
}

export interface LicensePayload {
  v: 1;
  edition: 'custom' | 'consumer';
  /** 客户名(展示用,如「翟总·中国维澳」)。 */
  customer: string;
  features: FeatureId[];
  /** ISO 日期串。 */
  issuedAt: string;
  /** ISO 日期串;过了这天进入「锁功能留数据」态。 */
  expiresAt: string;
}

/** 落盘的 license.json:payload 的 JSON 字符串被 Ed25519 私钥签名。 */
export interface LicenseFile {
  payload: LicensePayload;
  /** base64(ed25519 signature of JSON.stringify(payload))。 */
  signature: string;
}

/** GET /api/license 响应(绝不回签名本体)。none=无授权文件(全功能解锁)。 */
export interface LicenseStatusResponse {
  status: 'none' | 'valid' | 'expired' | 'invalid';
  edition?: 'custom' | 'consumer';
  customer?: string;
  features?: FeatureId[];
  expiresAt?: string;
  /** invalid 时的人话原因(签名不符/文件损坏/时钟异常)。 */
  reason?: string;
}

// ---- 派生规则(web/daemon 共用的纯函数) ----

/** 文章大模块是否可用 = 任一文章平台在授权内。 */
export function hasAnyArticleFeature(features: readonly FeatureId[]): boolean {
  return features.some((f) => f.startsWith('article.'));
}

/** 「账号」导航是否出现 = 任一发布模块在授权内(有发布就要绑账号)。 */
export function hasAnyPublishingModule(features: readonly FeatureId[]): boolean {
  return hasAnyArticleFeature(features) || features.includes('short-video') || features.includes('note');
}

/** 文章平台 id(wechat-mp/zhihu/weibo)→功能 id;非文章平台返回 null。 */
export function articleFeatureOf(platform: string): FeatureId | null {
  if (platform === 'wechat-mp') return 'article.wechat-mp';
  if (platform === 'zhihu') return 'article.zhihu';
  if (platform === 'weibo') return 'article.weibo';
  return null;
}

/** 创作台平台段(:platform)→所属模块功能 id;未知平台返回 null(放行,
 *  留给未来平台默认不锁死)。 */
export function moduleFeatureOfStudioPlatform(platform: string): FeatureId | null {
  const article = articleFeatureOf(platform);
  if (article) return article;
  if (platform === 'note') return 'note';
  if (platform === 'short-video') return 'short-video';
  return null;
}

/** 浏览器注入目标平台(handoff body.platform)→所属模块功能 id。 */
export function moduleFeatureOfHandoffTarget(target: string): FeatureId | null {
  if (target === 'zhihu') return 'article.zhihu';
  if (target === 'weibo') return 'article.weibo';
  if (target === 'xiaohongshu') return 'note';
  if (target === 'douyin' || target === 'kuaishou') return 'short-video';
  return null;
}
