// 知识库 — 左侧导航一级入口（2026-07-08 用户拍板;2026-07-16 拆个人/企业两套）。
// 本分支 = 翟总(企业客户):只出【企业知识库】(分类=主体/资质/产品),不出「个人自媒体库」
// (那是鱼老师个人自媒体客户那套:人设/风格/素材)。数据存 daemon 的 platform='global'
// 下(企业分类 id 带 ent- 前缀)。AI 任务(选题/写作/仿写)按 category 注入对应素材。
import { useEffect, useState } from 'react';
import { fetchPlatformAccounts } from '../../providers/daemon';
import { KnowledgePanel, type KnowledgeVariant } from './StudioSharedCards';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 账号范围下拉里给账号名标平台，跨平台同名账号不混淆。 */
const PLATFORM_LABEL: Record<string, string> = {
  'wechat-mp': '公众号',
  douyin: '抖音',
  xiaohongshu: '小红书',
};

const VARIANT_META: Record<KnowledgeVariant, { tab: string; title: string; hint: string }> = {
  personal: {
    tab: '个人自媒体库',
    title: '个人自媒体知识库',
    hint: '喂你的人设 / 核心观点 / 口播风格 / 金句 / 目标人群——AI 写脚本时按类注入，写出来就像你本人',
  },
  enterprise: {
    tab: '企业知识库',
    title: '企业知识库',
    hint: '喂公司主体 / 资质背书 / 产品服务 / 客户案例 / 品牌调性——AI 写公众号·微博·知乎文章时按类注入，贴合企业口径、带背书',
  },
};

export function KnowledgeView(): JSX.Element {
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);

  // 翟总 = 企业客户,知识库只出【企业知识库】,不要「个人自媒体库」那套(2026-07-17 客户拍板)。
  const shown = ['enterprise'] as KnowledgeVariant[];
  const [active, setActive] = useState<KnowledgeVariant>(shown[0]!);
  const activeVariant = shown.includes(active) ? active : shown[0]!;
  const meta = VARIANT_META[activeVariant];

  useEffect(() => {
    void fetchPlatformAccounts().then((resp) => {
      if (!resp) return;
      setAccounts(
        resp.platforms.flatMap((p) =>
          p.accounts.map((a) => ({
            id: a.id,
            name: `${PLATFORM_LABEL[p.id] ?? p.id}·${a.name}`,
          })),
        ),
      );
    });
  }, []);

  return (
    <div className={c('root')}>
      <div className={c('head')}>
        <h1 className={c('title')}>{shown.length > 1 ? '知识库' : meta.title}</h1>
        <span className={c('cardHint')}>{meta.hint}</span>
      </div>
      {shown.length > 1 ? (
        <div className={c('tabs')} role="tablist" aria-label="知识库类型">
          {shown.map((v) => (
            <button
              key={v}
              type="button"
              role="tab"
              aria-selected={v === activeVariant}
              className={`${c('tab')}${v === activeVariant ? ` ${c('tabActive')}` : ''}`}
              onClick={() => setActive(v)}
            >
              {VARIANT_META[v].tab}
            </button>
          ))}
        </div>
      ) : null}
      <div className={c('main')}>
        <div className={c('editorCol')}>
          {/* key=variant:切库时重挂载,activeCat 重置到该库首个分类 */}
          <KnowledgePanel key={activeVariant} platform="global" accounts={accounts} variant={activeVariant} />
        </div>
      </div>
    </div>
  );
}
