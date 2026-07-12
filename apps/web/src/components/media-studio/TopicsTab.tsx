// 选题导航（两个创作台共享）：手动候选 + 组合式选题雷达（数据源可勾选
// 组合：爆文榜/搜一搜/全库搜索/需求词/对标动态）+「AI 帮我选题」。
// 独立可用，也向写作/脚本步输送选题。
import { useEffect, useMemo, useState } from 'react';
import type { MediaTopic, MediaTopicHit } from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  fetchAccountRank,
  searchTopicFeed,
  type RankedAccountRow,
  type TopicFeedKind,
  fetchTikhubFeed,
} from '../../providers/media-studio';
import { studioToast } from './StudioFeedback';
import { hasFeature, useLicense } from '../../state/license';
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

// 选题搜索结果留存（2026-07-12 用户要：切标签回来别丢）。按平台隔离存 localStorage，
// 跨标签切换与应用重启都在。命中列表/提示文案/关键词/已存标记/已勾选一起存。
const TOPIC_SEARCH_KEY = (platform: string): string => `open-design:studio:topic-search:${platform}`;
const MAX_PERSIST_HITS = 120;

interface PersistedTopicSearch {
  hits: MediaTopicHit[];
  notice: string | null;
  direction: string;
  savedUrls: string[];
  picked: MediaTopicHit[];
}

function loadTopicSearch(platform: string): PersistedTopicSearch {
  const empty: PersistedTopicSearch = { hits: [], notice: null, direction: '', savedUrls: [], picked: [] };
  try {
    const raw = window.localStorage.getItem(TOPIC_SEARCH_KEY(platform));
    if (!raw) return empty;
    const p = JSON.parse(raw) as Partial<PersistedTopicSearch>;
    return {
      hits: Array.isArray(p.hits) ? (p.hits as MediaTopicHit[]).slice(0, MAX_PERSIST_HITS) : [],
      notice: typeof p.notice === 'string' ? p.notice : null,
      direction: typeof p.direction === 'string' ? p.direction : '',
      savedUrls: Array.isArray(p.savedUrls) ? (p.savedUrls as unknown[]).filter((u): u is string => typeof u === 'string') : [],
      picked: Array.isArray(p.picked) ? (p.picked as MediaTopicHit[]).slice(0, MAX_PERSIST_HITS) : [],
    };
  } catch {
    return empty;
  }
}

function saveTopicSearch(platform: string, data: PersistedTopicSearch): void {
  try {
    window.localStorage.setItem(
      TOPIC_SEARCH_KEY(platform),
      JSON.stringify({
        hits: data.hits.slice(0, MAX_PERSIST_HITS),
        notice: data.notice,
        direction: data.direction,
        savedUrls: data.savedUrls,
        picked: data.picked.slice(0, MAX_PERSIST_HITS),
      }),
    );
  } catch {
    /* best-effort：容量满/隐私模式写失败无所谓，下次搜索照常 */
  }
}

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

/** 勾选的优先参考文章（喂给 AI 选题任务的素材形状）。 */
export interface PickedHit {
  title: string;
  url?: string;
  account?: string;
  readNum?: number | null;
}

export interface TopicsTabProps {
  platform: string;
  /** 公众号模式：候选只能由「AI 帮我选题」产出——隐藏手动添加与热榜「存为候选」。 */
  aiOnly?: boolean;
  topics: MediaTopic[];
  onAdd: (draft: { title: string; angle?: string; source?: string; url?: string; heat?: string }) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
  onWrite: (topic: MediaTopic) => void;
  /** picked = 用户勾选的优先参考；单篇「AI 转题」= note 空 + picked 一篇。 */
  onAiFind: (note: string, picked?: PickedHit[]) => void;
  aiBusy: boolean;
  /** TikHub 平台分流模式(短视频台,2026-07-09 用户拍板):选题数据按目标
   *  平台走它自己的接口(抖音↔抖音、小红书↔小红书、快手↔快手),传了此
   *  prop 数据源区渲染平台 chips+热榜/搜索,不再是大家来(公众号生态)五源。 */
  tikhubTargets?: Array<{ id: 'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo'; label: string }>;
  /** 平台原生选题源(2026-07-12 知乎：登录态直取热榜/热搜/联想/搜索,替 TikHub)。
   *  传了此 prop，数据源区渲染原生源按钮；结果同样进候选表(MediaTopicHit)。 */
  nativeFeed?: {
    label: string;
    sources: Array<{ id: string; label: string; needsKeyword: boolean }>;
    run: (sourceId: string, keyword?: string) => Promise<MediaTopicHit[] | { error: string }>;
  };
  /** 传了则文章链接(热点/候选原文)改在内置浏览器打开(桌面端);不传保持系统新标签。 */
  onOpenLink?: (url: string) => void;
}

