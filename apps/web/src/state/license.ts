// 功能授权的 web 侧状态(2026-07-11 定制版机制)。
//
// daemon 是唯一强制点(未授权 API 直接 403);这里只负责「体验层裁剪」:
// 未授权的导航/平台/能力不渲染——客户看不到没买的东西。
//
// 铁律:拿不到授权信息(status none / 请求失败)一律当全功能,绝不因为
// 网络抖动把界面裁没了。
import { createContext, useContext } from 'react';
import {
  hasAnyArticleFeature,
  hasAnyKnowledgeFeature,
  hasAnyPublishingModule,
  hasAnyShortVideoFeature,
  svFeatureOf,
  type FeatureId,
  type LicenseStatusResponse,
} from '@open-design/contracts';

export interface LicenseInfo {
  status: LicenseStatusResponse['status'];
  customer?: string;
  edition?: string;
  expiresAt?: string;
  reason?: string;
  /** null = 全功能(无授权文件/加载失败)。 */
  features: Set<FeatureId> | null;
}

export const UNLOCKED_LICENSE: LicenseInfo = { status: 'none', features: null };

export async function fetchLicenseInfo(): Promise<LicenseInfo> {
  try {
    const resp = await fetch('/api/license');
    if (!resp.ok) return UNLOCKED_LICENSE;
    const data = (await resp.json()) as LicenseStatusResponse;
    if (data.status === 'none') return UNLOCKED_LICENSE;
    return {
      status: data.status,
      customer: data.customer,
      edition: data.edition,
      expiresAt: data.expiresAt,
      reason: data.reason,
      // invalid(签名坏/时钟异常)按最严:功能集为空——界面裁到只剩数据查看,
      // 与 daemon 的「invalid 锁写」一致。expired 保留功能集(界面正常显示,
      // 顶部横幅提示 + 写操作被 daemon 拦)。
      features: data.status === 'invalid' ? new Set() : new Set(data.features ?? []),
    };
  } catch {
    return UNLOCKED_LICENSE;
  }
}

export function hasFeature(license: LicenseInfo, id: FeatureId): boolean {
  return license.features === null || license.features.has(id);
}

export function anyArticlePlatform(license: LicenseInfo): boolean {
  return license.features === null || hasAnyArticleFeature([...license.features]);
}

export function anyShortVideoPlatform(license: LicenseInfo): boolean {
  return license.features === null || hasAnyShortVideoFeature([...license.features]);
}

export function anyPublishingModule(license: LicenseInfo): boolean {
  return license.features === null || hasAnyPublishingModule([...license.features]);
}

/** 某个短视频 SAU 平台(douyin/tencent/…)是否在授权内(短视频台 pills 裁剪用)。 */
export function hasShortVideoPlatform(license: LicenseInfo, sauId: string): boolean {
  if (license.features === null) return true;
  const feat = svFeatureOf(sauId);
  return feat ? license.features.has(feat) : true;
}

/** 入口视图是否在授权内(导航裁剪与视图重定向共用一份判定)。 */
export function isViewLicensed(view: string, license: LicenseInfo): boolean {
  if (license.features === null) return true;
  switch (view) {
    case 'studio':
    case 'studio-zhihu':
    case 'studio-weibo':
      return anyArticlePlatform(license);
    case 'studio-create':
      // 统一创作台:短视频任一平台 或 小红书图文授权即可进。
      return anyShortVideoPlatform(license) || hasFeature(license, 'note.xiaohongshu');
    case 'studio-video':
      return anyShortVideoPlatform(license);
    case 'studio-note':
      return hasFeature(license, 'note.xiaohongshu');
    case 'interaction':
      return hasFeature(license, 'cap.interaction');
    case 'knowledge':
      return hasAnyKnowledgeFeature([...license.features]); // 个人库或企业库任一在授权内

    case 'accounts':
      return anyPublishingModule(license);
    case 'integrations':
      return hasFeature(license, 'integrations');
    default:
      return true; // 其余视图(home/设置类)不受套餐控制
  }
}

const VIEW_FALLBACK_ORDER = ['studio-create', 'studio', 'studio-video', 'studio-note', 'interaction', 'knowledge', 'accounts', 'integrations'];

/** 未授权视图(直链/旧标签)落到第一个已授权模块。 */
export function licensedViewOrFallback<T extends string>(view: T, license: LicenseInfo): T {
  if (isViewLicensed(view, license)) return view;
  const fallback = VIEW_FALLBACK_ORDER.find((v) => isViewLicensed(v, license));
  return (fallback ?? view) as T;
}

export const LicenseContext = createContext<LicenseInfo>(UNLOCKED_LICENSE);

export function useLicense(): LicenseInfo {
  return useContext(LicenseContext);
}
