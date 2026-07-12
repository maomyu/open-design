// 「短视频」创作台外壳(2026-07-12 用户拍板:产品按平台组织,短视频台也要
// 平台在旁边切换,像文章台一样;将来每平台功能各自深度定制)。
//
// 第一步只立结构:平台切换器 + 各平台视图。数据不迁移——底层仍单池
// (platform='short-video'),按 extra.targetPlatform 把作品切成每平台的视图
// (ShortVideoStudioView 接 platform prop 过滤/建作/发布)。切平台=key 变=
// 重挂载,各平台独立当前作品(与文章台切平台同语义)。
//
// 授权裁剪(2026-07-12):未购买的短视频平台 pill 不渲染(每平台一个 sv.*);
// 无授权文件=全平台显示。整台是否出现由「任一 sv.*」决定(见 EntryNavRail)。
import { useState } from 'react';
import type { SauPlatformId } from '@open-design/contracts';
import { ShortVideoStudioView } from './ShortVideoStudioView';
import { hasShortVideoPlatform, useLicense } from '../../state/license';
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
  const license = useLicense();
  const licensed = SV_PLATFORMS.filter((p) => hasShortVideoPlatform(license, p.id));
  const allowed = (id: string | null | undefined): id is SauPlatformId =>
    licensed.some((p) => p.id === id);
  const [platform, setPlatform] = useState<SauPlatformId>(() => {
    const saved = window.localStorage.getItem(STORE_KEY);
    if (allowed(saved)) return saved;
    return licensed[0]?.id ?? 'douyin';
  });
  const pick = (id: SauPlatformId) => {
    setPlatform(id);
    window.localStorage.setItem(STORE_KEY, id);
  };
  // license 异步到达后当前平台可能越权——落回第一个授权平台。
  const effective = allowed(platform) ? platform : (licensed[0]?.id ?? 'douyin');
  return (
    <div className={c('articleShell')}>
      {licensed.length > 1 ? (
        <div className={c('articleSwitch')}>
          <span className={c('articleSwitchLabel')}>短视频平台</span>
          {licensed.map((p) => (
            <button
              key={p.id}
              type="button"
              className={`${c('articleSwitchBtn')}${p.id === effective ? ` ${c('articleSwitchBtnActive')}` : ''}`}
              aria-pressed={p.id === effective}
              onClick={() => pick(p.id)}
            >
              {p.label}
            </button>
          ))}
        </div>
      ) : null}
      {/* key=平台:切平台重挂载,各平台独立当前作品/自动保存。 */}
      <ShortVideoStudioView key={effective} platform={effective} />
    </div>
  );
}
