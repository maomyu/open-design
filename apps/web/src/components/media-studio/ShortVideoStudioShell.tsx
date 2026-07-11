// 「短视频」创作台外壳(2026-07-12 用户拍板:产品按平台组织,短视频台也要
// 平台在旁边切换,像文章台一样;将来每平台功能各自深度定制)。
//
// 第一步只立结构:平台切换器 + 各平台视图。数据不迁移——底层仍单池
// (platform='short-video'),按 extra.targetPlatform 把作品切成每平台的视图
// (ShortVideoStudioView 接 platform prop 过滤/建作/发布)。切平台=key 变=
// 重挂载,各平台独立当前作品(与文章台切平台同语义)。
//
// 授权 sv.* 的 per-pill 裁剪留到下个阶段(feature 位待接),本期 pills 全显示,
// 整个短视频台仍由 'short-video' 授权控制(见 EntryNavRail / EntryShell)。
import { useState } from 'react';
import type { SauPlatformId } from '@open-design/contracts';
import { ShortVideoStudioView } from './ShortVideoStudioView';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

// 与 ShortVideoStudioView 的 SAU_PLATFORMS 对齐(id 用于 handoff/发布,label
// 用于 targetPlatform 过滤)。
const SV_PLATFORMS: Array<{ id: SauPlatformId; label: string }> = [
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'kuaishou', label: '快手' },
  { id: 'bilibili', label: 'B站' },
  { id: 'tencent', label: '视频号' },
];
const STORE_KEY = 'open-design:studio:video-platform';

export function ShortVideoStudioShell(): JSX.Element {
  const [platform, setPlatform] = useState<SauPlatformId>(() => {
    const saved = window.localStorage.getItem(STORE_KEY);
    return SV_PLATFORMS.some((p) => p.id === saved) ? (saved as SauPlatformId) : 'douyin';
  });
  const pick = (id: SauPlatformId) => {
    setPlatform(id);
    window.localStorage.setItem(STORE_KEY, id);
  };
  return (
    <div className={c('articleShell')}>
      <div className={c('articleSwitch')}>
        <span className={c('articleSwitchLabel')}>短视频平台</span>
        {SV_PLATFORMS.map((p) => (
          <button
            key={p.id}
            type="button"
            className={`${c('articleSwitchBtn')}${p.id === platform ? ` ${c('articleSwitchBtnActive')}` : ''}`}
            aria-pressed={p.id === platform}
            onClick={() => pick(p.id)}
          >
            {p.label}
          </button>
        ))}
      </div>
      {/* key=平台:切平台重挂载,各平台独立当前作品/自动保存。 */}
      <ShortVideoStudioView key={platform} platform={platform} />
    </div>
  );
}
