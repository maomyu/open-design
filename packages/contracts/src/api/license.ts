// 功能授权契约（2026-07-11 用户拍板:同一产品按客户签发功能组合）。
//
// 两种发行形态共用同一验证端,只差「未授权功能」的渲染策略:
//  - custom(定制版,本期):未授权功能彻底不渲染——客户看不到没买的能力
//  - consumer(C 端,将来):全渲染,未订阅时锁定并引导开通(本期只留契约位)
//
// 铁律:无授权文件 = 全功能解锁(开发机/CI/e2e/存量安装零影响)。
// 到期语义:锁功能、留数据——写操作拒绝,读端点放行(数据永不绑架)。

/** 可授权的功能单元(2026-07-12 全面平台化:文章/短视频/笔记都按平台细分,
 *  客户常只买单平台)。cap.* 为横切能力项(知识库跟 cap.ai,不单列)。 */
export type FeatureId =
  // 文章平台
  | 'article.wechat-mp'
  | 'article.zhihu'
  | 'article.weibo'
  | 'article.baidu-zhidao'
  // 短视频平台
  | 'sv.douyin'
  | 'sv.kuaishou'
  | 'sv.shipinhao'
  | 'sv.bilibili'
  | 'sv.xiaohongshu'
  // 图文笔记平台
  | 'note.xiaohongshu'
  // 其它模块
  | 'integrations'
  // 知识库(2026-07-16 拆分:企业客户=企业知识库,个人自媒体=个人知识库,
  //  两套分类不同,按 license 分别渲染;都授权可同时显示)。
  | 'kb.personal'
  | 'kb.enterprise'
  // 横切能力
  | 'cap.ai'
  | 'cap.image'
  | 'cap.tts'
  | 'cap.video'
  | 'cap.handoff'
  | 'cap.publish'
  | 'cap.interaction';

export const ALL_FEATURE_IDS: readonly FeatureId[] = [
  'article.wechat-mp',
  'article.zhihu',
  'article.weibo',
  'article.baidu-zhidao',
  'sv.douyin',
  'sv.kuaishou',
  'sv.shipinhao',
  'sv.bilibili',
  'sv.xiaohongshu',
  'note.xiaohongshu',
  'integrations',
  'kb.personal',
  'kb.enterprise',
  'cap.ai',
  'cap.image',
  'cap.tts',
  'cap.video',
  'cap.handoff',
  'cap.publish',
  'cap.interaction',
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

/** 短视频大模块是否可用 = 任一短视频平台在授权内。 */
export function hasAnyShortVideoFeature(features: readonly FeatureId[]): boolean {
  return features.some((f) => f.startsWith('sv.'));
}

/** 知识库大模块是否可用 = 个人库或企业库任一在授权内。 */
export function hasAnyKnowledgeFeature(features: readonly FeatureId[]): boolean {
  return features.includes('kb.personal') || features.includes('kb.enterprise');
}

/** 「账号」导航是否出现 = 任一发布平台在授权内(有发布就要绑账号)。 */
export function hasAnyPublishingModule(features: readonly FeatureId[]): boolean {
  return (
    hasAnyArticleFeature(features)
    || hasAnyShortVideoFeature(features)
    || features.includes('note.xiaohongshu')
  );
}

/** 文章平台 id(wechat-mp/zhihu/weibo)→功能 id;非文章平台返回 null。 */
export function articleFeatureOf(platform: string): FeatureId | null {
  if (platform === 'wechat-mp') return 'article.wechat-mp';
  if (platform === 'zhihu') return 'article.zhihu';
  if (platform === 'weibo') return 'article.weibo';
  if (platform === 'baidu-zhidao') return 'article.baidu-zhidao';
  return null;
}

/** 短视频 SAU 平台 id(douyin/kuaishou/tencent/bilibili/xiaohongshu)→功能 id。
 *  注意 视频号 SAU id = tencent → sv.shipinhao。 */
export function svFeatureOf(sauPlatform: string): FeatureId | null {
  if (sauPlatform === 'douyin') return 'sv.douyin';
  if (sauPlatform === 'kuaishou') return 'sv.kuaishou';
  if (sauPlatform === 'tencent' || sauPlatform === 'shipinhao') return 'sv.shipinhao';
  if (sauPlatform === 'bilibili') return 'sv.bilibili';
  if (sauPlatform === 'xiaohongshu') return 'sv.xiaohongshu';
  return null;
}

/** 浏览器注入目标平台(handoff/发布 body.platform)→满足条件的功能集(anyOf:
 *  持有其一即放行)。小红书歧义(图文 note.xiaohongshu / 视频 sv.xiaohongshu)
 *  故返回两者。空数组 = 未知目标,放行。 */
export function handoffTargetFeatures(target: string): FeatureId[] {
  if (target === 'zhihu') return ['article.zhihu'];
  if (target === 'weibo') return ['article.weibo'];
  if (target === 'baidu-zhidao') return ['article.baidu-zhidao'];
  if (target === 'douyin') return ['sv.douyin'];
  if (target === 'kuaishou') return ['sv.kuaishou'];
  if (target === 'xiaohongshu') return ['note.xiaohongshu', 'sv.xiaohongshu'];
  return [];
}
