// 「文章」创作台外壳(2026-07-10 用户拍板:公众号/知乎/微博同属文章形态,
// 收进一个导航入口,顶部平台切换)。短视频/笔记是别的内容形态,各自独立。
//
// 平台切换是外壳内部状态(localStorage 记忆),不走路由——所以标签栏只有
// 一个「文章」标签,切平台不新开标签。三个子创作台各自完整(选题/写作/
// 发布逻辑因平台性质而异),外壳只负责平台维度的切换。
//
// 功能授权裁剪(2026-07-11):平台按授权过滤——客户只买公众号时,知乎/微博
// pills 不出现;只剩一个平台时整条切换栏不渲染。
import { useState } from 'react';
import { MediaStudioView } from './MediaStudioView';
import { ZhihuStudioView } from './ZhihuStudioView';
import { hasFeature, useLicense } from '../../state/license';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

// 微博已移除(2026-07-17 翟总:客户不需要微博)。文章 = 公众号 + 知乎。
type ArticlePlatform = 'wechat' | 'zhihu';
const PLATFORMS: Array<{ id: ArticlePlatform; label: string; feature: 'article.wechat-mp' | 'article.zhihu' }> = [
  { id: 'wechat', label: '公众号', feature: 'article.wechat-mp' },
  { id: 'zhihu', label: '知乎', feature: 'article.zhihu' },
];
const STORE_KEY = 'open-design:studio:article-platform';

/** 进入「文章」时可带初始平台(路由深链 studio-zhihu/-weibo 映射);缺省
 *  读上次选择。 */
export function ArticleStudioShell({ initial }: { initial?: ArticlePlatform }): JSX.Element {
  const license = useLicense();
  const licensed = PLATFORMS.filter((p) => hasFeature(license, p.feature));
  const allowed = (id: string | null | undefined): id is ArticlePlatform =>
    licensed.some((p) => p.id === id);
  const [platform, setPlatform] = useState<ArticlePlatform>(() => {
    if (initial && allowed(initial)) return initial;
    const saved = window.localStorage.getItem(STORE_KEY);
    if (allowed(saved)) return saved;
    return licensed[0]?.id ?? 'wechat';
  });
  const pick = (id: ArticlePlatform) => {
    setPlatform(id);
    window.localStorage.setItem(STORE_KEY, id);
  };
  // license 异步到达后当前平台可能越权(启动瞬间全开渲染)——落回第一个授权平台。
  const effective = allowed(platform) ? platform : (licensed[0]?.id ?? 'wechat');
  return (
    <div className={c('articleShell')}>
      {licensed.length > 1 ? (
        <div className={c('articleSwitch')}>
          <span className={c('articleSwitchLabel')}>文章平台</span>
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
      {/* 子创作台各自维护当前文章/自动保存;切平台=卸载重挂,各台 localStorage
          记忆自己的当前文章,回来还在原处。 */}
      {effective === 'wechat' ? <MediaStudioView /> : <ZhihuStudioView />}
    </div>
  );
}
