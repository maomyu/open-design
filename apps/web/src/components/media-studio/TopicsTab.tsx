// 选题导航（两个创作台共享）：手动候选 + 组合式选题雷达（数据源可勾选
// 组合：爆文榜/搜一搜/全库搜索/需求词/对标动态）+「AI 帮我选题」。
// 独立可用，也向写作/脚本步输送选题。
import { useEffect, useMemo, useState } from 'react';
import type { MediaTopic, MediaTopicHit, StudioCollectPlatform } from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  fetchAccountRank,
  searchTopicFeed,
  type RankedAccountRow,
  type TopicFeedKind,
  fetchTikhubFeed,
  createStudioCollect,
  waitStudioCollectDone,
  radarScoreCollected,
  downloadStudioVideo,
  downloadVideoByUrl,
  extractScriptFromVideo,
} from '../../providers/media-studio';
import { grabVideoSrc, exportBrowserCookies } from '../../runtime/browser-panes';
import { studioToast } from './StudioFeedback';
import { hasFeature, useLicense } from '../../state/license';
import styles from './MediaStudio.module.css';

// 真抓爆款结果的【模块级存储 + 事件】。采集时内置浏览器会切到前台采集页,导致选题页组件卸载;
// runDirectCollect 是独立 async 会跑完,但卸载后 setHits 失效。故把爆款结果写进模块存储 + 广播事件,
// 选题页(重新)挂载时读回来显示,不受卸载影响。
let latestBaokuanHits: MediaTopicHit[] = [];
const BAOKUAN_HITS_EVENT = 'od:baokuan-hits';
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
  /** 【提取文案仿写】拿到真实口播 transcript 后,直接建稿写一版可开拍的仿写口播稿(短视频台)。
   *  没传(如公众号)则回退到 onAiFind('topics') 老路。 */
  onRewriteToScript?: (title: string, transcript: string, sourceUrl: string) => void;
  aiBusy: boolean;
  /** TikHub 平台分流模式(短视频台,2026-07-09 用户拍板):选题数据按目标
   *  平台走它自己的接口(抖音↔抖音、小红书↔小红书、快手↔快手),传了此
   *  prop 数据源区渲染平台 chips+热榜/搜索,不再是大家来(公众号生态)五源。 */
  tikhubTargets?: Array<{ id: 'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo'; label: string }>;
  /** 内置浏览器采集模式(短视频台:抖音/小红书/B站/快手)：选题数据【只】从平台内置浏览器
   *  采集而来(AI找选题→爆款雷达→内置浏览器)。传了此 prop:既不显示 TikHub 也不显示大家来
   *  (极致数据/公众号生态)五源——极致数据只服务公众号/视频号,不该出现在短视频台。 */
  browserCollect?: boolean;
  /** 真抓爆款要采的平台(内置浏览器)。只采【当前选中平台】——选抖音就只抓抖音。
   *  支持 douyin/xiaohongshu/kuaishou/bilibili;视频号(tencent)不能浏览器采集→传空数组。 */
  collectPlatforms?: string[];
}