export function TopicsTab({ platform, aiOnly = false, topics, onAdd, onDelete, onWrite, onAiFind, aiBusy, tikhubTargets, nativeFeed, onOpenLink }: TopicsTabProps): JSX.Element {
  const license = useLicense();
  // 上次在该平台的选题搜索结果（切标签/重启后恢复，见文件顶 loadTopicSearch）。
  const restored = useMemo(() => loadTopicSearch(platform), [platform]);
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [direction, setDirection] = useState(restored.direction);
  const [hits, setHits] = useState<MediaTopicHit[]>(restored.hits);
  const [feedBusy, setFeedBusy] = useState(false);
  const [feedNotice, setFeedNotice] = useState<string | null>(restored.notice);
  const [savedHitUrls, setSavedHitUrls] = useState<Set<string>>(() => new Set(restored.savedUrls));
  const [enabledFeeds, setEnabledFeeds] = useState<Set<TopicFeedKind>>(loadEnabledFeeds);
  const [peers, setPeers] = useState(() => window.localStorage.getItem(PEERS_STORE_KEY) ?? '');
  const [sugWords, setSugWords] = useState<string[]>([]);
  // 多选优先参考：勾选的文章喂给「AI 帮我选题」优先深挖（跨多轮搜索保留）。
  const [pickedHits, setPickedHits] = useState<Map<string, MediaTopicHit>>(
    () => new Map(restored.picked.map((h) => [h.url || h.title, h])),
  );

  // 每当命中/提示/关键词/已存/已勾选变化，回存该平台的选题搜索结果——切标签或
  // 关闭再回来都还在。
  useEffect(() => {
    saveTopicSearch(platform, {
      hits,
      notice: feedNotice,
      direction,
      savedUrls: [...savedHitUrls],
      picked: [...pickedHits.values()],
    });
  }, [platform, hits, feedNotice, direction, savedHitUrls, pickedHits]);
  // 选题深挖：类目榜找对标
  const [rankView, setRankView] = useState<RankedAccountRow[] | null>(null);
  const [rankBusy, setRankBusy] = useState(false);

  function togglePick(hit: MediaTopicHit) {
    const key = hit.url || hit.title;
    setPickedHits((prev) => {
      const next = new Map(prev);
      if (next.has(key)) next.delete(key);
      else next.set(key, hit);
      return next;
    });
  }

  const toPicked = (list: MediaTopicHit[]): PickedHit[] =>
    list.map((h) => ({
      title: h.title,
      ...(h.url ? { url: h.url } : {}),
      ...(h.account ? { account: h.account } : {}),
      ...(h.readNum != null ? { readNum: h.readNum } : {}),
    }));

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

  const TIKHUB_TARGET_KEY = 'open-design:studio:tikhub-target';
  const [tikhubTarget, setTikhubTarget] = useState<'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo'>(() => {
    const saved = window.localStorage.getItem(TIKHUB_TARGET_KEY);
    const valid = tikhubTargets?.some((t) => t.id === saved);
    return (valid ? saved : tikhubTargets?.[0]?.id ?? 'douyin') as 'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo';
  });
  const tikhubTargetLabel = tikhubTargets?.find((t) => t.id === tikhubTarget)?.label ?? tikhubTarget;

  async function runNative(sourceId: string) {
    if (!nativeFeed) return;
    const meta = nativeFeed.sources.find((s) => s.id === sourceId);
    const keyword = direction.trim();
    if (meta?.needsKeyword && !keyword) {
      studioToast.info('先填个方向词再搜');
      return;
    }
    setFeedBusy(true);
    setFeedNotice(null);
    const r = await nativeFeed.run(sourceId, keyword);
    setFeedBusy(false);
    if ('error' in r) {
      studioToast.err(r.error);
      return;
    }
    setHits(r);
    setFeedNotice(`${nativeFeed.label} · ${meta?.label ?? sourceId} 共 ${r.length} 条`);
  }

  async function runTikhub(mode: 'hot' | 'search') {
    const keyword = direction.trim();
    if (mode === 'search' && !keyword) {
      studioToast.info('关键词搜索先填个词');
      return;
    }
    setFeedBusy(true);
    setFeedNotice(null);
    const r = await fetchTikhubFeed(platform, {
      target: tikhubTarget,
      mode,
      ...(mode === 'search' && keyword ? { keyword } : {}),
    });
    setFeedBusy(false);
    if ('error' in r) {
      studioToast.err(r.error);
      return;
    }
    setHits(r.items);
    setFeedNotice(`${tikhubTargetLabel}${mode === 'hot' ? '热榜' : `「${keyword}」搜索`} 共 ${r.items.length} 条`);
  }

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
        {nativeFeed && nativeFeed.sources.some((s) => !s.needsKeyword) ? (
          <div className={c('row')} style={{ flexWrap: 'wrap' }}>
            <span className={c('cardHint')}>看{nativeFeed.label}全站在热什么（免填词，与下面的关键词无关）：</span>
            {nativeFeed.sources.filter((s) => !s.needsKeyword).map((s, i) => (
              <button
                key={s.id}
                type="button"
                className={`${c('btn')}${i === 0 ? ` ${c('btnPrimary')}` : ''}`}
                disabled={feedBusy}
                title={`直接拉取${nativeFeed.label}「${s.label}」——看全站热点，不用填关键词`}
                onClick={() => void runNative(s.id)}
              >
                {feedBusy ? '拉取中…' : s.label}
              </button>
            ))}
          </div>
        ) : tikhubTargets ? (
          <div className={c('row')}>
            <span className={c('cardHint')}>选题平台（数据从该平台自己的接口来）：</span>
            {tikhubTargets.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`${c('chip')}${t.id === tikhubTarget ? ` ${c('chipBlue')}` : ''}`}
                style={{ cursor: 'pointer', border: 'none' }}
                onClick={() => {
                  setTikhubTarget(t.id);
                  window.localStorage.setItem(TIKHUB_TARGET_KEY, t.id);
                }}
              >
                {t.label}
              </button>
            ))}
          </div>
        ) : null}
        {nativeFeed || tikhubTargets ? null : (
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
        )}
        {!tikhubTargets && !nativeFeed && enabledFeeds.has('peers') ? (
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
            placeholder={nativeFeed ? '填方向词 → 点「联想词/搜索」，例：军队文职、考研…' : '方向/领域关键词，例：AI 编程、考研、育儿…'}
            onChange={(e) => setDirection(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !feedBusy) {
                if (nativeFeed) {
                  const searchSrc = nativeFeed.sources.find((s) => s.needsKeyword);
                  if (searchSrc) void runNative(searchSrc.id);
                } else void (tikhubTargets ? runTikhub('search') : runCombo());
              }
            }}
          />
          {nativeFeed ? (
            <>
              {nativeFeed.sources.filter((s) => s.needsKeyword).map((s) => (
                <button
                  key={s.id}
                  type="button"
                  className={c('btn')}
                  disabled={feedBusy || !direction.trim()}
                  title={`用左边的方向词在${nativeFeed.label}取「${s.label}」`}
                  onClick={() => void runNative(s.id)}
                >
                  {feedBusy ? '拉取中…' : s.label}
                </button>
              ))}
            </>
          ) : tikhubTargets ? (
            <>
              <button
                type="button"
                className={`${c('btn')} ${c('btnPrimary')}`}
                disabled={feedBusy}
                title={`拉取${tikhubTargetLabel}官方热榜——今天平台上最热的话题`}
                onClick={() => void runTikhub('hot')}
              >
                {feedBusy ? '拉取中…' : `${tikhubTargetLabel}热榜`}
              </button>
              <button
                type="button"
                className={c('btn')}
                disabled={feedBusy || !direction.trim()}
                title={`用关键词在${tikhubTargetLabel}站内搜索爆款内容`}
                onClick={() => void runTikhub('search')}
              >
                搜{tikhubTargetLabel}
              </button>
            </>
          ) : (
            <button
              type="button"
              className={`${c('btn')} ${c('btnPrimary')}`}
              disabled={feedBusy || enabledFeeds.size === 0}
              onClick={() => void runCombo()}
            >
              {feedBusy ? '组合扫描中…' : `开始找题（${enabledFeeds.size} 源）`}
            </button>
          )}
          {hasFeature(license, 'cap.ai') ? (
            <button
              type="button"
              className={c('btn')}
              disabled={aiBusy}
              onClick={() => onAiFind(direction.trim(), pickedHits.size > 0 ? toPicked([...pickedHits.values()]) : undefined)}
              title={
                aiBusy
                  ? '有 AI 任务正在运行——等它结束（或在底部面板中止）再发起'
                  : pickedHits.size > 0
                    ? '优先围绕你勾选的文章深挖出题（抓原文、找差异化角度），其余热点做背景'
                    : '智能体结合热点数据把方向细化成 3-5 个可写的选题，自动进候选表'
              }
            >
              <Icon name="sparkles" size={14} /> {aiBusy ? 'AI 任务进行中…' : `AI 帮我选题${pickedHits.size > 0 ? `（${pickedHits.size} 篇优先）` : ''}`}
            </button>
          ) : null}
          {pickedHits.size > 0 ? (
            <button type="button" className={c('btn')} title="清空勾选的优先参考" onClick={() => setPickedHits(new Map())}>
              清空已选
            </button>
          ) : null}
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
                <th title="勾选=优先参考——AI 帮我选题时优先围绕勾选的文章深挖">选</th>
                <th>信号</th>
                <th>标题</th>
                <th>{tikhubTargets ? '账号' : '公众号'}</th>
                <th>数据</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hits.slice(0, 30).map((hit) => {
                const pickKey = hit.url || hit.title;
                return (
                  <tr key={pickKey}>
                    <td>
                      <input
                        type="checkbox"
                        title="勾选为优先参考"
                        checked={pickedHits.has(pickKey)}
                        onChange={() => togglePick(hit)}
                      />
                    </td>
                    <td>{signalTag(hit.signals)}</td>
                    <td>
                      {hit.url ? (
                        <a
                          className={c('link')}
                          href={hit.url}
                          target="_blank"
                          rel="noreferrer"
                          onClick={(e) => {
                            if (onOpenLink && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                              e.preventDefault();
                              onOpenLink(hit.url);
                            }
                          }}
                        >
                          {hit.title}
                        </a>
                      ) : (
                        hit.title
                      )}
                    </td>
                    <td>{hit.account}</td>
                    <td>{hit.hot ? hit.hot : hit.readNum ? `阅读 ${hit.readNum}` : hit.desc ? hit.desc.slice(0, 24) : '—'}</td>
                    <td className={c('tdActions')}>
                      <button
                        type="button"
                        className={c('btn')}
                        disabled={aiBusy}
                        title="AI 抓这篇原文分析后，转化出 1-2 个属于你账号的差异化选题进候选（不是照搬标题）"
                        onClick={() => onAiFind('', toPicked([hit]))}
                      >
                        <Icon name="sparkles" size={13} /> AI 转题
                      </button>{' '}
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
                      <a
                        className={c('link')}
                        href={t.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          if (onOpenLink && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                            e.preventDefault();
                            onOpenLink(t.url!);
                          }
                        }}
                      >
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
