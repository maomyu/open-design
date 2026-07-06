// 选题导航（两个创作台共享）：手动候选 + 大家来数据按钮（爆文榜/搜一搜/
// 双信号雷达）+「AI 帮我选题」。独立可用，也向写作/脚本步输送选题。
import { useMemo, useState } from 'react';
import type { MediaTopic, MediaTopicHit } from '@open-design/contracts';
import { Icon } from '../Icon';
import { searchTopicFeed, type TopicFeedKind } from '../../providers/media-studio';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

// ---- 选题导航（独立可用） ----

export interface TopicsTabProps {
  platform: string;
  /** 公众号模式：候选只能由「AI 帮我选题」产出——隐藏手动添加与热榜「存为候选」。 */
  aiOnly?: boolean;
  topics: MediaTopic[];
  onAdd: (draft: { title: string; angle?: string; source?: string; url?: string; heat?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onWrite: (topic: MediaTopic) => void;
  onAiFind: (note: string) => void;
  aiBusy: boolean;
}

export function TopicsTab({ platform, aiOnly = false, topics, onAdd, onDelete, onWrite, onAiFind, aiBusy }: TopicsTabProps): JSX.Element {
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [direction, setDirection] = useState('');
  const [hits, setHits] = useState<MediaTopicHit[]>([]);
  const [feedBusy, setFeedBusy] = useState<TopicFeedKind | null>(null);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [savedHitUrls, setSavedHitUrls] = useState<Set<string>>(() => new Set());
  const canAdd = title.trim().length > 0;
  const candidates = useMemo(() => topics.filter((t) => t.status === 'candidate'), [topics]);
  const used = useMemo(() => topics.filter((t) => t.status === 'used'), [topics]);

  async function runFeed(feed: TopicFeedKind) {
    setFeedBusy(feed);
    setFeedNotice(null);
    const result = await searchTopicFeed(platform, feed, {
      ...(direction.trim() ? { keyword: direction.trim() } : {}),
    });
    setFeedBusy(null);
    if ('error' in result) {
      setFeedNotice(result.error);
      return;
    }
    setHits(result.items);
    setFeedNotice(`拉到 ${result.items.length} 条（${result.sources.map((s) => (s === 'trending' ? '爆文榜' : '搜一搜')).join(' + ')}）`);
  }

  const signalTag = (signals: MediaTopicHit['signals']) =>
    signals.length === 2 ? '⭐ 双信号' : signals[0] === 'trending' ? '🔥 爆款' : '🔍 搜一搜';

  async function saveHit(hit: MediaTopicHit) {
    await onAdd({
      title: hit.title,
      source: hit.account,
      ...(hit.url ? { url: hit.url } : {}),
      heat: hit.signals.length === 2 ? '高' : '中',
    });
    setSavedHitUrls((prev) => new Set(prev).add(hit.url || hit.title));
  }

  async function submit() {
    if (!canAdd) return;
    await onAdd({
      title: title.trim(),
      ...(angle.trim() ? { angle: angle.trim() } : {}),
      ...(source.trim() ? { source: source.trim() } : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
    });
    setTitle('');
    setAngle('');
    setSource('');
    setUrl('');
  }

  return (
    <>
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          找热点
          <span className={c('cardHint')}>{aiOnly ? '热榜仅供参考溯源——候选统一由「AI 帮我选题」结合热点产出' : '大家来数据：⭐双信号=最强选题 · 🔥爆款=流量验证 · 🔍搜一搜=搜索需求'}</span>
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={direction}
            placeholder="方向/领域关键词，例：AI 编程、考研、育儿…"
            onChange={(e) => setDirection(e.target.value)}
          />
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={feedBusy !== null || !direction.trim()}
            onClick={() => void runFeed('radar')}
          >
            {feedBusy === 'radar' ? '雷达扫描中…' : '双信号雷达'}
          </button>
          <button
            type="button"
            className={c('btn')}
            disabled={feedBusy !== null}
            onClick={() => void runFeed('hot-search')}
          >
            {feedBusy === 'hot-search' ? '拉取中…' : '爆文榜'}
          </button>
          <button
            type="button"
            className={c('btn')}
            disabled={feedBusy !== null || !direction.trim()}
            onClick={() => void runFeed('web-search')}
          >
            {feedBusy === 'web-search' ? '搜索中…' : '搜一搜'}
          </button>
          <button
            type="button"
            className={c('btn')}
            disabled={aiBusy}
            onClick={() => onAiFind(direction.trim())}
            title="智能体结合热点数据把方向细化成 3-5 个可写的选题，自动进候选表"
          >
            <Icon name="sparkles" size={14} /> AI 帮我选题
          </button>
        </div>
        {feedNotice ? <div className={c('cardHint')}>{feedNotice}</div> : null}
        {hits.length > 0 ? (
          <table className={c('table')}>
            <thead>
              <tr>
                <th>信号</th>
                <th>标题</th>
                <th>公众号</th>
                <th>数据</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hits.slice(0, 30).map((hit) => (
                <tr key={hit.url || hit.title}>
                  <td>{signalTag(hit.signals)}</td>
                  <td>
                    {hit.url ? (
                      <a className={c('link')} href={hit.url} target="_blank" rel="noreferrer">
                        {hit.title}
                      </a>
                    ) : (
                      hit.title
                    )}
                  </td>
                  <td>{hit.account}</td>
                  <td>{hit.readNum ? `阅读 ${hit.readNum}` : hit.desc ? hit.desc.slice(0, 24) : '—'}</td>
                  <td className={c('tdActions')}>
                    {aiOnly ? null : (
                      <button
                        type="button"
                        className={c('btn')}
                        disabled={savedHitUrls.has(hit.url || hit.title)}
                        onClick={() => void saveHit(hit)}
                      >
                        {savedHitUrls.has(hit.url || hit.title) ? '已存' : '存为候选'}
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : null}
      </div>
      {aiOnly ? null : (
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          添加选题
          <span className={c('cardHint')}>手动记一个想法，或把 AI 对话/爆文榜里的候选沉淀进来</span>
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={title}
            placeholder="选题标题（必填）"
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void submit();
            }}
          />
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={angle}
            placeholder="切入角度（可选）"
            onChange={(e) => setAngle(e.target.value)}
          />
          <input
            className={c('input')}
            style={{ width: 140 }}
            value={source}
            placeholder="来源（可选）"
            onChange={(e) => setSource(e.target.value)}
          />
          <input
            className={`${c('input')} ${c('grow')}`}
            value={url}
            placeholder="原文链接（可选）"
            onChange={(e) => setUrl(e.target.value)}
          />
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={!canAdd} onClick={() => void submit()}>
            添加
          </button>
        </div>
      </div>
      )}
      <div className={c('card')}>
        <div className={c('cardLabel')}>候选选题（{candidates.length}）</div>
        {candidates.length === 0 ? (
          <div className={c('empty')}>{aiOnly ? '还没有候选——填个方向，点「AI 帮我选题」，候选由 AI 结合热点产出。' : '还没有候选选题——在上面添加第一个。'}</div>
        ) : (
          <table className={c('table')}>
            <thead>
              <tr>
                <th>标题</th>
                <th>角度</th>
                <th>来源</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td>{t.angle || '—'}</td>
                  <td>
                    {t.url ? (
                      <a className={c('link')} href={t.url} target="_blank" rel="noreferrer">
                        {t.source || '原文'}
                      </a>
                    ) : (
                      t.source || '—'
                    )}
                  </td>
                  <td className={c('tdActions')}>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => onWrite(t)}>
                      去写作
                    </button>{' '}
                    <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void onDelete(t.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {used.length > 0 ? (
        <div className={c('card')}>
          <div className={c('cardLabel')}>已用过（{used.length}）</div>
          <table className={c('table')}>
            <tbody>
              {used.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td className={c('tdActions')}>
                    <span className={`${c('chip')} ${c('chipGrey')}`}>已用</span>{' '}
                    <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void onDelete(t.id)}>
                      删除
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </>
  );
}
