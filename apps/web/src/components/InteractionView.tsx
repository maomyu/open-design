// 互动运营（W8 的 UI 侧）：自动评论回复——维护关键词匹配规则 + 对一条笔记预览命中/一键真发。
// 与 od studio auto-reply / rules 同源同端点(UI/CLI 双轨)。读评论→匹配→拟人回复,受风控台账门控。
// 平台:小红书(W3/W4)+ 百度知道(W14,问题页回答下的评论);知乎/微博的评论执行适配在 W9/W10。
import { useCallback, useEffect, useState } from 'react';
import type { InteractionRule, AutoReplyResponse, RuleMatchMode, InteractionAction, InteractionReplyMode } from '@open-design/contracts';
import { Icon } from './Icon';
import { hasFeature, useLicense } from '../state/license';
import { fetchPlatformAccounts } from '../providers/daemon';
import {
  fetchInteractionRules,
  addInteractionRule,
  updateInteractionRuleReq,
  removeInteractionRule,
  runAutoReply,
  runAiReply,
  unfreezeAutoSend,
  readCommentsFast,
  genInteractionReplies,
  genOpeningComment,
  resolveXhsNoteUrl,
  fetchLoginStatus,
  type AiReplyDraft,
  fetchMyNotes,
  fetchStudioTopics,
  topicOriginPlatform,
  interactionTargetKind,
} from '../providers/media-studio';
import { studioToast, StudioToastHost } from './media-studio/StudioFeedback';
import { MonitorBoard } from './media-studio/MonitorBoard';
import styles from './media-studio/MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 互动支持的平台(注入器已接入的);按授权过滤后展示。 */
type InteractionFeature = 'note.xiaohongshu' | 'article.baidu-zhidao' | 'article.zhihu' | 'article.weibo';
const INTERACTION_PLATFORMS: Array<{ id: string; label: string; noteNoun: string; licensed: (has: (f: InteractionFeature) => boolean) => boolean }> = [
  { id: 'xiaohongshu', label: '小红书', noteNoun: '笔记', licensed: (has) => has('note.xiaohongshu') },
  { id: 'baidu-zhidao', label: '百度知道', noteNoun: '问题', licensed: (has) => has('article.baidu-zhidao') },
  { id: 'zhihu', label: '知乎', noteNoun: '回答', licensed: (has) => has('article.zhihu') },
  { id: 'weibo', label: '微博', noteNoun: '帖子', licensed: (has) => has('article.weibo') },
];

/**
 * 手动粘贴链接的提示语——【每个平台能读到评论的链接形态不一样】,写死"小红书笔记链接"会把用户
 * 引到错的形态上:知乎评论挂在【回答】下(只给 /question/{id} 读不到任何评论,只能发开场评论),
 * 微博要【帖子】页而不是 #话题# 搜索页。
 */
const MANUAL_LINK_HINT: Record<string, string> = {
  xiaohongshu: '手动粘贴小红书笔记链接(带 xsec_token 最稳);没勾笔记时用这条',
  'baidu-zhidao': '手动粘贴百度知道问题链接',
  zhihu: '手动粘贴知乎【回答】链接(/question/xxx/answer/xxx);只给问题链接读不到评论,会改发开场评论',
  weibo: '手动粘贴微博【帖子】链接(weibo.com/用户号/帖子号);#话题#搜索页不是帖子,读不到评论',
};

// AI 互动拟稿流的【模块级状态】——读评论会切到浏览器标签(本视图卸载),流程/草稿存这里,切回来不丢。
// 否则:aiDraft 在读评论时把本视图卸掉,拟完 setDrafts 落在已死的实例上,重挂载的视图什么都看不到
// (2026-07-21 用户反复报「点 AI 拟稿没有任何反馈」的根因)。同 TopicsTab 采集结果的持久化思路。
interface AiBox {
  busy: '' | 'draft' | 'send';
  progress: string;
  startedAt: number; // busy 开始时间戳,用于「卡死自愈」:超时后忽略持久的 busy(见 loadAiBox)
  persona: string;
  autoSend: boolean; // 自动直发开关:开=拟完直接发安全类(不逐条审核);持久,切页面/重开都记着
  autoSentComments: string[]; // 本会话已自动直发过的评论 id——再对同一批拟稿时排除,绝不重复回同一条(重复回评最招风控)
  frozenKey: string; // 撞过风控冻结的 `平台|账号`(daemon 侧当天冻结)——显示「解除冻结」横幅;解除/换天后清
  drafts: AiReplyDraft[] | null;
  draftState: Record<string, { text: string; on: boolean }>;
  noteRef: string;
}
const AI_BOX_KEY = 'od:interaction-ai-box';
const AI_BOX_EVENT = 'od:interaction-ai-box';
// busy 持久超过这个时长就当它卡死了(读评论切浏览器标签→本视图卸载,拟稿在死实例上跑;正常/报错都会
// setAiBusy('') 清掉,只有整条 promise 永不 resolve 才会残留)。给足读评论(135s)+拟稿的余量。
const AI_BUSY_STALE_MS = 240_000;
// 用 sessionStorage 存(实测模块级变量在本 app 切导航后不保真;sessionStorage 切页面/重挂载都在,关 app 才清)。
// 读评论会把本视图切到浏览器标签(卸载),拟稿流程/进度/草稿全存这里 → 切回来「AI 拟稿中…→草稿」连续可见、
// 按钮持续禁用防重复点。busy 带 startedAt 卡死自愈:超 AI_BUSY_STALE_MS 就忽略残留的 busy。
function loadAiBox(): AiBox {
  try {
    const s = sessionStorage.getItem(AI_BOX_KEY);
    if (s) {
      const b = JSON.parse(s) as Partial<AiBox>;
      const startedAt = typeof b.startedAt === 'number' ? b.startedAt : 0;
      const stale = !startedAt || Date.now() - startedAt > AI_BUSY_STALE_MS;
      const busy = stale ? '' : (b.busy ?? '');
      return {
        busy, progress: busy ? (b.progress ?? '') : '', startedAt: busy ? startedAt : 0,
        persona: b.persona ?? '', autoSend: b.autoSend !== false, autoSentComments: Array.isArray(b.autoSentComments) ? b.autoSentComments : [],
        frozenKey: b.frozenKey ?? '',
        drafts: b.drafts ?? null, draftState: b.draftState ?? {}, noteRef: b.noteRef ?? '',
      };
    }
  } catch { /* ignore */ }
  return { busy: '', progress: '', startedAt: 0, persona: '', autoSend: true, autoSentComments: [], frozenKey: '', drafts: null, draftState: {}, noteRef: '' };
}
const aiBox: AiBox = loadAiBox();
function setAiBox(patch: Partial<AiBox>): void {
  Object.assign(aiBox, patch);
  try {
    sessionStorage.setItem(AI_BOX_KEY, JSON.stringify({
      busy: aiBox.busy, progress: aiBox.progress, startedAt: aiBox.startedAt,
      persona: aiBox.persona, autoSend: aiBox.autoSend, autoSentComments: aiBox.autoSentComments,
      frozenKey: aiBox.frozenKey,
      drafts: aiBox.drafts, draftState: aiBox.draftState, noteRef: aiBox.noteRef,
    }));
  } catch { /* ignore */ }
  window.dispatchEvent(new CustomEvent(AI_BOX_EVENT));
}