export function TopicsTab({ platform, aiOnly = false, topics, onAdd, onDelete, onWrite, onAiFind, onRewriteToScript, aiBusy, tikhubTargets, browserCollect = false, collectPlatforms }: TopicsTabProps): JSX.Element {
  const license = useLicense();
  const [title, setTitle] = useState('');
  const [angle, setAngle] = useState('');
  const [source, setSource] = useState('');
  const [url, setUrl] = useState('');
  const [direction, setDirection] = useState('');
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
  const RADAR_RULES: Array<{ key: string; label: string; rule: Record<string, number> }> = [
    { key: 'lowfan', label: '低粉爆款(粉丝≤3000·播放≥10万)', rule: { fans_max: 3000, plays_min: 100000 } },
    { key: 'bigplay', label: '高播放大爆(播放≥300万)', rule: { plays_min: 3000000 } },
    { key: 'highlike', label: '高赞(点赞≥5万)', rule: { likes_min: 50000 } },
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
    return { time_window: radarWindow, rules };
  };

  // ── 真抓爆款·直接采集(纯可视化,不经 AI 智能体)：点一下 → 内置浏览器【当前选中平台】可见
  //    采集 → 引擎按爆款筛选评分 → 选题候选直接进「候选选题」表。选抖音就只抓抖音。 ──
  const collectTargets = collectPlatforms ?? ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili'];
  const [collectBusy, setCollectBusy] = useState(false);
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
    if (collectTargets.length === 0) { studioToast.err('该平台不支持内置浏览器采集(如视频号)——请选抖音/小红书/快手/B站'); return; }
    setCollectBusy(true);
    try {
      const names = collectTargets.map((p) => ({ douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', bilibili: 'B站' }[p] ?? p)).join('、');
      setBaokuanStatus(`正在打开内置浏览器采集【${names}】,像人一样搜索…(浏览器会切到前台,可看着它搜)`);
      const created = await createStudioCollect({
        keyword: kw,
        platforms: collectTargets as StudioCollectPlatform[],
        pages: 1,
        per: 10,
        timeWindow: radarWindow,
        order: 'hot',
      });
      if ('error' in created) { setBaokuanStatus(''); studioToast.err(created.error); return; }
      const job = await waitStudioCollectDone(created.jobId);
      if (!job || job.status === 'error') { setBaokuanStatus(''); studioToast.err('采集失败,请重试(桌面端需在运行)'); return; }
      const items: Record<string, unknown[]> = {};
      let total = 0;
      for (const r of job.results ?? []) {
        if (r.items?.length) { items[r.platform] = r.items; total += r.items.length; }
      }
      if (total === 0) {
        setBaokuanStatus('');
        studioToast.err('没采到内容——可能需要在该平台标签里登录/过验证码后重试(浏览器已在前台)');
        return;
      }
      setBaokuanStatus(`采到 ${total} 条,正在按爆款筛选评分…`);
      const scored = await radarScoreCollected(kw, items, buildCriteria());
      if ('error' in scored) { studioToast.err(scored.error); return; }
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
          desc: `${String(t['评分理由'] ?? '')}${Number(t['评论']) ? ` · 评论${t['评论']}` : ''}`,
        }));
      // 写模块存储 + 广播:即使采集把选题页卸载过,重新挂载也能读到这批爆款。
      latestBaokuanHits = hitList;
      window.dispatchEvent(new CustomEvent<MediaTopicHit[]>(BAOKUAN_HITS_EVENT, { detail: hitList }));
      setHits(hitList);
      setBaokuanStatus('');
      if (hitList.length === 0) {
        studioToast.info(`采到 ${total} 条,但没有符合「爆款筛选」的爆款。放宽标准(降低门槛/勾更多规则/换「不限时间」)或换关键词再试。`);
      } else {
        studioToast.ok(`真抓到 ${hitList.length} 个爆款,已列在下面(带链接·点赞)。勾选想做的,再点「AI 帮我选题」生成候选选题。`);
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
  const downloadVideoTwoStage = async (url: string, title: string, source: string, busyKey: string) => {
    setDlBusy(busyKey);
    try { studioToast.info('正在下载原视频(yt-dlp,大视频稍慢)…'); await downloadVideoGetFile(url, title, source); }
    finally { setDlBusy(''); }
  };
  const runDownloadVideo = (t: MediaTopic) => void downloadVideoTwoStage(t.url, t.title, t.source, t.id);
  const runDownloadHit = (hit: MediaTopicHit) => void downloadVideoTwoStage(hit.url, hit.title, hit.account, hit.url || hit.title);

  // 【抖音仿写三步·可视化】① 下载原视频 → ② 抽音频+ASR 提取口播文案 → ③ 把原文案交 AI 仿写。
  // 每步用醒目进度横幅(模块级状态,切页不丢)显示,让用户看得见在做什么。
  const runExtractAndRewrite = async (hit: MediaTopicHit) => {
    if (!hit.url) { studioToast.err('这条没有原视频链接'); return; }
    setDlBusy(hit.url || hit.title);
    try {
      const plat = SOURCE_TO_PLATFORM[hit.account] ?? (collectTargets[0] as string) ?? 'douyin';
      setBaokuanStatus('仿写第①步 · 正在下载原视频(仿写要基于真实口播内容)…');
      const file = await downloadVideoGetFile(hit.url, hit.title, hit.account, true);
      if (!file) { setBaokuanStatus(''); return; }
      setBaokuanStatus('仿写第②步 · 正在提取口播文案(抽音频 + 语音转写,约半分钟)…');
      const ex = await extractScriptFromVideo(file);
      if ('error' in ex) { setBaokuanStatus(''); studioToast.err(`提取文案失败:${ex.error}`); return; }
      const transcript = ex.transcript.trim();
      setBaokuanStatus('');
      if (!transcript) { studioToast.info('这条没提取到口播文案(可能是纯音乐/画面无旁白),换一条带口播的爆款试试。'); return; }
      // 第③步:直接产出【可开拍的仿写口播稿】(用户拍板:一步到位,不绕选题池)。
      // 短视频台走 onRewriteToScript(建稿→跑 script 任务→切脚本区看成文);
      // 无此回调的场景(公众号等)回退到 onAiFind('topics') 老路。
      if (onRewriteToScript) {
        studioToast.ok('已提取原口播文案 ✓ 正在直接写一版可开拍的仿写口播稿…');
        onRewriteToScript(hit.title, transcript, hit.url);
      } else {
        studioToast.ok('已提取原口播文案 ✓ 正在交给 AI 仿写(保留爆点结构、换成你的表达)…');
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

  const [hits, setHits] = useState<MediaTopicHit[]>(() => (browserCollect ? latestBaokuanHits : []));
  // 真抓爆款结果:挂载即从模块存储读回(采集期间本组件可能被卸载过),并监听广播实时更新。
  useEffect(() => {
    if (!browserCollect) return;
    if (latestBaokuanHits.length) setHits(latestBaokuanHits);
    const onHits = (ev: Event) => setHits((ev as CustomEvent<MediaTopicHit[]>).detail);
    window.addEventListener(BAOKUAN_HITS_EVENT, onHits);
    return () => window.removeEventListener(BAOKUAN_HITS_EVENT, onHits);
  }, [browserCollect]);
  const [feedBusy, setFeedBusy] = useState(false);
  const [feedNotice, setFeedNotice] = useState<string | null>(null);
  const [savedHitUrls, setSavedHitUrls] = useState<Set<string>>(() => new Set());
  const [enabledFeeds, setEnabledFeeds] = useState<Set<TopicFeedKind>>(loadEnabledFeeds);
  const [peers, setPeers] = useState(() => window.localStorage.getItem(PEERS_STORE_KEY) ?? '');
  const [sugWords, setSugWords] = useState<string[]>([]);
  // 多选优先参考：勾选的文章喂给「AI 帮我选题」优先深挖（跨多轮搜索保留）。
  const [pickedHits, setPickedHits] = useState<Map<string, MediaTopicHit>>(() => new Map());
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
          {browserCollect ? '真抓爆款 · 内置浏览器采集' : '找热点 · 组合选题雷达'}
          <span className={c('cardHint')}>
            {browserCollect
              ? '选平台 + 填方向 + 勾爆款筛选 → 点「真抓爆款」→ 内置浏览器逐条抓真实爆款、按标准评分列出'
              : aiOnly
                ? '数据源按需勾选组合（组合会被记住）——候选统一由「AI 帮我选题」产出'
                : '数据源按需勾选组合，不同行业用不同搭配（组合会被记住）'}
          </span>
        </div>
        {tikhubTargets ? (
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
              采集平台：{collectTargets.map((p) => ({ douyin: '抖音', xiaohongshu: '小红书', kuaishou: '快手', bilibili: 'B站' }[p] ?? p)).join('、') || '（请在上方选平台）'}
              {'（只从该平台的内置浏览器真实采集，不用 TikHub / 极致数据；选哪个平台就只抓哪个）'}
            </span>
          </div>
        ) : null}
        {tikhubTargets || browserCollect ? null : (
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
        {!tikhubTargets && !browserCollect && enabledFeeds.has('peers') ? (
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
              if (e.key === 'Enter' && !feedBusy && !browserCollect) void (tikhubTargets ? runTikhub('search') : runCombo());
            }}
          />
          {tikhubTargets ? (
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
              title="用内置浏览器在【当前选中平台】真人式搜索采集(前台可见)→ 引擎按爆款筛选评分 → 选题候选进表。选哪个平台就只抓哪个,不经 AI、不用 TikHub。"
              onClick={() => void runDirectCollect()}
            >
              <Icon name="sparkles" size={14} /> {collectBusy || collectMsg ? '采集评分中…' : '真抓爆款(内置浏览器)'}
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
              onClick={() => onAiFind((direction.trim() + buildRadarNote()).trim(), pickedHits.size > 0 ? toPicked([...pickedHits.values()]) : undefined)}
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
        {/* 🎯 爆款筛选：时间窗 + 可组合的爆款规则（喂给「AI 帮我选题」的爆款雷达采集+评分） */}
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
            选好后点「AI 帮我选题」→ 按此翻页采集+评分
          </span>
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
            <span style={{ fontWeight: 400, opacity: 0.75 }}>（采集+评分约 1-2 分钟,浏览器会切到前台采集,请稍候不要关闭）</span>
            <style>{'@keyframes od-spin{to{transform:rotate(360deg)}}'}</style>
          </div>
        ) : null}
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
                        <a className={c('link')} href={hit.url} target="_blank" rel="noreferrer">
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
                        : (hit.readNum ? `阅读 ${hit.readNum}` : hit.desc ? hit.desc.slice(0, 24) : '—')}
                    </td>
                    <td className={c('tdActions')}>
                      {browserCollect ? (
                        <button
                          type="button"
                          className={`${c('btn')} ${c('btnPrimary')}`}
                          disabled={aiBusy || dlBusy === (hit.url || hit.title)}
                          title="下载原视频 → 提取口播文案 → AI 仿写(保留爆点结构、换成你的表达)。三步有进度提示。"
                          onClick={() => void runExtractAndRewrite(hit)}
                        >
                          <Icon name="sparkles" size={13} /> {dlBusy === (hit.url || hit.title) ? '仿写中…' : '提取文案仿写'}
                        </button>
                      ) : (
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
                      {browserCollect && hit.url ? (
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={dlBusy === (hit.url || hit.title)}
                          title="下载这条爆款的原视频到本地(仿写文案用)"
                          onClick={() => runDownloadHit(hit)}
                        >
                          {dlBusy === (hit.url || hit.title) ? '下载中…' : '下载视频'}
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
                <th>热度指标</th>
                <th>角度/理由</th>
                <th>原文</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {candidates.map((t) => (
                <tr key={t.id}>
                  <td>{t.title}</td>
                  <td style={{ whiteSpace: 'nowrap', color: '#e8582e', fontWeight: 600 }}>{t.heat || '—'}</td>
                  <td>{t.angle || '—'}</td>
                  <td>
                    {t.url ? (
                      <a className={c('link')} href={t.url} target="_blank" rel="noreferrer" title="点开看原视频的真实点赞/评论">
                        点击看原文 ↗
                      </a>
                    ) : (
                      t.source || '—'
                    )}
                  </td>
                  <td className={c('tdActions')}>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => onWrite(t)}>
                      去写作
                    </button>{' '}
                    {t.url ? (
                      <>
                        <button type="button" className={c('btn')} disabled={dlBusy === t.id} title="用 yt-dlp 把原视频下载到本地,给仿写文案用" onClick={() => void runDownloadVideo(t)}>
                          {dlBusy === t.id ? '下载中…' : '下载视频'}
                        </button>{' '}
                      </>
                    ) : null}
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
