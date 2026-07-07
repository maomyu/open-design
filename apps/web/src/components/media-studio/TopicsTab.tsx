// 选题导航（两个创作台共享）：手动候选 + 组合式选题雷达（数据源可勾选
// 组合：爆文榜/搜一搜/全库搜索/需求词/对标动态）+「AI 帮我选题」。
// 独立可用，也向写作/脚本步输送选题。
import { useMemo, useState } from 'react';
import type { MediaTopic, MediaTopicHit } from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  fetchAccountRank,
  fetchTopicComments,
  searchTopicFeed,
  verifyTopicEngagement,
  type RankedAccountRow,
  type TopicEngagement,
  type TopicFeedKind,
} from '../../providers/media-studio';
import { studioToast } from './StudioFeedback';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

// 数据源目录：不同行业/关键词需要的源不一样，用户自由勾选组合（组合被记忆）。
// usage 在鼠标悬停时以低调浮层展示——解释这个源是什么、怎么用。
const FEED_SOURCES: Array<{ id: TopicFeedKind; label: string; usage: string; needsKeyword: boolean }> = [
  {
    id: 'hot-search',
    label: '🔥 爆文榜',
    usage: '近期全网爆款文章库。不填关键词=看大盘热点；填了=看这个领域谁在爆。爆过的标题就是被验证过的选题方向。',
    needsKeyword: false,
  },
  {
    id: 'web-search',
    label: '🔍 搜一搜',
    usage: '腾讯搜一搜的实时结果（需要关键词）。看此刻用户能搜到什么，适合追热点、验证时效性。',
    needsKeyword: true,
  },
  {
    id: 'kw-search',
    label: '📚 全库搜索',
    usage: '全量历史文章库，带真实阅读数（需要关键词）。看同题竞品的真实数据：谁写爆过、读者买不买账。',
    needsKeyword: true,
  },
  {
    id: 'sug',
    label: '💡 需求词',
    usage: '微信搜索框的联想词=亿级用户的真实需求（需要关键词）。返回的词条点一下就能用它重新组合找题（下钻）。',
    needsKeyword: true,
  },
  {
    id: 'peers',
    label: '👥 对标动态',
    usage: '盯住同行：拉每个对标公众号最近 5 篇发文。先在下方填账号名（可点「找对标」从榜单挑），不填关键词也能跑。',
    needsKeyword: false,
  },
];
const FEEDS_STORE_KEY = 'open-design:studio:topic-feeds';
const PEERS_STORE_KEY = 'open-design:studio:topic-peers';

function loadEnabledFeeds(): Set<TopicFeedKind> {
  try {
    const raw = window.localStorage.getItem(FEEDS_STORE_KEY);
    if (raw) {
      const arr = JSON.parse(raw) as string[];
      const valid = arr.filter((f): f is TopicFeedKind => FEED_SOURCES.some((s) => s.id === f));
      if (valid.length > 0) return new Set(valid);
    }
  } catch {
    /* fall through to default */
  }
  return new Set<TopicFeedKind>(['hot-search', 'web-search']);
}

/** 多源结果合并：同一篇文章（url 归一）信号取并集，信号多的排前，再按阅读数。 */
function mergeHits(lists: MediaTopicHit[][]): MediaTopicHit[] {
  const bucket = new Map<string, MediaTopicHit>();
  for (const list of lists) {
    for (const hit of list) {
      const key = hit.url || hit.title;
      const existing = bucket.get(key);
      if (existing) {
        existing.signals = [...new Set([...existing.signals, ...hit.signals])] as MediaTopicHit['signals'];
        if (!existing.desc && hit.desc) existing.desc = hit.desc;
        if (existing.readNum == null && hit.readNum != null) existing.readNum = hit.readNum;
        if (existing.zanNum == null && hit.zanNum != null) existing.zanNum = hit.zanNum;
      } else {
        bucket.set(key, { ...hit });
      }
    }
  }
  return [...bucket.values()].sort(
    (a, b) => b.signals.length - a.signals.length || (b.readNum ?? 0) - (a.readNum ?? 0),
  );
}