// 自动直发的「安全正向」白名单——和服务端 SAFE_AUTO_REPLY_CATEGORIES 一致(服务端还会再兜底过一遍)。
// 只有这几类 + should_reply=true 才会自动外发;负面/水军/需人工/求链接一律不自动发,留人工手动。
const SAFE_AUTO_CATEGORIES = new Set(['夸赞', '提问', '共鸣', '开场']);
function pickSafeAutoCandidates(
  ds: AiReplyDraft[],
  max = 5,
  exclude?: Set<string>,
): Array<{ commentId: string; author?: string; text: string; category: string }> {
  return ds
    .filter((d) => d.should_reply && (d.reply || '').trim().length > 0 && SAFE_AUTO_CATEGORIES.has((d.category || '').trim()) && !(exclude?.has(d.id)))
    .slice()
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
    .slice(0, max)
    .map((d) => ({ commentId: d.id, text: d.reply, category: d.category, ...(d.author ? { author: d.author } : {}) }));
}

export function InteractionView(): JSX.Element {
  const license = useLicense();
  const platforms = INTERACTION_PLATFORMS.filter((p) => p.licensed((f) => hasFeature(license, f)));
  const [platform, setPlatform] = useState<string>(() => platforms[0]?.id ?? 'xiaohongshu');
  const PLATFORM = platforms.some((p) => p.id === platform) ? platform : (platforms[0]?.id ?? 'xiaohongshu');
  const platformDef = INTERACTION_PLATFORMS.find((p) => p.id === PLATFORM) ?? INTERACTION_PLATFORMS[0]!;
  const noteNoun = platformDef.noteNoun; // 笔记(小红书) / 问题(百度知道)
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  // 账号名 → 账号中心里存的人设。互动区不再要求重填语气:留空就自动用这份(daemon 侧兜底,
  // 所以 CLI 不带 --persona 也一样);这里只是把「正在用谁的人设」显示出来,别让人以为没生效。
  const [accountPersonas, setAccountPersonas] = useState<Record<string, string>>({});
  const [account, setAccount] = useState<string>('');
  const [rules, setRules] = useState<InteractionRule[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'live'>('');
  const [result, setResult] = useState<AutoReplyResponse | null>(null);
  // 折叠面板:健康看板/更多设置/关键词规则默认收起(互动不是重点、界面从简)。
  const [boardOpen, setBoardOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  // 以下 6 项走【模块级 aiBox】:读评论切浏览器标签会卸载本视图,拟稿流程/草稿存 box,切回来不丢。
  const [persona, setPersonaRaw] = useState(() => loadAiBox().persona);
  const [autoSend, setAutoSendRaw] = useState(() => loadAiBox().autoSend);
  const [drafts, setDraftsRaw] = useState<AiReplyDraft[] | null>(() => loadAiBox().drafts);
  const [draftState, setDraftStateRaw] = useState<Record<string, { text: string; on: boolean }>>(() => loadAiBox().draftState);
  const [aiBusy, setAiBusyRaw] = useState<'' | 'draft' | 'send'>(() => loadAiBox().busy);
  const [aiProgress, setAiProgressRaw] = useState(() => loadAiBox().progress);
  const [aiNoteRef, setAiNoteRefRaw] = useState(() => loadAiBox().noteRef);
  const [frozenKey, setFrozenKeyRaw] = useState(() => loadAiBox().frozenKey);
  // 从 sessionStorage 同步(拟稿流程/草稿/编辑/链接/人设全套)——读评论切浏览器标签卸载本视图后,
  // 拟稿在死实例上继续跑并写 box;切回来这里订阅 AI_BOX_EVENT 同步,「AI 拟稿中…→草稿」连续可见。
  useEffect(() => {
    const sync = (): void => {
      const b = loadAiBox();
      setPersonaRaw(b.persona); setDraftsRaw(b.drafts); setDraftStateRaw(b.draftState); setAiNoteRefRaw(b.noteRef);
      setAiBusyRaw(b.busy); setAiProgressRaw(b.progress); setAutoSendRaw(b.autoSend); setFrozenKeyRaw(b.frozenKey);
    };
    window.addEventListener(AI_BOX_EVENT, sync);
    return () => window.removeEventListener(AI_BOX_EVENT, sync);
  }, []);
  const setPersona = (v: string): void => { setPersonaRaw(v); setAiBox({ persona: v }); };
  const setFrozenKey = (v: string): void => { setFrozenKeyRaw(v); setAiBox({ frozenKey: v }); };
  const setAutoSend = (v: boolean): void => { setAutoSendRaw(v); setAiBox({ autoSend: v }); };
  const setDrafts = (v: AiReplyDraft[] | null): void => { setDraftsRaw(v); setAiBox({ drafts: v }); };
  // busy/progress 也持久化(带 startedAt 卡死自愈):切回视图能看到「AI 拟稿中…」而非空白,且按钮持续禁用防重复点。
  const setAiBusy = (v: '' | 'draft' | 'send'): void => {
    setAiBusyRaw(v);
    setAiBox(v ? { busy: v, startedAt: Date.now() } : { busy: '', progress: '', startedAt: 0 });
  };
  const setAiProgress = (v: string): void => { setAiProgressRaw(v); setAiBox({ progress: v }); };
  const setAiNoteRef = (v: string): void => { setAiNoteRefRaw(v); setAiBox({ noteRef: v }); };
  const setDraftState = (
    next:
      | Record<string, { text: string; on: boolean }>
      | ((s: Record<string, { text: string; on: boolean }>) => Record<string, { text: string; on: boolean }>),
  ): void => {
    const v = typeof next === 'function' ? next(loadAiBox().draftState) : next;
    setDraftStateRaw(v);
    setAiBox({ draftState: v });
  };

  // 笔记/问题选择器(免手动贴链接):来源下拉「我的笔记 / 采集池」+ 点选即填 note。
  // 「我的笔记」抓取仅小红书有(主页笔记);百度知道只有「采集池」(检索到的问题)。
  // 默认「采集池」:进互动就看到刚采集的爆款笔记(接口秒读、不触发慢抓取)。想回自己笔记再切「我的笔记」。
  const [noteSource, setNoteSource] = useState<'mine' | 'pool'>('pool');
  const effectiveNoteSource = PLATFORM === 'xiaohongshu' ? noteSource : 'pool';
  const [noteOptions, setNoteOptions] = useState<Array<{ title: string; url: string; meta?: string }>>([]);
  const [notesBusy, setNotesBusy] = useState(false);
  // 多选笔记 → 批量自动直发(每篇少发几条、逐篇处理):避免"一篇笔记回一堆"太像机器人,改成"多篇各回一两条"。
  const [selectedNotes, setSelectedNotes] = useState<Set<string>>(new Set());
  const toggleSelectedNote = (url: string): void =>
    setSelectedNotes((s) => { const n = new Set(s); if (n.has(url)) n.delete(url); else n.add(url); return n; });

  const loadNotes = useCallback(async (src: 'mine' | 'pool') => {
    setNotesBusy(true);
    setNoteOptions([]);
    if (src === 'mine' && PLATFORM === 'xiaohongshu') {
      const r = await fetchMyNotes(PLATFORM, account || null);
      setNotesBusy(false);
      if ('error' in r) { studioToast.err(r.error); return; }
      if (r.needsLogin) { studioToast.err('未登录:去「账号」页扫码登录小红书后重试'); return; }
      setNoteOptions(r.notes.map((n) => ({ title: n.title, url: n.url, ...(n.likeText ? { meta: `♡ ${n.likeText}` } : {}) })));
      if (r.notes.length === 0) studioToast.err('没抓到已发笔记(可能主页还没笔记,或需在浏览器里滚动加载)');
    } else {
      // 采集池:选题里带链接的本平台内容(小红书=爆款笔记;百度知道=问题;知乎/微博=文章台选题)。
      // 各平台选题池 key:小红书爆款在 short-video 池;文章类平台各用自己的 platform 池。
      const pool = PLATFORM === 'xiaohongshu' ? 'short-video' : PLATFORM;
      const topics = (await fetchStudioTopics(pool)) ?? [];
      setNotesBusy(false);
      // 按【互动可用性】筛选与排序:同一平台的选题来源产出的链接不是一回事(知乎热榜给问题页、
      // 搜知乎才给回答页、AI 选题可能没真链接;微博热榜给的是 #话题# 搜索页)。搜索页/话题页这类
      // 根本不是一条内容的直接不进列表;能读评论的排前面;读不到评论的明确标注「只能发开场评论」,
      // 免得用户以为是坏了(2026-08-04 用户反馈「知乎采集池不对」)。
      const opts = topics
        .map((t) => ({ t, kind: interactionTargetKind(PLATFORM, t.url) }))
        .filter((x) => x.kind !== 'unusable')
        .sort((a, b) => (a.kind === b.kind ? 0 : a.kind === 'commentable' ? -1 : 1))
        .map(({ t, kind }) => ({
          title: t.title,
          url: t.url,
          ...(kind === 'opening-only'
            ? { meta: t.heat ? `${t.heat} · 只能发开场评论` : '只能发开场评论' }
            : t.heat
              ? { meta: t.heat }
              : {}),
        }));
      setNoteOptions(opts);
      if (opts.length === 0) {
        // 「池子里一条都没有」和「有内容但都不是能互动的链接」是两回事,提示要分开说,
        // 否则用户对着满是选题的池子被告知"暂无内容",只会更懵。
        const samePlatform = topics.filter((t) => t.url && topicOriginPlatform(t.url) === PLATFORM).length;
        const hint = samePlatform > 0
          ? `采集池里的 ${samePlatform} 条${platformDef.label}选题都不是可互动的链接（多为搜索页/话题页）——${
              PLATFORM === 'zhihu' ? '去「文章→知乎→选题」用「搜知乎」采集,出的是可评论的回答页' : '换个来源重新采集'
            };也可在下面手动粘贴链接`
          : PLATFORM === 'baidu-zhidao'
          ? '采集池里暂无百度知道问题——先去「文章→百度知道→选题」搜相关问题'
          : PLATFORM === 'xiaohongshu'
          ? '采集池里暂无小红书笔记——先去创作台采集爆款'
          : `采集池里暂无${platformDef.label}内容——先去「文章→${platformDef.label}→选题」找热点;也可在下面手动粘贴链接`;
        studioToast.err(hint);
      }
    }
  }, [account, PLATFORM, platformDef.label]);

  // 新增规则表单。
  const [rName, setRName] = useState('');
  const [rKw, setRKw] = useState('');
  const [rReply, setRReply] = useState('');
  const [rMode, setRMode] = useState<RuleMatchMode>('contains');
  const [rAction, setRAction] = useState<InteractionAction>('reply');
  // 命中后套死模板,还是把这段话当【意图】交给 AI 现写。同一条模板刷屏最容易被判机器人,
  // 所以给旧的关键词玩法留一条"关键词挑人 + AI 说话"的路。
  const [rReplyMode, setRReplyMode] = useState<InteractionReplyMode>('template');
  const [rPriority, setRPriority] = useState('0');

  const refreshRules = useCallback(async () => {
    setRules(await fetchInteractionRules(PLATFORM, account || null));
  }, [account]);

  // 切平台重拉账号(各平台账号独立);顺带清掉上个平台的选中笔记/结果。
  useEffect(() => {
    void fetchPlatformAccounts().then((resp) => {
      const plat = resp?.platforms.find((p) => p.id === PLATFORM);
      const list = (plat?.accounts ?? []).map((a) => ({ id: a.id, name: a.name }));
      setAccounts(list);
      setAccount(list[0]?.name ?? '');
      const personas: Record<string, string> = {};
      for (const a of plat?.accounts ?? []) {
        const p = (a.style?.persona ?? '').trim();
        if (p) personas[a.name] = p;
      }
      setAccountPersonas(personas);
    });
    setNote(''); setNoteOptions([]); setResult(null); setSelectedNotes(new Set());
    // 进互动/换平台就自动把「采集池」的笔记拉出来(接口秒读、无需登录、不触发慢抓取),别让用户对着空列表找。
    // 「我的笔记」走内置浏览器慢抓取,不自动拉,留给用户点「拉取/刷新」。
    const eff = PLATFORM === 'xiaohongshu' ? noteSource : 'pool';
    if (eff === 'pool') void loadNotes('pool');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [PLATFORM]);

  useEffect(() => { void refreshRules(); }, [refreshRules]);

  async function preview(): Promise<void> {
    if (!note.trim()) { studioToast.err(`先填一条${noteNoun}链接`); return; }
    setBusy('preview'); setResult(null);
    const r = await runAutoReply({ platform: PLATFORM, account: account || null, noteRef: note.trim(), dryRun: true });
    setBusy('');
    if ('error' in r) { studioToast.err(r.error); return; }
    setResult(r);
    if (r.needsLogin) studioToast.err(`未登录:去「账号」页登录${platformDef.label}后重试`);
    else studioToast.ok(`读到 ${r.read} 条评论,命中 ${r.matched.length} 条规则(预览,未外发)`);
  }

  async function runLive(): Promise<void> {
    if (!note.trim()) { studioToast.err(`先填一条${noteNoun}链接`); return; }
    const n = result?.matched.length ?? 0;
    const ok = window.confirm(
      `将真的在「${account || '默认账号'}」下,对这条${noteNoun}里命中规则的评论发出回复(最多 3 条,逐条过风控)。\n` +
      `${n ? `当前预览命中 ${n} 条。` : ''}这是外发公开评论,确定继续?`,
    );
    if (!ok) return;
    setBusy('live'); setResult(null);
    const r = await runAutoReply({ platform: PLATFORM, account: account || null, noteRef: note.trim(), dryRun: false, maxReplies: 3 });
    setBusy('');
    if ('error' in r) { studioToast.err(r.error); return; }
    setResult(r);
    if (r.needsLogin) { studioToast.err(`未登录:去「账号」页登录${platformDef.label}后重试`); return; }
    const sent = r.dispatched.filter((d) => d.jobId).length;
    const blocked = r.dispatched.filter((d) => d.blocked).length;
    studioToast.ok(`已派发 ${sent} 条回复${blocked ? `;${blocked} 条被风控拦` : ''}(在下方浏览器标签看拟人回复)`);
  }

  // 每篇只发 1 条(风控第一位:一篇笔记别回一堆;想多回就多选几篇,摊到多篇更自然)。
  const PER_NOTE = 1;

  // 秒读评论 + 逐条拟稿(公用):TikHub 接口秒读 → 检测到的本地 CLI 逐条拟稿。并行现取发送用 token
  // (旧笔记缺 token 时真发要用;读评论不需 token,并行不拖慢)。返回草稿 + 发送用链接;读不到/出错返 null。
  async function readAndDraftNote(
    noteUrl: string,
    noteTitle: string,
  ): Promise<{ ds: AiReplyDraft[]; sendRef: string; note: { title?: string; content?: string } } | null> {
    const needToken = PLATFORM === 'xiaohongshu' && !/xsec_token=/.test(noteUrl);
    const [fast, sendRef] = await Promise.all([
      // withNote:顺带把【正文】取回来。只喂标题的话,AI 只能就着标题泛泛地回;开场评论更吃亏
      // ——没正文就是对着标题硬夸(手动粘的链接连标题都没有,gen-opening 会直接拒写)。
      readCommentsFast({ platform: PLATFORM, noteRef: noteUrl, withNote: true }),
      needToken ? resolveXhsNoteUrl(noteUrl) : Promise.resolve(noteUrl),
    ]);
    if ('error' in fast) { studioToast.err(fast.error); return null; }
    // 读评论失败(如 TikHub key 失效)≠ 这篇没人评论:如实报错并跳过——绝不能当成 0 评论去写
    // 开场评论,那会往别人正常有评论的笔记里丢一条莫名其妙的首评(2026-07-23「无法评论」事故:
    // key 失效被静默成 0 评论,批量空转、还误发过开场评论,用户完全看不到真因)。
    if (fast.detail) { studioToast.err(`「${noteTitle.slice(0, 12) || '笔记'}」读评论失败:${fast.detail}`); return null; }
    // 标题以【列表里那条】为准(用户看到的就是它),接口标题只在列表没标题时兜底(手动粘链接)。
    const note = { title: noteTitle.trim() || (fast.note?.title ?? ''), content: fast.note?.text ?? '' };
    if (fast.comments.length === 0) return { ds: [], sendRef, note };
    const r = await genInteractionReplies({ note, persona: persona.trim(), platform: PLATFORM, account: account || null, comments: fast.comments });
    if ('error' in r) { studioToast.err(r.error); return null; }
    const byId = new Map(fast.comments.map((c) => [c.id, c]));
    const ds = (r.results ?? []).map((d) => ({ ...d, author: byId.get(d.id)?.author ?? '', commentText: byId.get(d.id)?.text ?? '' }));
    return { ds, sendRef, note };
  }

  // 审核模式:读一篇 → 拟稿 → 展示逐条(勾选/改)→「真发选中的」。不外发。
  async function aiDraftOne(noteUrl: string, noteTitle: string): Promise<void> {
    setAiBusy('draft'); setDrafts(null); setDraftState({}); setResult(null); setAiNoteRef('');
    setAiProgress('读评论中…');
    const res = await readAndDraftNote(noteUrl, noteTitle);
    if (!res) { setAiProgress(''); setAiBusy(''); return; }
    setAiNoteRef(res.sendRef);
    if (res.ds.length === 0) {
      // 这篇还没人评论 → 写一条开场评论,当草稿给用户勾选/改后发(抢首评引流)。
      setAiProgress('没评论,写开场评论…');
      const op = await genOpeningComment({ note: res.note, persona: persona.trim(), platform: PLATFORM, account: account || null });
      setAiProgress(''); setAiBusy('');
      if (!('error' in op) && op.comment.trim()) {
        const opening: AiReplyDraft = { id: `opening-${noteUrl}`, should_reply: true, category: '开场', reply: op.comment.trim(), reason: '这篇还没人评论,发一条开场评论抢首评', confidence: 0.8, author: '', commentText: '(开场评论:给这篇笔记发首条评论)' };
        setDrafts([opening]);
        setDraftState({ [opening.id]: { text: opening.reply, on: true } });
        studioToast.ok('这篇还没评论——AI 写了一条开场评论,勾选/改后可发。');
      } else {
        studioToast.err('没读到评论,也没写出开场评论(可能是敏感笔记),换条试试');
      }
      return;
    }
    setAiProgress(''); setAiBusy('');
    setDrafts(res.ds);
    const st: Record<string, { text: string; on: boolean }> = {};
    for (const d of res.ds) st[d.id] = { text: d.reply, on: d.should_reply };
    setDraftState(st);
    studioToast.ok(`读到 ${res.ds.length} 条评论,AI 拟了 ${res.ds.filter((d) => d.should_reply).length} 条可回。勾选/改后真发。`);
  }

  // 直发模式:逐篇(秒读→拟稿→挑 1 条安全正向类)→ 交后台拟人节奏派发器。1..N 篇都走这条,每篇 1 条,摊开抗风控。
  async function batchAutoSendNotes(notes: Array<{ url: string; title?: string }>): Promise<void> {
    setAiBusy('draft'); setDrafts(null); setDraftState({}); setResult(null);
    // 直发前查登录:该账号明确「已掉线」时先给醒目提示(不硬拦——发送时若真撞登录墙,后台会把浏览器
    // 停在登录页、提醒扫码、登录后自动接着发;这里只是提前告知,免得用户以为"发出去了")。
    try {
      const acct = (account || '').trim();
      const recs = await fetchLoginStatus(PLATFORM);
      const rec = (acct ? recs.find((r) => r.account === acct) : undefined) ?? recs.find((r) => r.platform === PLATFORM);
      if (rec && rec.state === 'logged-out') {
        studioToast.err(`「${acct || '默认账号'}」在${platformDef.label}似乎已掉线——直发时会自动停在浏览器登录页等你扫码,登录后自动接着发。也可先去「账号」页登录再发。`);
      }
    } catch { /* 查登录失败不阻断:交给发送时的后台登录墙处置兜底 */ }
    const already = new Set(loadAiBox().autoSentComments);
    let totalQueued = 0;
    let notesWithSend = 0;
    let failed = 0;
    let skipped = 0; // AI 判无安全类/已回过/开场写不出而跳过的篇数——收尾如实报,不再静默(「勾了多条只发1个」要能看出原因)
    let done = 0;
    let frozen = false;
    for (const n of notes) {
      done += 1;
      const label = (n.title || '(无标题)').slice(0, 12);
      // 单篇 try/catch:某篇读评论/拟稿/派发抛异常,只跳过这篇、不整批卡死(不然第一篇后就"没反应")。
      try {
        setAiProgress(`直发 ${done}/${notes.length}「${label}」:读评论+拟稿…`);
        const res = await readAndDraftNote(n.url, n.title ?? '');
        if (!res) { failed += 1; continue; }
        let cands: Array<{ commentId: string; author?: string; text: string; category: string }>;
        if (res.ds.length === 0) {
          // 这篇还没人评论 → 写一条开场评论抢首评引流(每篇的开场只发一次,记进 already 防重复)。
          const openId = `opening-${n.url}`;
          if (already.has(openId)) { skipped += 1; continue; }
          setAiProgress(`直发 ${done}/${notes.length}「${label}」:没评论,写开场评论…`);
          const op = await genOpeningComment({ note: res.note, persona: persona.trim(), platform: PLATFORM, account: account || null });
          if ('error' in op || !op.comment.trim()) { skipped += 1; continue; }
          cands = [{ commentId: openId, text: op.comment.trim(), category: '开场' }];
        } else {
          cands = pickSafeAutoCandidates(res.ds, PER_NOTE, already);
        }
        if (cands.length === 0) { skipped += 1; continue; }
        cands.forEach((cc) => already.add(cc.commentId));
        const rr = await runAiReply({ platform: PLATFORM, account: account || null, noteRef: res.sendRef, autoSend: true, chosen: cands, maxReplies: PER_NOTE });
        if (!('error' in rr)) {
          // 当天已【确认】触发平台风控(后台派发器等过用户处理、重试仍被拦/等不到人)→ 已冻结,
          // 整批停(别再往下送笔记,连发只会加速封号)。用户完成验证后可点下方「解除冻结」。
          if (rr.frozen) { already.delete(cands[0]!.commentId); frozen = true; break; }
          totalQueued += ('autoQueued' in rr ? rr.autoQueued : undefined) ?? cands.length; notesWithSend += 1;
        }
        else { failed += 1; studioToast.err(`「${label}」派发失败:${rr.error}`); }
      } catch (err) {
        failed += 1;
        console.warn('[batch] 单篇直发出错,跳过', n.url, err);
      }
    }
    setAiBox({ autoSentComments: [...already].slice(-500) });
    setAiProgress(''); setAiBusy('');
    setSelectedNotes(new Set());
    // 触发风控冻结:整批已停,如实说清——这是最重要的安全提示,别被下面的常规文案盖过去。
    if (frozen) {
      setFrozenKey(`${PLATFORM}|${account || ''}`);
      studioToast.err(`已触发平台风控/验证且等待处理未恢复,自动直发已【整批停止】(${notesWithSend} 篇已排队)。请去浏览器标签人工完成验证,完成后点「解除冻结」可继续,或明天自动解冻;也可手动逐条发。`);
      return;
    }
    // 有失败要如实说,不能用「没有可自动直发的安全类」盖过去——那是结果,不是原因(2026-07-23 事故:
    // key 失效时用户只看到这句,以为没内容可发,实际是读评论全挂了)。
    if (totalQueued > 0) {
      const extras = [
        skipped ? `${skipped} 篇跳过(AI 判无安全类/已回过/开场没写出)` : '',
        failed ? `${failed} 篇失败` : '',
      ].filter(Boolean).join(';');
      studioToast.ok(`已排队直发 ${totalQueued} 条(${notesWithSend}/${notes.length} 篇、每篇 ${PER_NOTE} 条)${extras ? `;${extras}` : ''}。后台按拟人节奏陆续发,进度看健康看板「发/拦/败」。`);
    } else if (failed > 0) {
      studioToast.err(`${failed}/${notes.length} 篇读评论/拟稿/派发失败(原因见上面报错)${skipped ? `;${skipped} 篇跳过` : ''},一条都没发出去。`);
    } else {
      studioToast.ok(`选中的 ${notes.length} 篇里没有可自动直发的安全类(负面/水军/求链接不自动发;已回过的也不重复发)。`);
    }
  }

  // 用户已在浏览器人工完成平台验证后,手动解除当天的自动直发风控冻结。「验证完成」没有可靠的
  // 自动信号(滑块类验证不掉登录,探测探不出来),所以交还给人:谁完成了验证谁来点这一下。
  async function doUnfreeze(): Promise<void> {
    const r = await unfreezeAutoSend(PLATFORM, account || null);
    if ('error' in r) { studioToast.err(r.error); return; }
    setFrozenKey('');
    studioToast.ok('已解除冻结。确认平台验证已完成后再点直发(每条仍逐条过风控台账)。');
  }

  // 主按钮:勾选的笔记(没勾就用「更多设置」里粘的那条)→ 直发批量 或 审核单篇。
  async function runReply(): Promise<void> {
    const targets = selectedNotes.size > 0
      ? noteOptions.filter((o) => selectedNotes.has(o.url)).map((o) => ({ url: o.url, title: o.title }))
      : (note.trim() ? [{ url: note.trim(), title: noteOptions.find((o) => o.url === note.trim())?.title ?? '' }] : []);
    if (targets.length === 0) { studioToast.err(`先勾选笔记,或在「更多设置」里粘一条${noteNoun}链接`); return; }
    if (autoSend) {
      const ok = window.confirm(
        `将对 ${targets.length} 篇${noteNoun}各自动发 ${PER_NOTE} 条【安全正向类】回复(共 ~${targets.length * PER_NOTE} 条),后台拟人节奏陆续发、全程过风控台账。负面/水军/求链接不发。确定?`,
      );
      if (!ok) return;
      await batchAutoSendNotes(targets);
    } else {
      if (targets.length > 1) studioToast.ok('审核模式一次看一篇,正在看第一篇;要批量就切「直接发」');
      await aiDraftOne(targets[0]!.url, targets[0]!.title ?? '');
    }
  }

  async function aiSend(): Promise<void> {
    const chosen = (drafts ?? [])
      .filter((d) => draftState[d.id]?.on && (draftState[d.id]?.text ?? '').trim())
      .map((d) => ({ commentId: d.id, ...(d.author ? { author: d.author } : {}), text: draftState[d.id]!.text.trim() }));
    if (chosen.length === 0) { studioToast.err('先勾选至少一条要发的回复'); return; }
    const ok = window.confirm(
      `将真的在「${account || '默认账号'}」下,对这条${noteNoun}发出 ${chosen.length} 条 AI 回复(逐条过风控,最多 5 条)。这是外发公开评论,确定?`,
    );
    if (!ok) return;
    setAiBusy('send');
    // 真发用拟稿时那条(旧笔记已现取 token 的)链接——否则回复注入也会打不开笔记。
    const r = await runAiReply({ platform: PLATFORM, account: account || null, noteRef: aiNoteRef || note.trim(), dryRun: false, chosen, maxReplies: 5 });
    setAiBusy('');
    if ('error' in r) { studioToast.err(r.error); return; }
    const sent = (r.dispatched ?? []).filter((d) => d.jobId).length;
    const blocked = (r.dispatched ?? []).filter((d) => d.blocked).length;
    studioToast.ok(`已派发 ${sent} 条${blocked ? `;${blocked} 条被风控拦` : ''}(在下方浏览器标签看拟人回复)`);
  }

  async function addRule(): Promise<void> {
    const keywords = rKw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    if (!rName.trim() || !keywords.length || !rReply.trim()) {
      studioToast.err(rReplyMode === 'ai' ? '规则名/关键词/给 AI 的意图都要填' : '规则名/关键词/回复文案都要填');
      return;
    }
    const r = await addInteractionRule({
      platform: PLATFORM, accountId: account || null, name: rName.trim(), keywords,
      replyTemplate: rReply, replyMode: rReplyMode, matchMode: rMode, action: rAction, priority: Number(rPriority) || 0,
    });
    if ('error' in r) { studioToast.err(r.error); return; }
    setRName(''); setRKw(''); setRReply('');
    studioToast.ok('规则已加');
    void refreshRules();
  }

  async function toggleRule(rule: InteractionRule): Promise<void> {
    await updateInteractionRuleReq(rule.id, { enabled: !rule.enabled });
    void refreshRules();
  }
  async function delRule(id: string): Promise<void> {
    if (!window.confirm('删除这条规则?')) return;
    await removeInteractionRule(id);
    void refreshRules();
  }

  // 主按钮上要处理的篇数:勾选了几篇就几篇;没勾但「更多设置」里粘了一条,算 1 篇。
  const replyCount = selectedNotes.size || (note.trim() ? 1 : 0);
  const allNotesSelected = noteOptions.length > 0 && noteOptions.every((o) => selectedNotes.has(o.url));
  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>互动 · AI 回复评论</h1>
        <div className={c('row')} style={{ marginTop: 8, flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
          {platforms.length > 1
            ? platforms.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${c('chip')}${p.id === PLATFORM ? ` ${c('chipBlue')}` : ''}`}
                  style={{ cursor: 'pointer', border: 'none' }}
                  aria-pressed={p.id === PLATFORM}
                  onClick={() => setPlatform(p.id)}
                >
                  {p.label}
                </button>
              ))
            : null}
          <span className={c('cardHint')}>账号:</span>
          <select className={c('select')} value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.length === 0 ? <option value="">(去「账号」页登录{platformDef.label})</option> : null}
            {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
          <button type="button" className={c('btn')} style={{ marginLeft: 'auto', fontSize: 13 }} onClick={() => setBoardOpen((v) => !v)}>
            {boardOpen ? '▾' : '▸'} 健康看板
          </button>
        </div>
      </div>

      {/* 健康看板默认收起(互动不是重点);要看各号名额/今日战果再点开。 */}
      {boardOpen ? <MonitorBoard /> : null}

      {/* ── 主卡:AI 回复评论(勾选 1..N 篇 → 直发 或 审核) ── */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          AI 回复评论
          <span className={c('cardHint')}>勾选一篇或多篇 → AI 读评论逐条拟稿 → 直接发(每篇 {PER_NOTE} 条安全类)或先审核。摊到多篇、每篇少发,更抗风控。</span>
        </div>
        {/* 选笔记:来源切换 + 拉取。百度知道只有「采集池」(检索到的问题)。 */}
        <div className={c('row')} style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={c('cardHint')}>选{noteNoun}:</span>
          <select
            className={c('select')}
            value={effectiveNoteSource}
            disabled={PLATFORM !== 'xiaohongshu'}
            onChange={(e) => { const s = e.target.value as 'mine' | 'pool'; setNoteSource(s); void loadNotes(s); }}
          >
            {PLATFORM === 'xiaohongshu' ? <option value="mine">我的笔记(回复自己评论)</option> : null}
            <option value="pool">{PLATFORM === 'baidu-zhidao' ? '采集池(检索到的问题)' : '采集池(去别人爆款下引流)'}</option>
          </select>
          <button type="button" className={c('btn')} disabled={notesBusy} onClick={() => void loadNotes(effectiveNoteSource)}>
            <Icon name={notesBusy ? 'spinner' : 'refresh'} size={12} /> {notesBusy ? '抓取中…' : '拉取/刷新'}
          </button>
          {noteOptions.length > 0 ? (
            <button
              type="button"
              className={c('btn')}
              onClick={() => setSelectedNotes(allNotesSelected ? new Set() : new Set(noteOptions.map((o) => o.url)))}
            >
              {allNotesSelected ? '取消全选' : `全选（${noteOptions.length}）`}
            </button>
          ) : null}
        </div>
        {noteOptions.length > 0 ? (
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--od-border, #e5ded4)', borderRadius: 8, padding: 4, marginTop: 6 }}>
            {noteOptions.map((o) => (
              <label
                key={o.url}
                title={o.url}
                style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: 'pointer', background: selectedNotes.has(o.url) ? 'rgba(232,88,46,0.10)' : undefined }}
              >
                {/* 显式宽高:模块 CSS 里 input{width:100%} 会把 checkbox 撑到整行、把标题挤成 0 宽,内联覆盖掉。 */}
                <input type="checkbox" checked={selectedNotes.has(o.url)} onChange={() => toggleSelectedNote(o.url)} style={{ flex: '0 0 auto', width: 15, height: 15, margin: 0 }} />
                <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 14 }}>{o.title || '(无标题)'}</span>
                {o.meta ? <span className={c('cardHint')} style={{ flex: '0 0 auto' }}>{o.meta}</span> : null}
              </label>
            ))}
          </div>
        ) : (
          <div className={c('cardHint')} style={{ marginTop: 6 }}>点「拉取/刷新」加载{effectiveNoteSource === 'mine' ? '你的已发笔记' : PLATFORM === 'baidu-zhidao' ? '采集池里的问题' : '采集池笔记'};也可在下面手动粘贴链接。</div>
        )}
        {/* 动作条:先审核 / 直接发 二选一 + 主按钮(勾选 1..N 篇都走这个) */}
        <div className={c('row')} style={{ marginTop: 8, gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'inline-flex', border: '1px solid var(--od-border, #e5ded4)', borderRadius: 8, overflow: 'hidden', flex: '0 0 auto' }}>
            <button type="button" className={c('btn')} style={{ border: 'none', borderRadius: 0, ...(autoSend ? {} : { background: 'rgba(232,88,46,0.14)' }) }} aria-pressed={!autoSend} onClick={() => setAutoSend(false)}>先审核</button>
            <button type="button" className={c('btn')} style={{ border: 'none', borderRadius: 0, ...(autoSend ? { background: 'rgba(232,88,46,0.14)' } : {}) }} aria-pressed={autoSend} onClick={() => setAutoSend(true)}>直接发</button>
          </div>
          <span className={c('cardHint')} style={{ flex: 1, minWidth: 100 }}>{autoSend ? `只发共鸣/提问/夸赞,每篇 ${PER_NOTE} 条,后台拟人节奏发` : 'AI 拟好逐条给你勾选/改,再真发'}</span>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={aiBusy === 'draft' || replyCount === 0} onClick={() => void runReply()}>
            {aiBusy === 'draft'
              ? (autoSend ? '直发中…' : '拟稿中…')
              : (autoSend ? `🚀 AI 回复并直发（${replyCount} 篇）` : `🤖 AI 拟稿审核（${replyCount ? 1 : 0} 篇）`)}
          </button>
        </div>
        {aiBusy === 'draft' ? (
          <div className={c('cardHint')} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 6, color: '#b45309' }}>
            <Icon name="spinner" size={13} />
            <span>{aiProgress || 'AI 处理中…'}</span>
          </div>
        ) : null}
        {/* 当天风控冻结横幅:daemon 已等过用户处理仍确认撞风控。人工完成验证后由用户亲手解除。 */}
        {frozenKey === `${PLATFORM}|${account || ''}` ? (
          <div className={c('cardHint')} style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', color: '#b91c1c' }}>
            <span>⚠️ 今天已触发平台风控,自动直发已冻结——先去下方浏览器标签完成平台验证,再解除。</span>
            <button type="button" className={c('btn')} style={{ flex: '0 0 auto' }} onClick={() => void doUnfreeze()}>我已完成验证,解除冻结</button>
          </div>
        ) : null}

        {drafts ? (
          <div style={{ marginTop: 8 }}>
            <div className={c('cardHint')}>共 {drafts.length} 条评论;勾选的会真发(负面/水军默认不勾)。回复文案可直接改。</div>
            {drafts.map((d) => {
              const st = draftState[d.id] ?? { text: d.reply, on: d.should_reply };
              return (
                <div key={d.id} style={{ borderTop: '1px solid var(--od-border, #e5ded4)', padding: '6px 0' }}>
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
                    <input type="checkbox" checked={st.on} onChange={(e) => setDraftState((s) => ({ ...s, [d.id]: { ...st, on: e.target.checked } }))} style={{ flex: '0 0 auto', width: 15, height: 15, margin: 0 }} />
                    <b style={{ fontSize: 13 }}>@{d.author || '网友'}</b>
                    <span className={c('cardHint')}>「{(d.commentText || '').slice(0, 40)}」</span>
                    <span className={c('chip')} style={{ flex: '0 0 auto' }}>{d.category}</span>
                  </div>
                  {d.should_reply || (st.text || '').trim() ? (
                    <textarea
                      className={c('input')}
                      style={{ width: '100%', marginTop: 4, minHeight: 40, resize: 'vertical' }}
                      value={st.text}
                      onChange={(e) => setDraftState((s) => ({ ...s, [d.id]: { ...st, text: e.target.value } }))}
                    />
                  ) : (
                    <div className={c('cardHint')} style={{ marginTop: 2 }}>AI 建议不回复 — {d.reason}</div>
                  )}
                </div>
              );
            })}
            {drafts.length > 0 ? (
              <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} style={{ marginTop: 8 }} disabled={aiBusy !== ''} onClick={() => void aiSend()}>
                {aiBusy === 'send' ? '发送中…' : `真发选中的(${drafts.filter((d) => draftState[d.id]?.on).length} 条)`}
              </button>
            ) : null}
          </div>
        ) : null}
        {/* 更多设置(默认收起):人设语气 + 手动粘贴链接(没勾笔记时用这条) */}
        <div style={{ marginTop: 10, borderTop: '1px dashed var(--od-border, #e5ded4)', paddingTop: 8 }}>
          <button type="button" className={c('btn')} style={{ border: 'none', padding: '2px 0', fontSize: 13 }} onClick={() => setMoreOpen((v) => !v)}>
            {moreOpen ? '▾' : '▸'} 更多设置（人设语气、手动粘贴链接）
          </button>
          {moreOpen ? (
            <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 6 }}>
              <input
                className={`${c('input')} ${c('grow')}`}
                value={persona}
                placeholder={
                  accountPersonas[account]
                    ? `留空=自动用「账号」页里「${account}」的人设:${accountPersonas[account]!.slice(0, 40)}`
                    : '账号人设/风格(可选,例:专注副业成长、真诚不鸡汤)——AI 按这个语气回评论;在「账号」页填过就不用再填'
                }
                onChange={(e) => setPersona(e.target.value)}
              />
              <input className={`${c('input')} ${c('grow')}`} value={note} placeholder={MANUAL_LINK_HINT[PLATFORM] ?? '手动粘贴内容链接;没勾笔记时用这条'} onChange={(e) => setNote(e.target.value)} />
            </div>
          ) : null}
        </div>
      </div>

      {/* ── 关键词规则(旧玩法,默认收起) ── */}
      <div className={c('card')}>
        <button type="button" className={c('btn')} style={{ border: 'none', padding: 0, fontSize: 15, fontWeight: 600, background: 'transparent' }} onClick={() => setRulesOpen((v) => !v)}>
          {rulesOpen ? '▾' : '▸'} 🎯 关键词规则（旧玩法：命中关键词套模板回复）
        </button>
        {rulesOpen ? (
        <div style={{ marginTop: 8 }}>
        <div className={c('cardHint')} style={{ marginBottom: 6 }}>对一条{noteNoun}读评论、命中规则的套模板回复。占位符 {'{author}'}=评论者、{'{keyword}'}=命中的词。受风控台账门控。</div>
        <div className={c('row')} style={{ gap: 6, flexWrap: 'wrap' }}>
          <input className={`${c('input')} ${c('grow')}`} value={note} placeholder="粘贴一条笔记链接(带 xsec_token 最稳)" onChange={(e) => setNote(e.target.value)} />
          <button type="button" className={c('btn')} disabled={busy !== ''} onClick={() => void preview()}>{busy === 'preview' ? '读评论中…' : '预览命中'}</button>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={busy !== ''} onClick={() => void runLive()}>{busy === 'live' ? '发送中…' : '真发'}</button>
        </div>
        {result ? (
          result.needsLogin ? (
            <div className={c('cardHint')} style={{ color: '#b0342c', marginTop: 6 }}>未登录:去「账号」页登录{platformDef.label}后重试。</div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div className={c('cardHint')}>读到 {result.read} 条评论,命中 {result.matched.length} 条规则{result.dispatched.length ? `;已派发 ${result.dispatched.filter((d) => d.jobId).length} 条` : '(预览,未外发)'}</div>
              {result.matched.map((m, i) => {
                const d = result.dispatched.find((x) => x.commentId === m.commentId);
                const tag = d ? (d.jobId ? '已发' : `拦:${d.blocked}`) : '预览';
                return (<div key={m.commentId + i} className={c('cardHint')} style={{ marginTop: 4 }}><b>[{tag}]</b> @{m.author}「{m.commentText.slice(0, 24)}」→ [{m.ruleName}] {m.reply}</div>);
              })}
              {result.matched.length === 0 ? <div className={c('cardHint')} style={{ marginTop: 4 }}>没有评论命中规则——下面加/调规则,或换条评论多的{noteNoun}。</div> : null}
            </div>
          )
        ) : null}
        <div style={{ marginTop: 10, paddingTop: 8, borderTop: '1px solid var(--od-border, #e5ded4)' }}>
        {rules.length === 0 ? <div className={c('cardHint')}>(还没有规则,下面加一条)</div> : null}
        {rules.map((r) => (
          <div key={r.id} className={c('row')} style={{ alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
            <button type="button" className={c('btn')} title={r.enabled ? '点击停用' : '点击启用'} onClick={() => void toggleRule(r)}>
              {r.enabled ? '● 启用' : '○ 停用'}
            </button>
            <span style={{ fontSize: 13 }}><b>P{r.priority}</b> {r.name} · {r.matchMode}(<span style={{ opacity: 0.75 }}>{r.keywords.join(' / ')}</span>) → {r.replyMode === 'ai' ? <><b>🤖 AI 按意图写</b>:{r.replyTemplate}</> : r.replyTemplate} · {r.action}</span>
            <button type="button" className={c('btn')} onClick={() => void delRule(r.id)}><Icon name="close" size={12} /> 删</button>
          </div>
        ))}
        {/* 新增规则 */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--od-border, #e5ded4)' }}>
          <div className={c('row')} style={{ flexWrap: 'wrap', gap: 8 }}>
            <input className={c('input')} style={{ width: 130 }} value={rName} placeholder="规则名" onChange={(e) => setRName(e.target.value)} />
            <input className={`${c('input')} ${c('grow')}`} value={rKw} placeholder="关键词(逗号分隔),例:价格,多少钱,链接" onChange={(e) => setRKw(e.target.value)} />
            <select className={c('select')} value={rMode} onChange={(e) => setRMode(e.target.value as RuleMatchMode)}>
              <option value="contains">含关键词</option>
              <option value="exact">完全等于</option>
              <option value="regex">正则</option>
            </select>
          </div>
          <div className={c('row')} style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            <select className={c('select')} value={rReplyMode} onChange={(e) => setRReplyMode(e.target.value as InteractionReplyMode)} title="命中后怎么写回复">
              <option value="template">套固定文案</option>
              <option value="ai">🤖 AI 按意图写</option>
            </select>
            <input
              className={`${c('input')} ${c('grow')}`}
              value={rReply}
              placeholder={rReplyMode === 'ai'
                ? '想让 AI 怎么回(写意图,不是文案),例:热情引导私信,别在评论区甩链接'
                : '回复文案,可含 {author}/{keyword},例:@{author} 私信你啦～'}
              onChange={(e) => setRReply(e.target.value)}
            />
            <select className={c('select')} value={rAction} onChange={(e) => setRAction(e.target.value as InteractionAction)}>
              <option value="reply">一级评论</option>
              <option value="sub-reply">楼中楼</option>
            </select>
            <input className={c('input')} style={{ width: 70 }} value={rPriority} placeholder="优先级" onChange={(e) => setRPriority(e.target.value.replace(/[^\d-]/g, ''))} />
            <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void addRule()}>加规则</button>
          </div>
        </div>
        </div>
        </div>
        ) : null}
      </div>
    </div>
  );
}
