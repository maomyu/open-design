// 「文章」创作台外壳(2026-07-10 用户拍板:公众号/知乎/微博同属文章形态,
// 收进一个导航入口,顶部平台切换)。短视频/笔记是别的内容形态,各自独立。
//
// 平台切换是外壳内部状态(localStorage 记忆),不走路由——所以标签栏只有
// 一个「文章」标签,切平台不新开标签。三个子创作台各自完整(选题/写作/
// 发布逻辑因平台性质而异),外壳只负责平台维度的切换。
import { useState } from 'react';
import { MediaStudioView } from './MediaStudioView';
import { ZhihuStudioView } from './ZhihuStudioView';
import { WeiboStudioView } from './WeiboStudioView';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

type ArticlePlatform = 'wechat' | 'zhihu' | 'weibo';
const PLATFORMS: Array<{ id: ArticlePlatform; label: string }> = [
  { id: 'wechat', label: '公众号' },
  { id: 'zhihu', label: '知乎' },
  { id: 'weibo', label: '微博' },
];
const STORE_KEY = 'open-design:studio:article-platform';

/** 进入「文章」时可带初始平台(路由深链 studio-zhihu/-weibo 映射);缺省
 *  读上次选择。 */
export function ArticleStudioShell({ initial }: { initial?: ArticlePlatform }): JSX.Element {
  const [platform, setPlatform] = useState<ArticlePlatform>(() => {
    if (initial) return initial;
    const saved = window.localStorage.getItem(STORE_KEY);
    return saved === 'zhihu' || saved === 'weibo' || saved === 'wechat' ? saved : 'wechat';
  });
  const pick = (id: ArticlePlatform) => {
    setPlatform(id);
    window.localStorage.setItem(STORE_KEY, id);
  };
  return (
    <div className={c('articleShell')}>
      <div className={c('articleSwitch')}>
        <span className={c('articleSwitchLabel')}>文章平台</span>
        {PLATFORMS.map((p) => (
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
      {/* 子创作台各自维护当前文章/自动保存;切平台=卸载重挂,各台 localStorage
          记忆自己的当前文章,回来还在原处。 */}
      {platform === 'wechat' ? <MediaStudioView /> : platform === 'zhihu' ? <ZhihuStudioView /> : <WeiboStudioView />}
    </div>
  );
}