const SIGNAL_LABEL: Record<MediaTopicHit['signals'][number], string> = {
  trending: '🔥 爆款',
  realtime: '🔍 搜一搜',
  kwdb: '📚 全库',
  peer: '👥 对标',
};

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
  const [feedBusy, setFeedBusy] = useState(false);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [savedHitUrls, setSavedHitUrls] = useState<Set<string>>(() => new Set());
  const [enabledFeeds, setEnabledFeeds] = useState<Set<TopicFeedKind>>(loadEnabledFeeds);
  const [peers, setPeers] = useState(() => window.localStorage.getItem(PEERS_STORE_KEY) ?? '');
  const [sugWords, setSugWords] = useState<string[]>([]);
  // 深挖三件套：六维验证（按 url 缓存）/ 评论弹层 / 类目榜找对标
  const [engagements, setEngagements] = useState<Record<string, TopicEngagement | 'loading'>>({});
  // 批量验证开关：默认关（按条计费的显式选择，不记忆）。勾上后每次搜索
  // 自动对全部结果抓六维数据。
  const [verifyAll, setVerifyAll] = useState(false);
  const [verifyProgress, setVerifyProgress] = useState<{ done: number; total: number } | null>(null);
  const [commentsView, setCommentsView] = useState<{
    title: string;
    list: Array<{ content: string; likes: number }>;
    error?: string;
  } | null>(null);
  const [commentsBusy, setCommentsBusy] = useState<string | null>(null);
  const [rankView, setRankView] = useState<RankedAccountRow[] | null>(null);
  const [rankBusy, setRankBusy] = useState(false);

  /** 批量验证：6 并发一批抓六维数据；单篇失败静默跳过（已删除文章等）。 */
  async function batchVerify(list: MediaTopicHit[]) {
    const targets = list.filter((h) => h.url && !engagements[h.url]);
    if (targets.length === 0) return;
    setVerifyProgress({ done: 0, total: targets.length });
    let done = 0;
    let ok = 0;
    for (let i = 0; i < targets.length; i += 6) {
      const batch = targets.slice(i, i + 6);
      // eslint-disable-next-line no-await-in-loop
      await Promise.all(
        batch.map(async (hit) => {
          const result = await verifyTopicEngagement(platform, hit.url);
          done += 1;
          if (!result.error && result.engagement) {
            ok += 1;
            setEngagements((m) => ({ ...m, [hit.url]: result.engagement! }));
          }
          setVerifyProgress({ done, total: targets.length });
        }),
      );
    }
    setVerifyProgress(null);
    studioToast.ok(`互动数据验证完成：${ok}/${targets.length} 篇（失败的多为已删除文章）`);
  }

  async function openComments(hit: MediaTopicHit) {
    if (!hit.url) return;
    setCommentsBusy(hit.url);
    const result = await fetchTopicComments(platform, hit.url);
    setCommentsBusy(null);
    // 失败也开弹层把原因摆出来（比如「文章已被发布者删除」）——toast 一闪
    // 而过会让人以为按钮没反应。
    setCommentsView({ title: hit.title, list: result.comments ?? [], ...(result.error ? { error: result.error } : {}) });
  }

  async function openRank() {
    setRankBusy(true);
    const result = await fetchAccountRank(platform);
    setRankBusy(false);
    if (result.error) {
      studioToast.err(result.error);
      return;
    }
    setRankView(result.accounts ?? []);
  }

  function addPeer(name: string) {
    const list = peers.split(/[,，]/).map((s) => s.trim()).filter(Boolean);
    if (list.includes(name)) {
      studioToast.info(`「${name}」已在对标名单里`);
      return;
    }
    const next = [...list, name].slice(0, 5).join(',');
    setPeers(next);
    window.localStorage.setItem(PEERS_STORE_KEY, next);
    studioToast.ok(`已加入对标：${name}`);
  }
  const canAdd = title.trim().length > 0;
  const candidates = useMemo(() => topics.filter((t) => t.status === 'candidate'), [topics]);
  const used = useMemo(() => topics.filter((t) => t.status === 'used'), [topics]);

  function toggleFeed(id: TopicFeedKind) {
    setEnabledFeeds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      window.localStorage.setItem(FEEDS_STORE_KEY, JSON.stringify([...next]));
      return next;
    });
  }

  const peerList = peers.split(/[,，]/).map((s) => s.trim()).filter(Boolean);

  async function runCombo(keywordOverride?: string) {
    const keyword = (keywordOverride ?? direction).trim();
    const active = FEED_SOURCES.filter((s) => enabledFeeds.has(s.id));
    const runnable = active.filter((s) => {
      if (s.needsKeyword && !keyword) return false;
      if (s.id === 'peers' && peerList.length === 0) return false;
      return true;
    });
    if (runnable.length === 0) {
      studioToast.info(keyword ? '勾选的源都跑不了——对标动态需要先填账号名' : '先填个关键词，或勾选不需要关键词的源');
      return;
    }
    const skipped = active.length - runnable.length;
    setFeedBusy(true);
    setFeedNotice(null);
    setSugWords([]);
    const results = await Promise.all(
      runnable.map((s) =>
        searchTopicFeed(platform, s.id, {
          ...(keyword ? { keyword } : {}),
          ...(s.id === 'peers' ? { accounts: peerList } : {}),
        }).then((r) => ({ source: s, r })),
      ),
    );
    setFeedBusy(false);
    const okLists: MediaTopicHit[][] = [];
    const okLabels: string[] = [];
    const failures: string[] = [];
    let words: string[] = [];
    for (const { source, r } of results) {
      if ('error' in r) {
        failures.push(`${source.label.replace(/^\S+\s/, '')}：${r.error}`);
        continue;
      }
      okLabels.push(source.label);
      if (r.words && r.words.length > 0) words = r.words;
      if (r.items.length > 0) okLists.push(r.items);
    }
    const merged = mergeHits(okLists);
    setHits(merged);
    setSugWords(words);
    const parts = [`${okLabels.join(' + ')} 共 ${merged.length} 条`];
    if (words.length > 0) parts.push(`需求词 ${words.length} 个`);
    if (skipped > 0) parts.push(`${skipped} 个源缺关键词/账号被跳过`);
    setFeedNotice(parts.join(' · '));
    for (const f of failures) studioToast.err(f);
    if (verifyAll && merged.length > 0) {
      void batchVerify(merged.slice(0, 30));
    }
  }

  const signalTag = (signals: MediaTopicHit['signals']) =>
    signals.length >= 2 ? `⭐ ${signals.map((s) => SIGNAL_LABEL[s].replace(/^\S+\s/, '')).join('+')}` : SIGNAL_LABEL[signals[0] ?? 'trending'];

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
          找热点 · 组合选题雷达
          <span className={c('cardHint')}>{aiOnly ? '数据源按需勾选组合（组合会被记住）——候选统一由「AI 帮我选题」产出' : '数据源按需勾选组合，不同行业用不同搭配（组合会被记住）'}</span>
        </div>
        <div className={c('row')}>
          {FEED_SOURCES.map((s) => (
            <label key={s.id} className={`${c('row')} ${c('feedSrc')}`} style={{ gap: 4, cursor: 'pointer' }}>
              <input type="checkbox" checked={enabledFeeds.has(s.id)} onChange={() => toggleFeed(s.id)} />
              <span style={{ fontSize: 12.5 }}>{s.label}</span>
              <span className={c('feedSrcTip')} role="tooltip">
                {s.usage}
              </span>
            </label>
          ))}
        </div>
        {enabledFeeds.has('peers') ? (
          <div className={c('row')}>
            <input
              className={`${c('input')} ${c('grow')}`}
              value={peers}
              placeholder="对标账号名，逗号分隔（≤5 个），例：人民日报,虎嗅APP"
              onChange={(e) => {
                setPeers(e.target.value);
                window.localStorage.setItem(PEERS_STORE_KEY, e.target.value);
              }}
            />
            <button
              type="button"
              className={c('btn')}
              disabled={rankBusy}
              title="从公众号榜单里挑对标账号（带平均阅读/发文量数据）"
              onClick={() => void openRank()}
            >
              {rankBusy ? '拉榜中…' : '找对标'}
            </button>
          </div>
        ) : null}
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={direction}
            placeholder="方向/领域关键词，例：AI 编程、考研、育儿…"
            onChange={(e) => setDirection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !feedBusy) void runCombo();
            }}
          />
          <label className={`${c('row')} ${c('feedSrc')}`} style={{ gap: 4, cursor: 'pointer', whiteSpace: 'nowrap' }}>
            <input type="checkbox" checked={verifyAll} onChange={(e) => setVerifyAll(e.target.checked)} />
            <span style={{ fontSize: 12.5 }}>📊 验证数据</span>
            <span className={c('feedSrcTip')} role="tooltip">
              搜索完成后自动抓每篇的真实互动数据（阅读/转发/收藏），转发高=传播力强、最值得写。按条计费、稍慢，所以默认不开，需要判断选题质量时再勾。
            </span>
          </label>
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={feedBusy || enabledFeeds.size === 0}
            onClick={() => void runCombo()}
          >
            {feedBusy
              ? '组合扫描中…'
              : verifyProgress
                ? `验证中 ${verifyProgress.done}/${verifyProgress.total}…`
                : `开始找题（${enabledFeeds.size} 源）`}
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
        {sugWords.length > 0 ? (
          <div className={c('row')} style={{ flexWrap: 'wrap' }}>
            <span className={c('cardHint')}>💡 大家在搜：</span>
            {sugWords.map((w) => (
              <button
                key={w}
                type="button"
                className={`${c('chip')} ${c('chipBlue')}`}
                style={{ cursor: 'pointer', border: 'none' }}
                title="点击用这个需求词重新组合找题"
                onClick={() => {
                  setDirection(w);
                  void runCombo(w);
                }}
              >
                {w}
              </button>
            ))}
          </div>
        ) : null}
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
              {hits.slice(0, 30).map((hit) => {
                const eng = hit.url ? engagements[hit.url] : undefined;
                return (
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
                    <td>
                      {eng && eng !== 'loading' ? (
                        <span title="阅读 / 赞 / 在看 / 转发 / 收藏——转发高=传播力强，最值得写">
                          阅读 {eng.read} · <strong>转发 {eng.share}</strong> · 藏 {eng.collect}
                        </span>
                      ) : eng === 'loading' ? (
                        '验证中…'
                      ) : hit.readNum ? (
                        `阅读 ${hit.readNum}`
                      ) : hit.desc ? (
                        hit.desc.slice(0, 24)
                      ) : (
                        '—'
                      )}
                    </td>
                    <td className={c('tdActions')}>
                      {hit.url ? (
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={commentsBusy === hit.url}
                          title="看这篇的评论区——读者在问什么=你的切入角度"
                          onClick={() => void openComments(hit)}
                        >
                          {commentsBusy === hit.url ? '拉取中…' : '评论'}
                        </button>
                      ) : null}{' '}
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
                );
              })}
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
      {commentsView ? (
        <div
          className={c('lightbox')}
          role="button"
          tabIndex={0}
          onClick={() => setCommentsView(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setCommentsView(null);
          }}
        >
          <div className={c('topicOverlayCard')} role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className={c('cardLabel')}>
              评论区（{commentsView.list.length}）
              <span className={c('cardHint')}>{commentsView.title.slice(0, 40)}</span>
            </div>
            {commentsView.error ? (
              <div className={`${c('notice')} ${c('noticeErr')}`}>{commentsView.error}</div>
            ) : commentsView.list.length === 0 ? (
              <div className={c('cardHint')}>这篇没有公开评论（很多号未开评论区，属正常情况）。</div>
            ) : (
              <div style={{ overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
                {commentsView.list.map((cm, i) => (
                  <div key={`${i}-${cm.content.slice(0, 12)}`} style={{ fontSize: 12.5, lineHeight: 1.6 }}>
                    <span className={`${c('chip')} ${c('chipGrey')}`}>👍 {cm.likes}</span> {cm.content.slice(0, 160)}
                  </div>
                ))}
              </div>
            )}
            <div className={c('row')}>
              {commentsView.list.length > 0 ? (
                <button
                  type="button"
                  className={`${c('btn')} ${c('btnPrimary')}`}
                  disabled={aiBusy}
                  title="把评论区交给 AI：提炼读者关心但原文没讲透的点，产出候选选题"
                  onClick={() => {
                    const digest = commentsView.list
                      .slice(0, 15)
                      .map((cm) => `- (${cm.likes}赞) ${cm.content.slice(0, 80)}`)
                      .join('\n');
                    onAiFind(`从这篇爆文《${commentsView.title}》的读者评论里挖选题角度——找"读者关心但原文没讲透"的点：\n${digest}`);
                    setCommentsView(null);
                  }}
                >
                  <Icon name="sparkles" size={14} /> 让 AI 从评论提炼选题角度
                </button>
              ) : null}
              <button type="button" className={c('btn')} onClick={() => setCommentsView(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {rankView ? (
        <div
          className={c('lightbox')}
          role="button"
          tabIndex={0}
          onClick={() => setRankView(null)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setRankView(null);
          }}
        >
          <div className={c('topicOverlayCard')} role="dialog" onClick={(e) => e.stopPropagation()}>
            <div className={c('cardLabel')}>
              公众号榜单 · 挑对标
              <span className={c('cardHint')}>看平均阅读和发文量，点「加入对标」进名单（≤5 个）</span>
            </div>
            <div style={{ overflowY: 'auto' }}>
              <table className={c('table')}>
                <thead>
                  <tr>
                    <th>#</th>
                    <th>公众号</th>
                    <th>平均阅读</th>
                    <th>发文量</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {rankView.slice(0, 20).map((a) => (
                    <tr key={`${a.rank}-${a.wxid || a.name}`}>
                      <td>{a.rank}</td>
                      <td>{a.name}</td>
                      <td>{a.avgRead ?? '—'}</td>
                      <td>{a.postTotal ?? '—'}</td>
                      <td className={c('tdActions')}>
                        <button type="button" className={c('btn')} onClick={() => addPeer(a.name)}>
                          加入对标
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className={c('row')}>
              <button type="button" className={c('btn')} onClick={() => setRankView(null)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
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
