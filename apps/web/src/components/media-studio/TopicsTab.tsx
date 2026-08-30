// 选题导航（两个创作台共享）：手动候选 + 组合式选题雷达（数据源可勾选
// 组合：爆文榜/搜一搜/全库搜索/需求词/对标动态）+「AI 帮我选题」。
// 独立可用，也向写作/脚本步输送选题。
import { Fragment, useEffect, useMemo, useState, type ReactNode } from 'react';
import type { MediaDiscoverySnapshot, MediaTopic, MediaTopicHit } from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  fetchAccountRank,
  searchTopicFeed,
  type RankedAccountRow,
  type TopicFeedKind,
  fetchTikhubFeed,
  collectScoreTopics,
  downloadStudioVideo,
  fetchSourceMaterial,
  downloadVideoByUrl,
  extractScriptFromVideo,
  fetchStudioDiscoveries,
} from '../../providers/media-studio';
import { runScheduledMonitorNow } from '../../providers/daemon';
import { grabVideoSrc, exportBrowserCookies } from '../../runtime/browser-panes';
import { studioToast } from './StudioFeedback';
import { hasFeature, useLicense } from '../../state/license';
import styles from './MediaStudio.module.css';

const COLLECT_PLATFORM_LABEL: Record<string, string> = { douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', bilibili: 'B站', channels: '视频号' };

// 采集进度提示也走模块存储 + 事件:采集时选题页会被切走卸载,本地 state 会丢,导致用户看到
// 空白以为没反应。用模块级状态,重新挂载也能显示"正在采集/评分中…",有明确加载反馈。
let baokuanStatus = '';
const BAOKUAN_STATUS_EVENT = 'od:baokuan-status';
function setBaokuanStatus(s: string): void {
  baokuanStatus = s;
  window.dispatchEvent(new CustomEvent<string>(BAOKUAN_STATUS_EVENT, { detail: s }));
}

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

function visibleDiscoverySnapshots(
  snapshots: MediaDiscoverySnapshot[],
  manualScopeKey: string,
): MediaDiscoverySnapshot[] {
  return snapshots.filter(
    (snapshot) => snapshot.source === 'feishu-monitor'
      || (snapshot.source === 'manual-grab' && snapshot.scopeKey === manualScopeKey),
  );
}

function hitsFromDiscoverySnapshots(
  snapshots: MediaDiscoverySnapshot[],
  manualScopeKey: string,
): MediaTopicHit[] {
  const sourceOrder = { 'feishu-monitor': 0, 'manual-grab': 1 } as const;
  return visibleDiscoverySnapshots(snapshots, manualScopeKey)
    .sort((a, b) => sourceOrder[a.source] - sourceOrder[b.source] || b.updatedAt - a.updatedAt)
    .flatMap((snapshot) => snapshot.items.map((item) => ({
      ...item,
      discoverySource: snapshot.source,
    })));
}

function replaceDiscoverySnapshot(
  snapshots: MediaDiscoverySnapshot[],
  snapshot: MediaDiscoverySnapshot,
): MediaDiscoverySnapshot[] {
  return [
    ...snapshots.filter((item) => !(
      item.platform === snapshot.platform
      && item.source === snapshot.source
      && item.scopeKey === snapshot.scopeKey
    )),
    snapshot,
  ];
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
  /** 返回是否真的存成功(false=后端拒/网络错)——存为候选据此决定是否标「已存」,失败不置灰、可重试。 */
  // 回传新建的选题对象(而非 boolean):监控发现行点「去创作」时,存候选后要立刻拿它进创作。
  onAdd: (draft: { title: string; angle?: string; source?: string; url?: string; heat?: string; sourceContent?: string; sourceImages?: string[] }) => Promise<MediaTopic | null>;
  onDelete: (id: string) => Promise<void>;
  onWrite: (topic: MediaTopic) => void;
  /** picked = 用户勾选的优先参考；单篇「AI 转题」= note 空 + picked 一篇。 */
  onAiFind: (note: string, picked?: PickedHit[]) => void;
  /** 【提取文案仿写】拿到真实口播 transcript 后,直接建稿写一版可开拍的仿写口播稿(短视频台)。
   *  没传(如公众号)则回退到 onAiFind('topics') 老路。 */
  onRewriteToScript?: (title: string, transcript: string, sourceUrl: string, videoFile: string) => void;
  /** 图文笔记台:采到的小红书图文爆款 → 下载原图进图集 + 取原文案 → 按知识库风格仿写成新笔记。
   *  text/images 是随本条带回的原文案+原图直链(保证和用户点的这条一致)。 */
  onExtractNote?: (title: string, text: string, images: string[]) => void;
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
  /** 内置浏览器采集模式(短视频台:抖音/小红书/B站/快手)：选题数据【只】从平台内置浏览器
   *  采集而来(AI找选题→爆款雷达→内置浏览器)。传了此 prop:既不显示 TikHub 也不显示大家来
   *  (极致数据/公众号生态)五源——极致数据只服务公众号/视频号,不该出现在短视频台。 */
  browserCollect?: boolean;
  /** 真抓爆款要采的平台。只采【当前选中平台】——选抖音就只抓抖音。抖音/小红书/快手/B站走 TikHub
   *  直采;视频号走极致数据(dajiala,平台 id=channels,选题带 #odk= 解密key)。
   *  统一创作台(2026-07-18)传多个平台 = 多源爆款雷达,一次采多平台混合候选(来源在 account 列)。 */
  collectPlatforms?: string[];
  /** 小红书内容类型覆盖(统一创作台用:图文/视频由用户选,不再由 platform 推断)。 */
  xhsContentType?: 'image' | 'video';
  /** 行内展开(2026-07-18 用户反馈"去写作弹在顶上看不见"):点「去写作」后在该行
   *  正下方展开自定义内容(如形态选择)——视线零移动。传了 renderTopicExpansion 且
   *  expandedTopicId 命中该行时渲染。 */
  expandedTopicId?: string | null;
  renderTopicExpansion?: (topic: MediaTopic) => ReactNode;
}

export function TopicsTab({ platform, aiOnly = false, topics, onAdd, onDelete, onWrite, onAiFind, onRewriteToScript, onExtractNote, aiBusy, tikhubTargets, nativeFeed, onOpenLink, browserCollect = false, collectPlatforms, xhsContentType, expandedTopicId, renderTopicExpansion }: TopicsTabProps): JSX.Element {
  const license = useLicense();
  // 上次在该平台的选题搜索结果（切标签/重启后恢复，见文件顶 loadTopicSearch）。
  const restored = useMemo(() => loadTopicSearch(platform), [platform]);
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  // 「粘贴链接一键识别」(2026-08-04 用户拍板:四框全手填太麻烦——只有链接是必须的,
  // 标题/来源/原文案都能从链接识别出来;识别到的原素材随选题沉淀,去创作直接有洗稿原料)
  const [recognizeBusy, setRecognizeBusy] = useState(false);
  const [fetchedMaterial, setFetchedMaterial] = useState<{ sourceContent?: string; sourceImages?: string[] } | null>(null);
  const [direction, setDirection] = useState(restored.direction);
  // 🎯 爆款筛选（可选，喂给「AI 帮我选题」的爆款雷达）：时间窗 + 可组合的爆款规则（命中任一）。
  const [radarWindow, setRadarWindow] = useState<'all' | '7d' | '30d' | '180d'>('180d');
  const [radarRules, setRadarRules] = useState<Set<string>>(() => new Set());
  const toggleRadarRule = (k: string) =>
    setRadarRules((s) => {
      const n = new Set(s);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });
  // 预设爆款规则（灵活组合，组间 OR）：低粉爆款 / 高播放大爆 / 高赞。
  // 爆款筛选规则。热度 = 播放与点赞取高(引擎 criteria 里 heat=max(plays,likes))——抖音不公开
  // 播放量(接口播放=0),所以抖音按【点赞】算热度;快手/B站有播放按播放算。这样规则跨平台都成立。
  const RADAR_RULES: Array<{ key: string; label: string; rule: Record<string, number> }> = [
    { key: 'lowfan', label: '低粉爆款(粉丝≤3000·热度≥10万)', rule: { fans_max: 3000, plays_min: 100000 } },
    { key: 'bigbao', label: '大爆款(热度≥100万)', rule: { plays_min: 1000000 } },
    { key: 'highlike', label: '高赞(点赞≥5万)', rule: { likes_min: 50000 } },
    { key: 'hotcomment', label: '高互动(评论≥1万)', rule: { comments_min: 10000 } },
  ];
  const RADAR_WINDOW_LABEL: Record<string, string> = { all: '不限时间', '7d': '近一周', '30d': '近30天', '180d': '近半年' };
  // 把当前爆款筛选拼成结构化说明，附到「方向」文本后，交给爆款雷达技能解析执行。
  const buildRadarNote = (): string => {
    if (radarRules.size === 0 && radarWindow === 'all') return '';
    const rules = RADAR_RULES.filter((r) => radarRules.has(r.key)).map((r) => ({ ...r.rule, label: r.label }));
    const criteria = { time_window: radarWindow, rules };
    return `\n\n[爆款筛选] 时间窗=${RADAR_WINDOW_LABEL[radarWindow]}(${radarWindow})；`
      + (rules.length ? `命中任一规则：${rules.map((r) => r.label).join(' 或 ')}` : '仅按时间窗')
      + `。请用「爆款雷达」技能按 --time-window ${radarWindow} --criteria '${JSON.stringify(criteria)}' 采集+评分。`;
  };
  // 爆款筛选 → 引擎 criteria 对象(直接采集管线用)。
  const buildCriteria = () => {
    const rules = RADAR_RULES.filter((r) => radarRules.has(r.key)).map((r) => ({ ...r.rule }));
    // 没勾规则 =【自动·智能降档】(2026-07-16 用户:标准太高常抓不到,要能自动降档):引擎按档位
    // 阶梯(大爆款→爆款→热门→小热)从严到松找,凑够 5 条就停在那档;每档都不够就取头部兜底——
    // 冷门词也不空手。勾了具体规则 = 手动:尊重选择,只按规则筛、不降档。
    if (rules.length === 0) {
      return { time_window: radarWindow, auto: true, target: 5 };
    }
    return { time_window: radarWindow, rules };
  };
  // 采集页数(1-4):每页约 12 条候选。默认 1 页;想多看爆款可调大(会多爬几页,稍慢)。
  const [radarPages, setRadarPages] = useState(1);

  // ── 真抓爆款·直接采集(纯可视化,不经 AI 智能体)：点一下 → 内置浏览器【当前选中平台】可见
  //    采集 → 引擎按爆款筛选评分 → 选题候选直接进「候选选题」表。选抖音就只抓抖音。 ──
  const collectTargets = collectPlatforms ?? ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili'];
  // 爆款结果模块存储的分桶 key = 创作台 + 采集平台组合(短视频台每个子平台单独一桶;且笔记台的
  // 小红书采集与短视频台的小红书采集分属不同桶,互不串台——2026-07-16 图文笔记接入小红书选题时
  // 若只按平台分桶,两个台的小红书结果会互相覆盖显示)。
  const baokuanPlatKey = `${platform}|${collectTargets.join(',')}`;
  // 采集数据源标签:视频号走极致数据(dajiala),其余走 TikHub 直采。UI 文案据此显示,别再写死 TikHub。
  const collectSource = collectTargets.includes('channels') ? '极致数据' : 'TikHub';
  const [collectBusy, setCollectBusy] = useState(false);
  const [collectTier, setCollectTier] = useState('');   // 自动降档命中的档位名(显示在爆款列表上方)
  const [collectMsg, setCollectMsg] = useState(() => (browserCollect ? baokuanStatus : ''));
  // 采集进度:挂载即从模块状态读回(采集期间本组件可能被切走卸载过),并监听更新——保证采集
  // 的 1 分多钟里界面一直有"正在采集/评分中…"的加载反馈,而不是看着像空白。
  useEffect(() => {
    if (!browserCollect) return;
    if (baokuanStatus) setCollectMsg(baokuanStatus);
    const onStatus = (ev: Event) => setCollectMsg((ev as CustomEvent<string>).detail);
    window.addEventListener(BAOKUAN_STATUS_EVENT, onStatus);
    return () => window.removeEventListener(BAOKUAN_STATUS_EVENT, onStatus);
  }, [browserCollect]);
  const runDirectCollect = async () => {
    const kw = direction.trim();
    if (!kw) { studioToast.err('先在上面填「方向/领域关键词」'); return; }
    if (collectTargets.length === 0) { studioToast.err('该平台暂不支持真抓爆款——请切到抖音/小红书/快手/B站/视频号'); return; }
    setCollectBusy(true);
    try {
      // 【TikHub 直采】不再开内置浏览器逐平台搜(慢、要登录、撞验证码、DOM 易改版),直接给
      // 关键词+平台+爆款标准,引擎走 TikHub 搜索(翻页累积→按标准筛→评分)秒出选题。
      const names = collectTargets.map((p) => (COLLECT_PLATFORM_LABEL[p] ?? p)).join('、');
      setBaokuanStatus(`正在用 ${collectSource} 直采【${names}】${radarPages} 页并按爆款标准筛选评分…(约十几秒${radarPages > 1 ? '~' + radarPages * 8 + '秒' : ''})`);
      // 小红书内容类型按创作台区分:图文笔记台(platform==='note')只采【图文】,短视频台采【视频】。
      const xhsType = xhsContentType ?? (platform === 'note' ? 'image' : 'video');
      const scored = await collectScoreTopics(
        kw,
        collectTargets,
        buildCriteria(),
        radarPages,
        xhsType,
        { platform, scopeKey: baokuanPlatKey },
      );
      if ('error' in scored) { setBaokuanStatus(''); studioToast.err(scored.error); return; }
      // 评出的爆款 → hits 列表(带链接/点赞/播放/评论,可勾选),像公众号那样先列出来,
      // 再由用户勾选 +「AI 帮我选题」推荐成候选选题。不直接进候选表。
      const hitList: MediaTopicHit[] = scored.topics
        .filter((t) => String(t['标题'] ?? '').trim())
        .map((t) => ({
          title: String(t['标题'] ?? '').trim(),
          url: String(t['查看原文'] ?? ''),
          account: String(t['平台'] ?? ''),
          publishedAt: '',
          signals: ['trending'] as MediaTopicHit['signals'],
          readNum: Number(t['播放']) || null,
          zanNum: Number(t['点赞']) || null,
          hot: `${t['热度'] ?? ''}级 · 流量分${t['流量爆款分'] ?? ''}`,
          desc: `${String(t['评分理由'] ?? '')}${Number(t['评论']) ? ` · 评论${t['评论']}` : ''}${Number(t['粉丝']) ? ` · 粉丝${t['粉丝']}` : ''}`,
          // 小红书图文:随本条带回的原文案+原图直链(给「提取图文仿写」用,保证和这条一致)。
          ...(typeof t['原文案'] === 'string' && t['原文案'] ? { sourceContent: String(t['原文案']) } : {}),
          ...(Array.isArray(t['原图']) ? { sourceImages: (t['原图'] as unknown[]).filter((u): u is string => typeof u === 'string') } : {}),
        }));
      // 采集接口已在 daemon 内原子落库，UI/CLI 行为一致。空批次只记录本次为空，
      // 服务端继续返回上一批非空结果；应用重启/升级/组件卸载都不会清掉。
      const persisted = scored.discovery ?? null;
      if (persisted) {
        setDiscoverySnapshots((previous) => replaceDiscoverySnapshot(previous, persisted.snapshot));
      } else if (hitList.length > 0) {
        // 服务端保存失败时仍展示本次结果，但明确提示尚未获得持久化保障。
        setHits((previous) => [
          ...previous.filter((item) => item.discoverySource !== 'manual-grab'),
          ...hitList.map((item) => ({ ...item, discoverySource: 'manual-grab' as const })),
        ]);
        studioToast.err('本次爆款已抓到，但常驻保存失败——请确认后台正常后重新抓一次');
      }
      setBaokuanStatus('');
      // 自动降档命中的档位(引擎回传):存起来显示在爆款列表上方,让用户知道这批是哪个质量档。
      const tier = 'tier' in scored ? (scored.tier ?? '') : '';
      setCollectTier(persisted?.snapshot.tier ?? (hitList.length > 0 ? tier : ''));
      if (hitList.length === 0) {
        if (persisted?.retainedPrevious) {
          studioToast.info(`本次没有新爆款，已保留上一次的 ${persisted.snapshot.items.length} 条常驻结果，不会清空。`);
          return;
        }
        // 别再引导用户「勾规则再试」——勾了只会更严(关掉自动降档),越勾越少(2026-08-02 审计)。
        studioToast.info(
          radarRules.size > 0
            ? '这个词按你勾的爆款规则一条都没命中。把上面的规则勾选【全部取消】再搜一次——不勾=自动降档,冷门词也能给你找到相对最好的几条。'
            : '这个词实在没采到内容(可能太冷门/太新,或该平台确实没有)。换个更宽的词试试,比如把「男生变帅」换成「变帅」「穿搭」。',
        );
      } else {
        const tierLabel = tier ? `按【${tier}】档 · ` : '';
        studioToast.ok(`${tierLabel}真抓到 ${hitList.length} 个爆款,已列在下面(带链接·点赞·粉丝)。勾选想做的,再点「AI 帮我选题」生成候选选题。`);
      }
    } finally {
      setCollectBusy(false);
      setBaokuanStatus('');
    }
  };

  // 下载爆款原视频(仿写文案用)。逐行 busy。
  const [dlBusy, setDlBusy] = useState<string>('');
  // 平台中文名 → 内置浏览器采集平台 id(边播边抓要用对的登录分区)。
  const SOURCE_TO_PLATFORM: Record<string, string> = { 抖音: 'douyin', 小红书: 'xiaohongshu', 快手: 'kuaishou', B站: 'bilibili' };
  // 两级下载:先 yt-dlp(快、B站/公开视频好使),下不了(需登录/反爬)转内置浏览器边播边抓。
  // 返回本地文件路径(供"提取文案"用),失败返回 null;quiet=true 时不弹成功 toast(串在仿写流程里)。
  const downloadVideoGetFile = async (url: string, title: string, source: string, quiet = false): Promise<string | null> => {
    if (!url) { studioToast.err('这条没有原视频链接'); return null; }
    const plat = SOURCE_TO_PLATFORM[source] ?? (collectTargets[0] as string) ?? 'douyin';
    // 抖音/小红书下载接口硬性要登录态 cookie——先把内置浏览器里已登录的会话导出成
    // cookie 文件,yt-dlp 带上它就能像登录用户一样直接下原视频(最可靠的一条路)。
    const cookieFile = (await exportBrowserCookies(plat, 'main')) ?? undefined;
    const r = await downloadStudioVideo(url, cookieFile);
    if (!('error' in r)) { if (!quiet) studioToast.ok(`已下载到:${r.file}(在 ${r.dir} 文件夹)`); return r.file; }
    studioToast.info('yt-dlp 下不了,改用内置浏览器边播边抓(浏览器会打开该视频)…');
    const grabbed = await grabVideoSrc({ platform: plat, account: 'main', url });
    if ('error' in grabbed) { studioToast.err(`下载失败:${grabbed.error}`); return null; }
    const saved = await downloadVideoByUrl(grabbed.mediaUrl, grabbed.referer, title);
    if ('error' in saved) { studioToast.err(`下载失败:${saved.error}`); return null; }
    if (!quiet) studioToast.ok(`已用内置浏览器抓取下载:${saved.file}(在 ${saved.dir} 文件夹)`);
    return saved.file;
  };
  // 【抖音仿写·一步到位】点一下 → ① 下载原视频 → ② 抽音频+ASR 提取口播文案 → ③ **自动进脚本页**,
  // 把【原视频 + 提取的口播文案】带到脚本页展示,并直接交 AI 按知识库/题库风格仿写成可开拍口播稿。
  // (2026-07-14 用户拍板:去掉中间弹窗确认和独立下载按钮,下载→直接到脚本环节。)
  const runExtractAndRewrite = async (hit: MediaTopicHit) => {
    if (!hit.url) { studioToast.err('这条没有原视频链接'); return; }
    setDlBusy(hit.url || hit.title);
    try {
      setBaokuanStatus('① 正在下载原视频(仿写要基于真实口播内容)…');
      const file = await downloadVideoGetFile(hit.url, hit.title, hit.account, true);
      if (!file) { setBaokuanStatus(''); return; }
      setBaokuanStatus('② 正在提取口播文案(抽音频 + 语音转写;长视频只取前 5 分钟,约半分钟,请稍候别关)…');
      const ex = await extractScriptFromVideo(file);
      setBaokuanStatus('');
      // "转写为空/纯音乐/无口播"不是真失败——这条视频本来就没口播,没法仿写口播稿。
      const emptyLike = 'error' in ex && /转写为空|纯音乐|无口播|无旁白|no valid speech|silence|静音/i.test(ex.error);
      if ('error' in ex && !emptyLike) { studioToast.err(`提取文案失败:${ex.error}`); return; }
      const transcript = 'error' in ex ? '' : ex.transcript.trim();
      if (!transcript) {
        studioToast.info('这条没提取到口播文案(多为纯音乐/画面文字型),换一条带旁白的爆款再试。');
        return;
      }
      // ③ 自动进脚本页:原视频 file + 口播文案 transcript 一并带过去,脚本页展示 + AI 仿写。
      if (onRewriteToScript) {
        studioToast.ok('已提取口播文案 ✓ 进入脚本页,正在按你的风格写一版可开拍的仿写稿…');
        onRewriteToScript(hit.title, transcript, hit.url, file);
      } else {
        // 非短视频台(无脚本页)兜底:直接交 AI 仿写。
        const plat = SOURCE_TO_PLATFORM[hit.account] ?? (collectTargets[0] as string) ?? 'douyin';
        studioToast.ok('正在交给 AI 仿写(保留爆点结构、换成你的表达)…');
        onAiFind(
          `请【仿写】下面这条爆款视频的口播文案:保留它的开场钩子、内容结构和爆点节奏,但换成全新的、`
          + `属于我自己账号的表达和案例,不要照抄原句。平台:${plat}。原标题:${hit.title}。\n\n【原口播文案】\n${transcript}`,
          toPicked([hit]),
        );
      }
    } finally {
      setDlBusy('');
    }
  };

  const [discoverySnapshots, setDiscoverySnapshots] = useState<MediaDiscoverySnapshot[]>([]);
  // 真抓爆款和飞书自动监控都从 SQLite 恢复。手动抓取按当前创作台/平台范围隔离；
  // 飞书监控作为独立来源常驻，二者不会互相覆盖。
  const [hits, setHits] = useState<MediaTopicHit[]>(() => (browserCollect ? [] : restored.hits));
  useEffect(() => {
    if (!browserCollect) return;
    let cancelled = false;
    const loadDiscoveries = () => void fetchStudioDiscoveries(platform).then((snapshots) => {
      if (cancelled || snapshots == null) return;
      setDiscoverySnapshots(snapshots);
      const manual = snapshots.find(
        (snapshot) => snapshot.source === 'manual-grab' && snapshot.scopeKey === baokuanPlatKey,
      );
      setCollectTier(manual?.tier ?? '');
    });
    loadDiscoveries();
    const timer = window.setInterval(loadDiscoveries, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [browserCollect, platform, baokuanPlatKey]);
  useEffect(() => {
    if (browserCollect) setHits(hitsFromDiscoverySnapshots(discoverySnapshots, baokuanPlatKey));
  }, [browserCollect, discoverySnapshots, baokuanPlatKey]);
  const currentDiscoverySnapshots = useMemo(
    () => visibleDiscoverySnapshots(discoverySnapshots, baokuanPlatKey),
    [discoverySnapshots, baokuanPlatKey],
  );
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
  // 「监控发现」= 两个来源的常驻爆款快照(☁️飞书自动监控 / ⚡真抓爆款),直接列进候选区。
  // 2026-08-22 客户要求:两个来源都要在「候选选题」里看得见、点得动,且互不覆盖;
  // 但不写进 media_topics 表——飞书一轮几十条,无条件入库几天就把精选候选池冲垮,
  // 且删掉下一轮又会回来。这里只做展示层合并:存为候选才真正入库。
  const monitorHits = useMemo(() => {
    const taken = new Set<string>();
    for (const t of topics) {
      if (t.url) taken.add(t.url);
      taken.add(t.title);
    }
    return hits.filter((h) => !taken.has(h.url || '') && !taken.has(h.title) && !savedHitUrls.has(h.url || h.title));
  }, [hits, topics, savedHitUrls]);

  // 「立即监控一次」(2026-08-22 客户要求:定时→手动,想监控时点一下)。跑完把新快照
  // 拉回来,飞书结果就出现在上面的「监控发现」里;不点就不花钱(定时那份成本可省)。
  const [monitorBusy, setMonitorBusy] = useState(false);
  async function runMonitorNow() {
    if (monitorBusy) return;
    setMonitorBusy(true);
    studioToast.info('正在跑一轮监控…按「监控配置」里启用的关键词/账号采集,通常 1-3 分钟');
    try {
      const r = await runScheduledMonitorNow();
      if ('error' in r) {
        studioToast.err(`监控失败:${r.error.slice(0, 120)}`);
        return;
      }
      const snaps = await fetchStudioDiscoveries(platform);
      if (snaps) setDiscoverySnapshots(snaps);
      studioToast.ok('监控完成 ✓ 新结果已列在「候选选题 · 监控发现」里');
    } finally {
      setMonitorBusy(false);
    }
  }
  // 已用过默认折叠(2026-07-18 用户反馈:候选区顺序要贴操作逻辑,历史项别占视线)。
  const [showUsed, setShowUsed] = useState(false);

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

  async function saveHit(hit: MediaTopicHit): Promise<MediaTopic | null> {
    // 只有真存成功才标「已存」置灰(2026-07-20 审计撞出:此前无条件置灰,后端拒/网络错时
    // 假成功——候选没入库、按钮永久置灰且持久化到 localStorage,用户再也存不了这条)。
    const created = await onAdd({
      title: hit.title,
      source: hit.account,
      ...(hit.url ? { url: hit.url } : {}),
      heat: hit.signals.length === 2 ? '高' : '中',
      // 原素材随候选沉淀(2026-07-18):去创作时原文案/原图跟到创作区。
      ...(hit.sourceContent ? { sourceContent: hit.sourceContent } : {}),
      ...(hit.sourceImages && hit.sourceImages.length > 0 ? { sourceImages: hit.sourceImages } : {}),
    });
    if (created) {
      setSavedHitUrls((prev) => new Set(prev).add(hit.url || hit.title));
      studioToast.ok('已存为候选 ✓（下方「候选选题」可见）');
    } else {
      studioToast.err('存候选失败——请确认爆创后台在运行,稍后重试(这条没被占用,可再点)');
    }
    return created;
  }

  /** 监控发现行的「去创作」:先落成正式候选(拿到 topic),再直接进创作——省掉用户
   *  「先存候选、再回来点去创作」两步(2026-08-22 客户要求两个来源都能在候选区直接开工)。 */
  async function writeFromHit(hit: MediaTopicHit) {
    const created = await saveHit(hit);
    if (created) onWrite(created);
  }

  /** 链接 → 平台名(自动填「来源」)。 */
  function urlPlatformLabel(u: string): string {
    if (/douyin\.com|iesdouyin/i.test(u)) return '抖音';
    if (/xiaohongshu\.com|xhslink/i.test(u)) return '小红书';
    if (/kuaishou\.com|chenzhongtech/i.test(u)) return '快手';
    if (/bilibili\.com|b23\.tv/i.test(u)) return 'B站';
    if (/channels\.weixin|finder\.video/i.test(u)) return '视频号';
    if (/mp\.weixin\.qq\.com/i.test(u)) return '公众号';
    return '网页链接';
  }

  async function recognizeUrl() {
    const u = url.trim();
    if (!u) { studioToast.err('先粘贴原文链接再点识别'); return; }
    setRecognizeBusy(true);
    try {
      const r = await fetchSourceMaterial(u);
      if ('error' in r) {
        studioToast.err(`识别失败:${r.error}——可手动填标题后直接「添加」(链接会一并存进选题)`);
        return;
      }
      if (r.title.trim()) setTitle(r.title.trim());
      setSource(urlPlatformLabel(u));
      setFetchedMaterial({
        ...(r.text.trim() ? { sourceContent: r.text } : {}),
        ...(r.images.length > 0 ? { sourceImages: r.images } : {}),
      });
      const bits = [
        r.title.trim() ? '标题' : '',
        r.text.trim() ? `原文${r.text.replace(/\s+/g, '').length}字` : '',
        r.images.length > 0 ? `原图${r.images.length}张` : '',
      ].filter(Boolean);
      studioToast.ok(`已识别 ✓(${bits.join('/') || '仅链接'})——确认标题没问题就点「添加」`);
    } finally {
      setRecognizeBusy(false);
    }
  }

  async function submit() {
    if (!canAdd) return;
    // 存失败时【保留输入】并报错——旧写法无条件清空四个框,失败=内容丢了还零提示
    // (2026-08-04 审计;同文件 saveHit 已是正确范式)。
    const created = await onAdd({
      title: title.trim(),
      ...(angle.trim() ? { angle: angle.trim() } : {}),
      ...(source.trim() ? { source: source.trim() } : {}),
      ...(url.trim() ? { url: url.trim() } : {}),
      // 识别到的原文案/原图随选题沉淀——去创作时直接是洗稿原料(和「存为候选」同款语义)
      ...(fetchedMaterial?.sourceContent ? { sourceContent: fetchedMaterial.sourceContent } : {}),
      ...(fetchedMaterial?.sourceImages ? { sourceImages: fetchedMaterial.sourceImages } : {}),
    });
    if (!created) {
      studioToast.err('添加失败——确认爆创后台在运行;你填的内容已保留,可直接重试');
      return;
    }
    studioToast.ok('已加入候选 ✓(上方「候选选题」可见)');
    setTitle('');
    setAngle('');
    setSource('');
    setUrl('');
    setFetchedMaterial(null);
  }

  return (
    <>
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          {browserCollect ? `真抓爆款 · ${collectSource} 直采` : '找热点 · 组合选题雷达'}
          <span className={c('cardHint')}>
            {browserCollect
              ? `选平台 + 填方向 + 勾爆款筛选 → 点「真抓爆款」→ ${collectSource} 直采真实爆款(带粉丝/点赞/评论)、按标准评分列出,十几秒出`
              : aiOnly
                ? '数据源按需勾选组合（组合会被记住）——候选统一由「AI 帮我选题」产出'
                : '数据源按需勾选组合，不同行业用不同搭配（组合会被记住）'}
          </span>
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
        {browserCollect ? (
          <div className={c('row')}>
            <span className={c('cardHint')}>
              采集平台：{collectTargets.map((p) => (COLLECT_PLATFORM_LABEL[p] ?? p)).join('、') || '（请在上方选平台）'}
              {collectTargets.includes('channels')
                ? '（视频号走极致数据直采：按点赞热度筛爆款，无需登录；下载自动解密还原可播视频）'
                : '（TikHub 直采：秒出真实爆款，带粉丝/点赞/评论，无需登录/扫码；选哪个平台就只抓哪个）'}
            </span>
          </div>
        ) : null}
        {nativeFeed || tikhubTargets || browserCollect ? null : (
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
        {!tikhubTargets && !nativeFeed && !browserCollect && enabledFeeds.has('peers') ? (
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
                } else if (!browserCollect) void (tikhubTargets ? runTikhub('search') : runCombo());
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
          ) : browserCollect ? (
            <button
              type="button"
              className={`${c('btn')} ${c('btnPrimary')}`}
              disabled={collectBusy || !!collectMsg || !direction.trim()}
              title={`用 ${collectSource} 接口直采【当前选中平台】真实爆款(带粉丝/点赞/评论),按爆款筛选评分列出。十几秒出,不用开浏览器、不用登录/扫码。选哪个平台就只抓哪个。`}
              onClick={() => void runDirectCollect()}
            >
              <Icon name="sparkles" size={14} /> {collectBusy || collectMsg ? '采集评分中…' : `真抓爆款(${collectSource} 直采)`}
            </button>
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
              onClick={() => onAiFind((direction.trim() + (browserCollect ? buildRadarNote() : '')).trim(), pickedHits.size > 0 ? toPicked([...pickedHits.values()]) : undefined)}
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
        {/* 🎯 爆款筛选：短视频专属(时间窗+播放/点赞规则,喂给爆款雷达采集+评分)。文章台
            (公众号走极致了/知乎走登录态直取/微博走 TikHub)不是视频指标,不显示。 */}
        {browserCollect ? (
        <div className={c('row')} style={{ flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
          <span className={c('cardHint')}>🎯 爆款筛选：</span>
          <select
            className={c('input')}
            value={radarWindow}
            onChange={(e) => setRadarWindow(e.target.value as 'all' | '7d' | '30d' | '180d')}
            title="只看这个时间范围内发布的爆款"
            style={{ width: 'auto', minWidth: 96 }}
          >
            <option value="7d">近一周</option>
            <option value="30d">近30天</option>
            <option value="180d">近半年</option>
            <option value="all">不限时间</option>
          </select>
          <select
            className={c('input')}
            value={radarPages}
            onChange={(e) => setRadarPages(Number(e.target.value))}
            title="爬取页数——每页约 12 条候选。想多看爆款就多爬几页(会稍慢)"
            style={{ width: 'auto', minWidth: 72 }}
          >
            <option value={1}>1 页</option>
            <option value={2}>2 页</option>
            <option value={3}>3 页</option>
            <option value={4}>4 页</option>
          </select>
          {RADAR_RULES.map((r) => (
            <button
              key={r.key}
              type="button"
              className={`${c('chip')}${radarRules.has(r.key) ? ` ${c('chipBlue')}` : ''}`}
              style={{ cursor: 'pointer', border: 'none' }}
              title="可多选，命中任一即算爆款（灵活组合）"
              onClick={() => toggleRadarRule(r.key)}
            >
              {radarRules.has(r.key) ? '✓ ' : ''}{r.label}
            </button>
          ))}
          <span className={c('cardHint')} style={{ opacity: 0.6 }}>
            可多选,命中任一即算爆款
          </span>
          <span className={c('cardHint')} style={{ opacity: 0.55, width: '100%', fontSize: 11.5 }}>
            热度 = 播放与点赞取高值;抖音/视频号不公开播放量,按点赞算(快手/B站按播放算)。
            {collectTargets.includes('channels') ? '视频号是纯点赞,默认门槛已自动降到 2000。' : ''}
          </span>
        </div>
        ) : null}
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
        {collectMsg ? (
          <div style={{
            margin: '10px 0', padding: '12px 14px', borderRadius: 10,
            background: 'rgba(232,88,46,0.08)', border: '1px solid rgba(232,88,46,0.35)',
            color: '#e8582e', fontSize: 13.5, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 8,
          }}>
            <span style={{
              width: 14, height: 14, borderRadius: '50%', border: '2px solid rgba(232,88,46,0.35)',
              borderTopColor: '#e8582e', display: 'inline-block', animation: 'od-spin 0.8s linear infinite', flex: '0 0 auto',
            }} />
            {collectMsg}
            <span style={{ fontWeight: 400, opacity: 0.75 }}>（{collectSource} 直采+评分,约十几秒,请稍候）</span>
            <style>{'@keyframes od-spin{to{transform:rotate(360deg)}}'}</style>
          </div>
        ) : null}
        {browserCollect && currentDiscoverySnapshots.some((snapshot) => snapshot.items.length > 0) ? (
          <div className={c('notice')} style={{ marginBottom: 8 }}>
            常驻结果：{currentDiscoverySnapshots
              .filter((snapshot) => snapshot.items.length > 0)
              .map((snapshot) => `${snapshot.source === 'feishu-monitor' ? '飞书自动监控' : '真抓爆款'} ${snapshot.items.length} 条（${new Date(snapshot.updatedAt).toLocaleString()}）`)
              .join(' · ')}
          </div>
        ) : null}
        {hits.length > 0 && browserCollect && collectTier ? (
          <div className={c('notice')} style={{ marginBottom: 8 }}>
            智能降档:按 <b>【{collectTier}】</b> 档采到 {hits.length} 条
            {collectTier.includes('取头部') ? '（这个词没有明显爆款,已按互动取头部——可换更热的词或勾具体规则）' : '（自动找到能出货的最高档;想更严可在下方勾具体爆款规则）'}
          </div>
        ) : null}
        {hits.length > 0 ? (
          <table className={c('table')}>
            <thead>
              <tr>
                <th title="勾选=优先参考——AI 帮我选题时优先围绕勾选的文章深挖">选</th>
                <th>{browserCollect ? '抓取来源' : '信号'}</th>
                <th>标题</th>
                <th>{tikhubTargets ? '账号' : '公众号'}</th>
                <th>数据</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {hits.slice(0, 30).map((hit) => {
                const pickKey = hit.url || hit.title;
                const rowKey = browserCollect ? `${hit.discoverySource ?? 'unknown'}|${pickKey}` : pickKey;
                return (
                  <tr key={rowKey}>
                    <td>
                      <input
                        type="checkbox"
                        title="勾选为优先参考"
                        checked={pickedHits.has(pickKey)}
                        onChange={() => togglePick(hit)}
                      />
                    </td>
                    <td>{browserCollect
                      ? hit.discoverySource === 'feishu-monitor' ? '☁️ 飞书自动监控' : '⚡ 真抓爆款'
                      : signalTag(hit.signals)}</td>
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
                    <td style={{ whiteSpace: 'nowrap', color: browserCollect ? '#e8582e' : undefined, fontWeight: browserCollect ? 600 : undefined }}>
                      {browserCollect
                        ? [hit.readNum ? `播放${hit.readNum >= 10000 ? (hit.readNum / 10000).toFixed(1) + '万' : hit.readNum}` : '',
                           hit.zanNum ? `赞${hit.zanNum >= 10000 ? (hit.zanNum / 10000).toFixed(1) + '万' : hit.zanNum}` : '']
                            .filter(Boolean).join('·') || (hit.hot ?? '—')
                        : nativeFeed
                          // 知乎原生源:热度(detail_text)是主信号,优先展示。
                          ? (hit.hot ? hit.hot : hit.readNum ? `阅读 ${hit.readNum}` : '—')
                          // 公众号(爆文榜/极致了)等:列意=数据(阅读)。没有数据就显示「—」,
                          // 绝不回落正文/摘要凑数(2026-07-18 用户报:数据列全是正文很怪)。
                          : (hit.readNum ? `阅读 ${hit.readNum}` : hit.hot ? hit.hot : '—')}
                    </td>
                    <td className={c('tdActions')}>
                      {/* 短视频台(onRewriteToScript):下原视频→ASR→口播稿仿写。
                          图文笔记台(onExtractNote):下原图进图集+取原文案→仿写成新图文笔记。
                          其余(公众号等):AI 转题把原文转成差异化选题。 */}
                      {browserCollect && onRewriteToScript ? (
                        <button
                          type="button"
                          className={`${c('btn')} ${c('btnPrimary')}`}
                          disabled={aiBusy || dlBusy === (hit.url || hit.title)}
                          title="一步到位:下载原视频 → 提取口播文案 → 自动进「脚本」页(展示原视频+文案)→ 按你的知识库/题库风格 AI 仿写成可开拍口播稿"
                          onClick={() => void runExtractAndRewrite(hit)}
                        >
                          <Icon name="sparkles" size={13} /> {dlBusy === (hit.url || hit.title) ? '提取中…' : '提取文案仿写'}
                        </button>
                      ) : browserCollect && onExtractNote ? (
                        <button
                          type="button"
                          className={`${c('btn')} ${c('btnPrimary')}`}
                          disabled={aiBusy || !(hit.sourceImages && hit.sourceImages.length > 0)}
                          title={hit.sourceImages && hit.sourceImages.length > 0
                            ? '一步到位:下载原图进图集 + 取原文案 → 按你的知识库风格 AI 仿写成新图文笔记'
                            : '这条没带回图文内容(可能是视频/已删),换一条'}
                          onClick={() => onExtractNote(hit.title, hit.sourceContent || '', hit.sourceImages || [])}
                        >
                          <Icon name="sparkles" size={13} /> 提取图文仿写
                        </button>
                      ) : browserCollect ? null : (
                        // 统一创作台(StudioCreateView:browserCollect 但不传仿写回调)的爆款列表
                        // 只留「存为候选」,不出「AI 转题」(2026-07-20 用户拍板)。公众号/微博/知乎
                        // (非 browserCollect 的 aiOnly 台)照旧保留 AI 转题——那是它们唯一的逐条动作。
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={aiBusy}
                          title="AI 抓这篇原文分析后，转化出 1-2 个属于你账号的差异化选题进候选（不是照搬标题）"
                          onClick={() => onAiFind('', toPicked([hit]))}
                        >
                          <Icon name="sparkles" size={13} /> AI 转题
                        </button>
                      )}{' '}
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
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          候选选题（{candidates.length}{monitorHits.length > 0 ? ` + 监控发现 ${monitorHits.length}` : ''}）
          {browserCollect ? (
            <button
              type="button"
              className={c('btn')}
              style={{ float: 'right' }}
              disabled={monitorBusy}
              title="立刻跑一轮「监控配置」里启用的关键词/账号(按需付费,不点不花钱)"
              onClick={() => void runMonitorNow()}
            >
              {monitorBusy ? '监控中…' : '⟳ 立即监控一次'}
            </button>
          ) : null}
        </div>
        {candidates.length === 0 && monitorHits.length === 0 ? (
          <div className={c('empty')}>{aiOnly ? '还没有候选——填个方向，点「AI 帮我选题」，候选由 AI 结合热点产出。' : '还没有候选——用上面「真抓爆款」或「AI 帮我选题」产出;也可在下方手动添加。'}</div>
        ) : (
          <table className={c('table')}>
            <thead>
              <tr>
                <th>标题</th>
                <th>热度指标</th>
                <th>角度/理由</th>
                <th>原文</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {/* 监控发现(2026-08-22):飞书自动监控 + 真抓爆款的常驻结果直接列在候选区,
                  来源可辨、互不覆盖、可直接开工;点「去创作」会先自动落成正式候选。 */}
              {monitorHits.length > 0 ? (
                <tr>
                  <td colSpan={5} style={{ background: 'var(--od-surface-muted, #faf6f0)', fontSize: 12, color: '#8a7f74' }}>
                    监控发现（{monitorHits.length}）——采集到的爆款常驻在此,点「去创作」直接开写,或「存为候选」留着
                  </td>
                </tr>
              ) : null}
              {monitorHits.map((h) => (
                <tr key={`mh-${h.url || h.title}`}>
                  <td>
                    <span className={c('chip')} style={{ marginRight: 6 }}>
                      {h.discoverySource === 'feishu-monitor' ? '☁️ 飞书监控' : '⚡ 真抓'}
                    </span>
                    {h.title}
                  </td>
                  <td style={{ whiteSpace: 'nowrap', color: '#e8582e', fontWeight: 600 }}>
                    {h.readNum ? `阅读 ${h.readNum}` : h.hot || (h.signals.length >= 2 ? '⭐ 双高' : '—')}
                  </td>
                  <td>{h.desc ? h.desc.slice(0, 40) : '—'}</td>
                  <td>
                    {h.url ? (
                      <a
                        className={c('link')}
                        href={h.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => {
                          if (onOpenLink && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                            e.preventDefault();
                            onOpenLink(h.url);
                          }
                        }}
                      >
                        {h.account || '看原文 ↗'}
                      </a>
                    ) : (h.account || '—')}
                  </td>
                  <td className={c('tdActions')}>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void writeFromHit(h)}>
                      去创作
                    </button>{' '}
                    <button type="button" className={c('btn')} onClick={() => void saveHit(h)}>
                      存为候选
                    </button>
                  </td>
                </tr>
              ))}
              {candidates.map((t) => (
                <Fragment key={t.id}>
                <tr>
                  <td>{t.title}</td>
                  <td style={{ whiteSpace: 'nowrap', color: '#e8582e', fontWeight: 600 }}>{t.heat || '—'}</td>
                  <td>{t.angle || '—'}</td>
                  <td>
                    {t.url ? (
                      <a
                        className={c('link')}
                        href={t.url}
                        target="_blank"
                        rel="noreferrer"
                        title="点开原文（短视频可看原视频真实点赞/评论）"
                        onClick={(e) => {
                          if (onOpenLink && e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
                            e.preventDefault();
                            onOpenLink(t.url!);
                          }
                        }}
                      >
                        {t.source || '点击看原文 ↗'}
                      </a>
                    ) : (
                      t.source || '—'
                    )}
                  </td>
                  <td className={c('tdActions')}>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => onWrite(t)}>
                      去创作
                    </button>{' '}
                    <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void onDelete(t.id)}>
                      删除
                    </button>
                  </td>
                </tr>
                {/* 行内展开(点「去写作」后就在本行正下方,视线零移动)。 */}
                {renderTopicExpansion && expandedTopicId === t.id ? (
                  <tr key={`${t.id}-x`}>
                    <td colSpan={5} style={{ background: 'var(--od-surface-muted, #faf6f0)', borderLeft: '3px solid #e8582e' }}>
                      {renderTopicExpansion(t)}
                    </td>
                  </tr>
                ) : null}
                </Fragment>
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
          <button type="button" className={c('cardLabel')} style={{ background: 'none', border: 0, padding: 0, cursor: 'pointer', width: '100%', textAlign: 'left' }} onClick={() => setShowUsed((v) => !v)}>
            已用过（{used.length}）{showUsed ? ' ▾ 收起' : ' ▸ 展开'}
          </button>
          {showUsed ? (
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
          ) : null}
        </div>
      ) : null}
      {/* 手动添加(低频,垫底;2026-07-18 用户反馈顺序不符操作逻辑:找题→候选→手动兜底) */}
      {aiOnly ? null : (
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          添加选题
          <span className={c('cardHint')}>最快:粘贴链接 → 点「识别」自动填标题/来源、带回原文案 → 点「添加」;也可纯手动记一个想法</span>
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={url}
            placeholder="粘贴原文链接（抖音/小红书/公众号/B站等）→ 点「识别」"
            onChange={(e) => { setUrl(e.target.value); setFetchedMaterial(null); }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void recognizeUrl();
            }}
          />
          <button type="button" className={c('btn')} disabled={recognizeBusy || !url.trim()} onClick={() => void recognizeUrl()}>
            {recognizeBusy ? '识别中…' : '识别'}
          </button>
        </div>
        <div className={c('row')}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={title}
            placeholder="选题标题（必填；点「识别」可自动填）"
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
            placeholder="切入角度（可选，AI 会按这个角度写）"
            onChange={(e) => setAngle(e.target.value)}
          />
          <input
            className={c('input')}
            style={{ width: 140 }}
            value={source}
            placeholder="来源（可选）"
            onChange={(e) => setSource(e.target.value)}
          />
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={!canAdd} onClick={() => void submit()}>
            添加
          </button>
        </div>
        {fetchedMaterial ? (
          <div className={c('cardHint')}>
            已带回原素材:{fetchedMaterial.sourceContent ? `原文 ${fetchedMaterial.sourceContent.replace(/\s+/g, '').length} 字` : ''}
            {fetchedMaterial.sourceContent && fetchedMaterial.sourceImages ? ' + ' : ''}
            {fetchedMaterial.sourceImages ? `原图 ${fetchedMaterial.sourceImages.length} 张` : ''}
            ——「添加」后随选题沉淀,去创作直接洗稿
          </div>
        ) : null}
      </div>
      )}
    </>
  );
}
