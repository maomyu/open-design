// 短视频创作台 — spec: specs/current/media-studio.md
//
// 把 short-video-copy 总控 + 五个平台发布插件（抖音/小红书/快手/B站/视频号）
// 的能力抽象成一个可视化工作台：选题 → 脚本 → 上传成片 → 多平台发布(配音已移除)。
// 数据/发布是确定性直调（大家来、火山 TTS、sau CLI），创意环节 AI 参与
// （AI 写脚本/按建议改），全部落进共享的文章实体（platform: short-video）。
//
// 发布是真正对外动作：必须用户勾选目标并二次确认后才调 sau 上传（合规铁律）。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaTopic,
  SauPlatformId,
  UpdateMediaArticleRequest,
} from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  createStudioAiTask,
  createStudioArticle,
  createStudioTopic,
  deleteStudioArticle,
  deleteStudioTopic,
  fetchDownloadedVideoObjectUrl,
  fetchStudioArticle,
  fetchStudioArticles,
  fetchStudioPublishes,
  fetchStudioTopics,
  lintStudioArticle,
  type StudioLintHit,
  updateStudioArticle,
  uploadStudioCover,
  uploadStudioVideo,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { buildStudioDraft } from './draft-builders';
import { loadStudioPref, saveStudioPref } from './studio-prefs';
import { hasFeature, useLicense } from '../../state/license';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { useOrphanRun } from './useOrphanRun';
import { usePlatformAccountNames } from './usePlatformAccounts';
import { navigate } from '../../router';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'short-video';
const LAST_ARTICLE_KEY = 'open-design:studio:last-video-article';

// 知识库已升级为左侧导航一级入口(/knowledge,全创作台共用),不再是台内 tab。
type VideoTab = 'topics' | 'script' | 'video' | 'publish' | 'list';

const SAU_PLATFORMS: Array<{ id: SauPlatformId; label: string }> = [
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'kuaishou', label: '快手' },
  { id: 'bilibili', label: 'B站' },
  { id: 'tencent', label: '视频号' },
];

/**
 * 子平台按选题 URL 的平台域名判定。选题都存在同一 'short-video' 池里(MediaTopic 无子平台字段),
 * 靠 URL 的平台域名区分显示,避免切到 B站 却看到快手/抖音的选题(2026-07-15 用户报串台)。
 */
const SUB_PLATFORM_URL_RE: Array<{ id: SauPlatformId; re: RegExp }> = [
  { id: 'douyin', re: /douyin\.com|iesdouyin|v\.douyin/i },
  { id: 'xiaohongshu', re: /xiaohongshu\.com|xhslink/i },
  { id: 'kuaishou', re: /kuaishou\.com|chenzhongtech/i },
  { id: 'bilibili', re: /bilibili\.com|b23\.tv/i },
  { id: 'tencent', re: /channels\.weixin|finder|weixin\.qq/i },
];
function topicSubPlatform(url: string): SauPlatformId | null {
  for (const { id, re } of SUB_PLATFORM_URL_RE) if (re.test(url)) return id;
  return null;
}

const TONES = ['真诚口播', '干货清单', '故事化', '测评对比', '情绪共鸣'];
const DURATIONS = ['15s', '30s', '60s', '1-3min'];

const STATUS_LABEL: Record<MediaArticle['status'], { text: string; chip: string }> = {
  writing: { text: '创作中', chip: 'chipAmber' },
  rendered: { text: '已就绪', chip: 'chipBlue' },
  published: { text: '已发布', chip: 'chipGreen' },
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** 口播时长估算：中文约 4.5 字/秒。 */
function estimateDuration(text: string): string {
  const chars = text.replace(/\s+/g, '').length;
  if (chars === 0) return '';
  const seconds = Math.round(chars / 4.5);
  return seconds >= 60 ? `约 ${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒` : `约 ${seconds} 秒`;
}

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 下载到本机的原视频 → blob URL(绕开 od:// 的 Range 透传问题;组件卸载自动回收)。
 *  供右侧预览列「原视频」tab 用(2026-07-20 用户拍板:对照素材参考笔记卡收进右列)。 */
function useDownloadedVideoUrl(videoFile: string): string | null {
  const [videoUrl, setVideoUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!videoFile) { setVideoUrl(null); return; }
    let revoke: (() => void) | null = null;
    let alive = true;
    setVideoUrl(null);
    void fetchDownloadedVideoObjectUrl(videoFile).then((r) => {
      if (!alive) { r?.revoke(); return; }
      if (r) { revoke = r.revoke; setVideoUrl(r.url); }
    });
    return () => { alive = false; if (revoke) revoke(); };
  }, [videoFile]);
  return videoUrl;
}

/** 下一个 hh:mm 时点（今天已过就取明天），datetime-local 值格式。 */
/** 脚本结构条：按空行分段，逐段字数→时长，开场超时给黄金 3 秒提醒。 */
function ScriptTimeline({ bodyMd }: { bodyMd: string }): JSX.Element | null {
  const segments = bodyMd
    .split(/\n{2,}/)
    .map((s) => s.trim())
    .filter(Boolean);
  if (segments.length < 2) return null;
  const counts = segments.map((s) => s.replace(/\s+/g, '').length);
  const secOf = (chars: number) => chars / 4.5;
  const hookSec = secOf(counts[0] ?? 0);
  return (
    <>
      <div className={c('scriptTimeline')}>
        {segments.map((s, i) => (
          <div
            key={`${i}-${counts[i]}`}
            className={c('scriptSegment')}
            style={{ flexGrow: Math.max(counts[i] ?? 1, 1) }}
            title={`第 ${i + 1} 段 · ${counts[i]} 字 ≈ ${Math.round(secOf(counts[i] ?? 0))} 秒\n${s.slice(0, 80)}`}
          >
            <span>{i === 0 ? '开场' : i === segments.length - 1 ? '结尾' : `段${i + 1}`}</span>
            <strong>{Math.round(secOf(counts[i] ?? 0))}s</strong>
          </div>
        ))}
      </div>
      {hookSec > 5 ? (
        <div className={c('cardHint')} style={{ color: '#9a6b00' }}>
          ⚠ 开场约 {Math.round(hookSec)} 秒——黄金前 3 秒要立住钩子，建议第一段压到 15 字内
        </div>
      ) : null}
    </>
  );
}

// entryMode='embedded'(2026-07-18 单页创作流):内嵌统一创作台——隐藏台头/选题步,
// 只露 脚本→上传→发布,选中创作台指定的稿(articleId)。
export function ShortVideoStudioView({ platform: svPlatform, entryMode = 'full', articleId }: { platform?: SauPlatformId; entryMode?: 'full' | 'embedded'; articleId?: string } = {}): JSX.Element {
  const embedded = entryMode === 'embedded';
  const license = useLicense();
  // 平台化(2026-07-12):外壳传入当前短视频平台;每平台是本单池按 targetPlatform
  // 切出的视图(数据不迁移)。缺省抖音兼容(独立打开视图时)。
  const svPlatformLabel = SAU_PLATFORMS.find((p) => p.id === svPlatform)?.label ?? '抖音';
  const lastArticleKey = `${LAST_ARTICLE_KEY}:${svPlatform ?? 'douyin'}`;
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<VideoTab>('script');
  const [topics, setTopics] = useState<MediaTopic[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [aiTask, setAiTask] = useState<StudioAiTask | null>(null);
  const aiSeqRef = useRef(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStage, setAiStage] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiPanelRef = useRef<StudioAiPanelHandle | null>(null);
  const aiAnchorRef = useRef<HTMLDivElement | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [reviseNote, setReviseNote] = useState('');
  const [videoUploadBusy, setVideoUploadBusy] = useState(false);

  const [coverUploadBusy, setCoverUploadBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishes, setPublishes] = useState<MediaPublishRecord[]>([]);
  const [lintHits, setLintHits] = useState<StudioLintHit[]>([]);
  // 发布矩阵：平台 → { 参与勾选, sau 账号名, 登录态 }
  // 账号中心是唯一账号来源:各平台的账号名列表(没配的平台=空数组)。
  // 供安全发布卡(带稿开后台)的账号下拉/引导用。
  const platformAccounts = usePlatformAccountNames();

  const articleRef = useRef<MediaArticle | null>(null);
  articleRef.current = article;
  const aiTaskRef = useRef<StudioAiTask | null>(null);
  aiTaskRef.current = aiTask;
  // 页面刷新/热更后仍在跑的后台任务：恢复感知（亮条+驱动轮询+可中止）。
  const { orphan, cancelOrphan } = useOrphanRun(aiTask === null);
  const effectiveAiRunning = aiRunning || orphan != null;
  const saveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ id: string; patch: UpdateMediaArticleRequest } | null>(null);

  const extra = (article?.extra ?? {}) as Record<string, unknown>;
  const videoPath = str(extra.videoPath);
  const tags = str(extra.tags);
  // 右列预览 tab(2026-07-20 用户拍板:对照原爆款参考笔记卡收进右列,脚本区还给创作)。
  const [previewTab, setPreviewTab] = useState<'draft' | 'video' | 'transcript'>('draft');
  const hasSourceMaterial = !!(str(extra.sourceTranscript) || str(extra.sourceVideoFile) || str(extra.sourceUrl));
  const sourceVideoUrl = useDownloadedVideoUrl(str(extra.sourceVideoFile));
  // 原视频后台下载中(去创作触发):轮询等 sourceVideoFile/sourceVideoError 落稿,
  // 到货即自动显示(2026-07-20 用户实测"下好了也没显示":此前只能手动刷新才看到)。
  const sourceVideoPending = hasSourceMaterial && !str(extra.sourceVideoFile) && !str(extra.sourceVideoError);
  // 口播转写中也要持续轮询(2026-08-04 用户反馈:转写没有进度)——status 落在 extra,
  // 转写完成/失败/无口播时轮询把新状态带回来,「原文案」tab 实时更新。
  const transcriptPending = str(extra.sourceTranscriptStatus) === 'transcribing';
  useEffect(() => {
    if ((!sourceVideoPending && !transcriptPending) || !article) return;
    const id = article.id;
    const timer = window.setInterval(() => {
      if (pendingRef.current) return; // 用户正在编辑,别用轮询结果覆盖
      void fetchStudioArticle(PLATFORM, id).then((a) => {
        if (!a || articleRef.current?.id !== a.id || pendingRef.current) return;
        const ex = (a.extra ?? {}) as Record<string, unknown>;
        const videoSettled = str(ex.sourceVideoFile) || str(ex.sourceVideoError);
        const transcriptMoved = str(ex.sourceTranscriptStatus) !== str(extra.sourceTranscriptStatus) || str(ex.sourceTranscript) !== str(extra.sourceTranscript);
        if (videoSettled || transcriptMoved) {
          setArticle((prev) => (prev && prev.id === a.id ? a : prev));
        }
      });
    }, 4000);
    return () => window.clearInterval(timer);
  }, [sourceVideoPending, transcriptPending, article?.id]);

  // ---- 数据加载 ----
  // 按当前平台过滤单池:匹配 subPlatform;无 subPlatform 的旧作品归到抖音
  // (第一个平台,不丢)。
  const refreshArticles = useCallback(async (): Promise<MediaArticleSummary[]> => {
    const all = (await fetchStudioArticles(PLATFORM)) ?? [];
    const list = all.filter((a) => (a.subPlatform || '抖音') === svPlatformLabel);
    setArticles(list);
    return list;
  }, [svPlatformLabel]);

  const selectArticle = useCallback(async (id: string | null) => {
    if (id) {
      const a = await fetchStudioArticle(PLATFORM, id);
      setArticle(a);
      if (a) window.localStorage.setItem(lastArticleKey, a.id);
    } else {
      setArticle(null);
      window.localStorage.removeItem(lastArticleKey);
    }
    setNotice(null);
  }, [lastArticleKey]);

  useEffect(() => {
    void (async () => {
      await refreshArticles();
      // 内嵌模式:直接选创作台指定的稿。
      if (embedded && articleId) {
        await selectArticle(articleId);
        setTab('script');
        setTopics((await fetchStudioTopics(PLATFORM)) ?? []);
        return;
      }
      const list = await refreshArticles();
      const remembered = window.localStorage.getItem(lastArticleKey);
      const pick = list.find((a) => a.id === remembered) ?? list[0] ?? null;
      if (pick) await selectArticle(pick.id);
      else setTab('topics');
      setTopics((await fetchStudioTopics(PLATFORM)) ?? []);
    })();
  }, [refreshArticles, selectArticle, lastArticleKey, embedded, articleId]);

  // ---- 自动保存（与公众号创作台同款机制） ----
  const flushSave = useCallback(async () => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending || Object.keys(pending.patch).length === 0) return;
    const updated = await updateStudioArticle(PLATFORM, pending.id, pending.patch);
    if (!updated) {
      setSaveState('error');
      return;
    }
    setSaveState('saved');
    setSavedAt(new Date());
    setArticle((a) => (a && a.id === updated.id ? { ...a, status: updated.status, updatedAt: updated.updatedAt, extra: updated.extra } : a));
    setArticles((list) =>
      list ? list.map((s) => (s.id === updated.id ? { ...s, title: updated.title, status: updated.status, updatedAt: updated.updatedAt } : s)) : list,
    );
  }, []);

  const editArticle = useCallback(
    (patch: UpdateMediaArticleRequest) => {
      const current = articleRef.current;
      if (!current) return;
      setArticle((a) => {
        if (!a) return a;
        const next = { ...a, ...patch } as MediaArticle;
        if (patch.extra) {
          const merged = { ...a.extra } as Record<string, unknown>;
          for (const [k, v] of Object.entries(patch.extra)) {
            if (v === null) delete merged[k];
            else merged[k] = v;
          }
          next.extra = merged;
        }
        return next;
      });
      const pending = pendingRef.current;
      pendingRef.current =
        pending && pending.id === current.id
          ? {
              id: current.id,
              patch: {
                ...pending.patch,
                ...patch,
                ...(pending.patch.extra || patch.extra ? { extra: { ...pending.patch.extra, ...patch.extra } } : {}),
              },
            }
          : { id: current.id, patch };
      setSaveState('saving');
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = window.setTimeout(() => void flushSave(), 700);
    },
    [flushSave],
  );

  useEffect(() => () => {
    if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
    void flushSave();
  }, [flushSave]);

  // 新/未标注文章种默认(2026-07-12 平台化后:targetPlatform 由外壳当前平台
  // 决定而非偏好;语气/时长仍按上次选择种)。后端脚本任务读 extra,所以真
  // 种进 extra。一篇只种一次。
  const svSeededRef = useRef<string | null>(null);
  useEffect(() => {
    if (!article?.id || svSeededRef.current === article.id) return;
    svSeededRef.current = article.id;
    const e = (article.extra ?? {}) as Record<string, unknown>;
    const patch: Record<string, string> = {};
    // targetPlatform:该文章还没标注 → 归当前平台(外壳切的那个)。
    if (!str(e.targetPlatform)) patch.targetPlatform = svPlatformLabel;
    const seed = (field: string, key: string, dflt: string) => {
      if (str(e[field])) return; // 该文章已有自己的选择
      const pref = loadStudioPref(key, dflt);
      if (pref !== dflt) patch[field] = pref; // 仅当用户有真实非默认偏好
    };
    seed('tone', 'sv-tone', '真诚口播');
    seed('duration', 'sv-duration', '30s');
    if (Object.keys(patch).length) editArticle({ extra: patch });
  }, [article?.id, editArticle]);


  // AI 任务计时：跑多久一目了然（配合阶段自报，「有没有在执行」不再靠猜）。
  useEffect(() => {
    if (!effectiveAiRunning) {
      setAiElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setAiElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [effectiveAiRunning]);

  // Cmd/Ctrl+S：跳过防抖立即落库。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
        void flushSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [flushSave]);

  // ---- 发布记录 + 敏感词 ----
  useEffect(() => {
    if (tab !== 'publish' || !article) return;
    void lintStudioArticle(PLATFORM, article.id).then(setLintHits);
    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
  }, [tab, article?.id]);

  // ---- AI 任务 ----
  const startAiTask = useCallback(
    async (kind: 'topics' | 'script' | 'revise' | 'review', input?: { note?: string; picked?: PickedHit[] }) => {
      await flushSave();
      const current = articleRef.current;
      const created = await createStudioAiTask(PLATFORM, {
        kind,
        ...(kind !== 'topics' && current ? { articleId: current.id } : {}),
        input: {
          ...(input?.note ? { note: input.note } : {}),
          ...(input?.picked && input.picked.length > 0 ? { picked: input.picked } : {}),
        },
      });
      if ('error' in created) {
        studioToast.err(created.error);
        return;
      }
      aiSeqRef.current += 1;
      setAiTask({ ...created, seq: aiSeqRef.current });
    },
    [flushSave],
  );

  // 【提取文案仿写·第③步】用户选「直接出可开拍的仿写口播稿」:拿到真实口播 transcript 后,
  // 新建一篇短视频稿(带上原文/来源),直接跑 script 任务写出仿写口播稿,并切到脚本区看它成文。
  const rewriteToScript = useCallback(
    async (title: string, transcript: string, sourceUrl: string, videoFile: string) => {
      await flushSave();
      const created = await createStudioArticle(PLATFORM, {
        title: `仿写·${title.slice(0, 20) || '爆款'}`,
        topic: title,
        // sourceVideoFile:下载的原视频本地路径 → 脚本页 blob 播放展示;sourceTranscript:提取的口播文案。
        extra: { targetPlatform: svPlatformLabel, sourceTranscript: transcript, sourceUrl, sourceVideoFile: videoFile },
      });
      if (!created) { studioToast.err('建稿失败——请重试'); return; }
      await refreshArticles();
      setArticle(created);
      window.localStorage.setItem(lastArticleKey, created.id);
      setTab('script');
      // 仿写风格(2026-07-14 用户拍板):优先按【知识库】里的账号人设/口播风格(daemon 会把公司
      // 知识库注入 AI);知识库还没配口播风格时,就沿用这条爆款本身(今天题库里的案例)的风格与节奏。
      const note = [
        '请【仿写】这条爆款的口播文案:保留它的开场钩子、内容结构和爆点节奏,换成全新的表达与案例,不要照抄原句。',
        '\n【风格】优先用「公司知识库」里的账号人设/口播风格,把它改写成本账号的表达与口吻;',
        '如果知识库里还没有口播风格,就沿用这条爆款本身的风格与节奏(它就是今天题库里的爆款案例),仿其形、换其肉。',
        `\n【原口播文案】\n${transcript}`,
      ].join('');
      const t = await createStudioAiTask(PLATFORM, { kind: 'script', articleId: created.id, input: { note } });
      if ('error' in t) { studioToast.err(t.error); return; }
      aiSeqRef.current += 1;
      setAiTask({ ...t, seq: aiSeqRef.current });
    },
    [flushSave, refreshArticles, svPlatformLabel, lastArticleKey],
  );

  // AI 任务运行中每 3 秒轮询——agent 中途写回的脚本实时上屏，不等任务结束。
  useEffect(() => {
    if (!effectiveAiRunning) return;
    const timer = window.setInterval(() => {
      const current = articleRef.current;
      if (pendingRef.current) return;
      if (current) {
        void fetchStudioArticle(PLATFORM, current.id).then((a) => {
          if (a && articleRef.current?.id === a.id && !pendingRef.current && a.updatedAt !== articleRef.current?.updatedAt) {
            setArticle(a);
          }
        });
      }
      void fetchStudioTopics(PLATFORM).then((list) => setTopics(list ?? []));
    }, 3000);
    return () => window.clearInterval(timer);
  }, [effectiveAiRunning]);

  const refreshAfterAiTask = useCallback(
    (outcome: StudioAiOutcome) => {
      if (outcome === 'done') studioToast.ok('AI 任务完成，产物已回填');
      else if (outcome === 'error') studioToast.err('AI 任务出错，详情见底部面板');
      else studioToast.info('AI 任务已中止');
      void refreshArticles();
      void fetchStudioTopics(PLATFORM).then((list) => setTopics(list ?? []));
      const current = articleRef.current;
      if (current) {
        void fetchStudioArticle(PLATFORM, current.id).then((a) => {
          if (a && articleRef.current?.id === a.id) setArticle(a);
          const t = aiTaskRef.current;
          if (outcome === 'done' && a && t && /写/.test(t.title) && !a.bodyMd.trim()) {
            studioToast.err('任务结束了但脚本没有写回——请重跑一次；再发生请反馈');
          }
        });
      }
    },
    [refreshArticles],
  );

  async function handleCreateArticle(fromTopic?: MediaTopic) {
    await flushSave();
    const created = await createStudioArticle(PLATFORM, {
      ...(fromTopic ? { fromTopicId: fromTopic.id, title: fromTopic.title, topic: fromTopic.title } : {}),
      // 平台化:新作品直接归属当前平台(种进 targetPlatform,列表按它过滤)。
      extra: { targetPlatform: svPlatformLabel },
    });
    if (!created) return;
    await refreshArticles();
    setArticle(created);
    window.localStorage.setItem(lastArticleKey, created.id);
    setTab('script');
    if (fromTopic) setTopics((list) => list.map((t) => (t.id === fromTopic.id ? { ...t, status: 'used' } : t)));
  }

  async function handleDeleteArticle() {
    if (!article) return;
    if (!window.confirm(`删除「${article.title || '(未命名)'}」？发布记录一并删除。`)) return;
    pendingRef.current = null;
    await deleteStudioArticle(PLATFORM, article.id);
    const list = await refreshArticles();
    await selectArticle(list[0]?.id ?? null);
  }

  // ---- 发布 ----
  // 自动发布(sau 矩阵直传)已下线(2026-07-09 用户拍板):抖音等平台只走
  // 「带稿开后台 → 人工存草稿/发布」。daemon 端点与 od CLI 保留可恢复。

  // 只显示当前子平台的选题(选题共用一个 'short-video' 池,按 URL 平台域名过滤;URL 认不出平台的
  // 少数选题在各子平台都显示,不丢)。修复:切到 B站 却看到快手/抖音选题的串台(2026-07-15)。
  const curSubPlatform = svPlatform ?? 'douyin';
  const visibleTopics = topics.filter((t) => {
    const p = topicSubPlatform(t.url || '');
    return p === null || p === curSubPlatform;
  });

  // ---- 步骤完成态（用户一眼看到走到哪了） ----
  const stepDone: Record<VideoTab, boolean> = {
    topics: visibleTopics.some((t) => t.status === 'used'),
    script: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    video: Boolean(videoPath.trim()),
    publish: article?.status === 'published',
    list: false,
  };

  const TABS: Array<{ id: VideoTab; label: string; step: string; optional?: boolean }> = [
    ...(embedded ? [] : ([{ id: 'topics', label: '选题', step: '1' }] as const)),
    { id: 'script', label: '脚本', step: '2' },
    // 配音步已移除(2026-07-21 用户拍板:短视频创作不需要配音——客户口播自己拍/已有成片)。
    // 「上传」=客户把自己剪好的成品视频传上来(不是AI生成);发布时自动带上文案+视频。
    { id: 'video', label: '上传', step: '4' },
    { id: 'publish', label: '发布', step: '5' },
  ].map((t, i): { id: VideoTab; label: string; step: string; optional?: boolean } => ({ ...t, id: t.id as VideoTab, step: String(i + 1) })); // 裁剪后步骤号顺序化(1,2,3…不跳号)

  const activeStatus = article ? STATUS_LABEL[article.status] : null;
  const speechText = article ? article.bodyMd : '';

  function emptyCta(text: string) {
    return (
      <div className={c('empty')}>
        <div>{text}</div>
        <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
          <Icon name="plus" size={14} /> 新建作品
        </button>
      </div>
    );
  }

  return (
    <div className={c('root')}>
      {embedded ? null : (
      <div className={c('head')}>
        <h1 className={c('title')}>短视频创作台</h1>
        {activeStatus ? <span className={`${c('chip')} ${c(activeStatus.chip)}`}>{activeStatus.text}</span> : null}
        <SaveStatusBadge state={saveState} savedAt={savedAt} onRetry={() => void flushSave()} />
        <div className={c('headSpacer')} />
        <div className={c('articlePicker')}>
          <button type="button" className={c('btn')} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建
          </button>
          {article ? (
            <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void handleDeleteArticle()} title="删除当前作品">
              <Icon name="trash" size={14} />
            </button>
          ) : null}
        </div>
      </div>
      )}

      {(aiTask && aiRunning) || orphan ? (
        <div className={c('aiGlobalBar')}>
          <span className={c('aiGlobalPulse')} />
          <span className={c('aiGlobalTitle')}>
            {aiTask
              ? `AI 正在执行：${aiTask.title}${aiStage ? ` · ${aiStage}` : ''} · 已运行 ${aiElapsed >= 60 ? `${Math.floor(aiElapsed / 60)} 分 ${aiElapsed % 60} 秒` : `${aiElapsed} 秒`}`
              : '后台 AI 任务运行中（页面刷新前启动）——产物完成后自动写回并刷新'}
          </span>
          {aiTask ? (
            <button
              type="button"
              className={c('aiGlobalBtn')}
              onClick={() => aiAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })}
            >
              查看过程
            </button>
          ) : null}
          <button
            type="button"
            className={c('aiGlobalBtn')}
            onClick={() => (orphan ? cancelOrphan() : aiPanelRef.current?.cancel())}
          >
            中止
          </button>
        </div>
      ) : null}

      <div className={c('tabs')} role="tablist" aria-label="短视频创作台导航">
        {TABS.map((item) => (
          <button
            key={item.id}
            type="button"
            role="tab"
            aria-selected={tab === item.id}
            className={`${c('tab')}${tab === item.id ? ` ${c('tabActive')}` : ''}`}
            onClick={() => setTab(item.id)}
          >
            <span className={c('tabStep')}>{item.step}</span>
            {item.label}
            {item.optional ? <span className={c('tabStep')}>·选</span> : null}
            {stepDone[item.id] ? <Icon name="check" size={12} /> : null}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #e1e5eb)', margin: '4px 6px' }} />
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          className={`${c('tab')}${tab === 'list' ? ` ${c('tabActive')}` : ''}`}
          onClick={() => setTab('list')}
        >
          作品
        </button>
      </div>

      <div className={c('main')}>
        <div className={c('editorCol')}>
          {tab === 'list' ? (
            <ArticleListCard
              articles={articles ?? []}
              statusLabel={(st) => STATUS_LABEL[st]}
              onOpen={(id) => {
                void flushSave().then(() => selectArticle(id));
                setTab('script');
              }}
              onDelete={(id) => {
                void (async () => {
                  const target = (articles ?? []).find((a) => a.id === id);
                  if (!window.confirm(`删除「${target?.title || '(未命名)'}」？发布记录一并删除。`)) return;
                  await deleteStudioArticle(PLATFORM, id);
                  const list = await refreshArticles();
                  if (articleRef.current?.id === id) await selectArticle(list[0]?.id ?? null);
                })();
              }}
              onCreate={() => void handleCreateArticle()}
            />
          ) : null}
          {tab === 'topics' ? (
            <TopicsTab
              platform={PLATFORM}
              /* 短视频平台(抖音/小红书/B站/快手)一律走【内置浏览器采集】(AI找选题→爆款雷达),
                 不暴露 TikHub 热榜/搜索,也不暴露大家来/极致数据(公众号生态)五源——彻底绕开
                 TikHub 成本与风控,极致数据只服务公众号/视频号。 */
              browserCollect
              /* 只采【当前选中平台】——选抖音就只抓抖音。前 4 个平台 id 与采集平台一致;视频号(tencent)
                 走极致数据(dajiala)采集,引擎平台 id 是 channels,采集结果的下载 url 已挂 #odk=解密key。 */
              collectPlatforms={
                svPlatform === 'tencent' ? ['channels']
                  : ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili'].includes(svPlatform ?? 'douyin')
                    ? [svPlatform ?? 'douyin']
                    : []
              }
              topics={visibleTopics}
              onAdd={async (draft) => {
                const created = await createStudioTopic(PLATFORM, draft);
                if (created) setTopics((list) => [created, ...list]);
                return Boolean(created);
              }}
              onDelete={async (id) => {
                if (await deleteStudioTopic(PLATFORM, id)) setTopics((list) => list.filter((t) => t.id !== id));
              }}
              onWrite={(topic) => void handleCreateArticle(topic)}
              onAiFind={(note, picked) => void startAiTask('topics', { note, ...(picked && picked.length > 0 ? { picked } : {}) })}
              onRewriteToScript={(title, transcript, sourceUrl, videoFile) => void rewriteToScript(title, transcript, sourceUrl, videoFile)}
              aiBusy={effectiveAiRunning}
            />
          ) : null}

          {tab === 'script' ? (
            !article ? (
              emptyCta('还没有作品。从「选题」挑一个开始，或新建一个空白作品。')
            ) : (
              <>
                {/* 对照原爆款已收进右侧预览列「原视频/原文案」tab(2026-07-20 用户拍板:
                    参考笔记卡布局,脚本区还给创作,不再整块压在顶部)。 */}
                {hasFeature(license, 'cap.ai') ? (
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    AI 写脚本
                    <span className={c('cardHint')}>按「{svPlatformLabel}」调性 + 语气 + 时长出稿（标题备选/口播稿/标签/封面文字一次到位）</span>
                  </div>
                  <div className={c('row')}>
                    {/* 主发平台由顶部切换器决定,这里不再选(2026-07-12 平台化)。 */}
                    <select
                      className={c('select')}
                      value={str(extra.tone) || loadStudioPref('sv-tone', '真诚口播')}
                      onChange={(e) => { editArticle({ extra: { tone: e.target.value } }); saveStudioPref('sv-tone', e.target.value, '真诚口播'); }}
                    >
                      {TONES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <select
                      className={c('select')}
                      value={str(extra.duration) || loadStudioPref('sv-duration', '30s')}
                      onChange={(e) => { editArticle({ extra: { duration: e.target.value } }); saveStudioPref('sv-duration', e.target.value, '30s'); }}
                    >
                      {DURATIONS.map((d) => (
                        <option key={d} value={d}>
                          {d}
                        </option>
                      ))}
                    </select>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void startAiTask('script')}>
                      <Icon name="sparkles" size={14} /> AI 写脚本
                    </button>
                  </div>
                  <div className={c('row')}>
                    <input
                      className={`${c('input')} ${c('grow')}`}
                      value={reviseNote}
                      placeholder="想怎么改？例：钩子不够狠、口语一点、CTA 换成引导关注…"
                      onChange={(e) => setReviseNote(e.target.value)}
                    />
                    <button
                      type="button"
                      className={c('btn')}
                      disabled={!reviseNote.trim()}
                      onClick={() => {
                        void startAiTask('revise', { note: reviseNote.trim() });
                        setReviseNote('');
                      }}
                    >
                      按我说的改
                    </button>
                  </div>
                </div>
                ) : null}
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    标题
                    <span className={c('cardHint')}>发布时就是视频标题</span>
                  </div>
                  <input
                    className={c('input')}
                    value={article.title}
                    placeholder="视频标题…"
                    onChange={(e) => editArticle({ title: e.target.value })}
                  />
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    口播脚本
                    <span className={c('cardHint')}>
                      {speechText.replace(/\s+/g, '').length} 字 · {estimateDuration(speechText) || '—'}（4.5 字/秒估算）
                    </span>
                  </div>
                  <textarea
                    className={`${c('textarea')} ${c('textareaLarge')}`}
                    value={article.bodyMd}
                    placeholder={'钩子（前3秒）…\n\n正文分点…\n\nCTA…'}
                    onChange={(e) => editArticle({ bodyMd: e.target.value })}
                  />
                  <ScriptTimeline bodyMd={article.bodyMd} />
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    话题标签
                    <span className={c('cardHint')}>逗号分隔，发布时带上</span>
                  </div>
                  <input
                    className={c('input')}
                    value={tags}
                    placeholder="AI工具,效率,小团队"
                    onChange={(e) => editArticle({ extra: { tags: e.target.value } })}
                  />
                </div>
                <VersionsCard
                  platform={PLATFORM}
                  article={article}
                  onRestored={(a) => {
                    pendingRef.current = null;
                    setArticle(a);
                    void refreshArticles();
                  }}
                />
                <div className={c('row')}>
                  <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('video')}>
                    下一步：上传 <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </>
            )
          ) : null}

          {tab === 'video' ? (
            !article ? (
              emptyCta('成片属于某个作品——先去「脚本」新建。')
            ) : (
              <>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    上传成品视频（发布必需）
                    <span className={c('cardHint')}>你自己拍好剪好的口播视频，选文件传上来即可；发布时会自动带上「脚本」里的文案标题标签。</span>
                  </div>
                  <div className={c('row')}>
                    <label className={c('btn')} style={{ cursor: 'pointer' }} title="直接选本机视频文件，自动存进作品素材目录">
                      <Icon name="upload" size={14} /> {videoUploadBusy ? '上传中…' : '选择本机视频'}
                      <input
                        type="file"
                        accept="video/*"
                        style={{ display: 'none' }}
                        disabled={videoUploadBusy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          void (async () => {
                            setVideoUploadBusy(true);
                            const result = await uploadStudioVideo(PLATFORM, article.id, file);
                            setVideoUploadBusy(false);
                            if (result.error) studioToast.err(result.error);
                            else if (result.article) {
                              setArticle(result.article);
                              studioToast.ok('成片已就位，可以去发布了');
                            }
                          })();
                        }}
                      />
                    </label>
                    <span className={c('cardHint')}>或直接粘绝对路径：</span>
                  </div>
                  <input
                    className={c('input')}
                    value={videoPath}
                    placeholder="/Users/…/成片.mp4"
                    onChange={(e) => editArticle({ extra: { videoPath: e.target.value } })}
                  />
                  {videoPath.trim() ? (
                    <div className={c('cardHint')}>发布时会校验文件存在；标题/描述/标签都从本作品带过去。</div>
                  ) : null}
                  {/* 「上传」步只做一件事:传本机成品视频(2026-07-20 用户拍板)。数字人口型
                      替换/AI 生成成片等入口一律不在这里出现——客户是自己拍好剪好上传。 */}
                </div>
                <div className={c('row')}>
                  <button
                    type="button"
                    className={`${c('btn')} ${c('btnPrimary')}`}
                    disabled={!videoPath.trim()}
                    onClick={() => setTab('publish')}
                    title={videoPath.trim() ? '' : '先填成片路径'}
                  >
                    下一步：发布 <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </>
            )
          ) : null}

          {tab === 'publish' ? (
            !article ? (
              emptyCta('发布属于某个作品——先去「脚本」新建。')
            ) : (
              <>
                {/* 封面(可选):用户传一张封面图,一键存草稿时自动上传到抖音「设置封面」。
                    不传也能存草稿(抖音会用视频首帧)。 */}
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    封面（可选）
                    <span className={c('cardHint')}>传一张封面图，「一键存草稿」时自动上传到抖音；不传则用视频首帧</span>
                  </div>
                  <div className={c('row')}>
                    <label className={c('btn')} style={{ cursor: 'pointer' }} title="选本机封面图(jpg/png),存草稿时自动带上">
                      <Icon name="upload" size={14} /> {coverUploadBusy ? '上传中…' : str(extra.coverPath) ? '换封面' : '选择封面图'}
                      <input
                        type="file"
                        accept="image/png,image/jpeg,image/jpg"
                        style={{ display: 'none' }}
                        disabled={coverUploadBusy}
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          e.target.value = '';
                          if (!file) return;
                          void (async () => {
                            setCoverUploadBusy(true);
                            const result = await uploadStudioCover(PLATFORM, article.id, file);
                            setCoverUploadBusy(false);
                            if (result.error) studioToast.err(result.error);
                            else if (result.article) { setArticle(result.article); studioToast.ok('封面已就位，存草稿时会自动上传'); }
                          })();
                        }}
                      />
                    </label>
                    {str(extra.coverPath) ? (
                      <>
                        <span className={c('cardHint')}>已选：{str(extra.coverPath).split('/').pop()}</span>
                        <button type="button" className={c('btn')} onClick={() => editArticle({ extra: { coverPath: '' } })}>移除</button>
                      </>
                    ) : null}
                  </div>
                </div>
                {/* 自动发布(sau 矩阵直传)与定时发布已下线(2026-07-09 用户
                    拍板):抖音等平台只走「带稿开后台 → 人工存草稿/发布」,
                    零自动化指纹。daemon 端点与 od CLI 保留,可恢复。 */}
                <SafeHandoffCard
                  studioPlatform={PLATFORM}
                  articleId={article.id}
                  articleTitle={article.title}
                  targets={SAU_PLATFORMS}
                  defaultTarget={svPlatform ?? 'douyin'}
                  hasAssets={Boolean(videoPath.trim())}
                  assetsLabel="成片文件夹"
                  accountsOf={(pid) => platformAccounts[pid] ?? []}
                  buildDraft={(target) => buildStudioDraft(target, article)}
                  copyText={() => {
                    const tagLine = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => `#${t}`).join(' ');
                    return `${article.title}${tagLine ? `\n\n${tagLine}` : ''}`;
                  }}
                  copyParts={() => {
                    const tagLine = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => `#${t}`).join(' ');
                    return [
                      { label: '标题', text: article.title },
                      { label: '标签', text: tagLine },
                      { label: '口播稿', text: article.bodyMd.trim() },
                    ];
                  }}
                  onMarked={() => {
                    void fetchStudioArticle(PLATFORM, article.id).then((a) => a && setArticle(a));
                    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
                    void refreshArticles();
                  }}
                />
                {lintHits.length > 0 ? (
                  <div className={`${c('notice')} ${c('noticeErr')}`}>
                    脚本命中敏感词 {lintHits.length} 处（{lintHits.slice(0, 5).map((h) => h.word).join('、')}
                    {lintHits.length > 5 ? '…' : ''}）——防限流建议回「脚本」改掉再发。
                  </div>
                ) : null}
                {article.status === 'published' ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>
                      发布复盘
                      <span className={c('cardHint')}>发出 24-48 小时后回来填数据，AI 给下一条的改进建议</span>
                    </div>
                    <input
                      className={c('input')}
                      value={str(extra.reviewData)}
                      placeholder="例：抖音播放 2.1w 赞 300，小红书曝光 8000 收藏 40"
                      onChange={(e) => editArticle({ extra: { reviewData: e.target.value } })}
                    />
                    <div className={c('row')}>
                      <button type="button" className={c('btn')} onClick={() => {
                        void startAiTask('review');
                      }}>
                        <Icon name="sparkles" size={14} /> AI 复盘并给下一条建议
                      </button>
                    </div>
                  </div>
                ) : null}
                {publishes.length > 0 ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>发布记录</div>
                    <div className={c('records')}>
                      {publishes.map((r) => (
                        <div key={r.id} className={c('record')}>
                          <span className={c('recordTime')}>{timeLabel(r.createdAt)}</span>
                          <span className={`${c('chip')} ${r.status === 'ok' ? c('chipGreen') : c('chipRed')}`}>
                            {r.status === 'ok' ? '成功' : '失败'}
                          </span>
                          <span>{r.accountName}</span>
                          {r.error ? <span className={c('recordError')}>{r.error.slice(0, 160)}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )
          ) : null}

          {notice ? (
            <div className={`${c('notice')} ${notice.ok ? c('noticeOk') : c('noticeErr')}`}>{notice.text}</div>
          ) : null}
          {tab === 'script' && stepDone.script ? (
            <NextStepBar hint="脚本完成，下一步上传你剪好的成片" label="去上传" onGo={() => setTab('video')} />
          ) : null}
          {tab === 'video' && stepDone.video ? (
            <NextStepBar hint="成片就绪，去发布——带稿开后台存草稿" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>

        {article && tab !== 'topics' && tab !== 'list' ? (
          <div className={c('previewCol')}>
            {/* 预览 tab(2026-07-20 用户拍板:参考笔记卡):作品卡(发布样子)/原视频/原文案
                ——对照原爆款素材收进右列,脚本区专注创作。无原素材时只有作品卡,不出 chips。 */}
            {hasSourceMaterial ? (
              <div className={c('row')} style={{ gap: 6, marginBottom: 8 }}>
                {([['draft', '📱 作品卡'], ['video', '🎬 原视频'], ['transcript', '📄 原文案']] as const).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    className={`${c('articleSwitchBtn')}${previewTab === id ? ` ${c('articleSwitchBtnActive')}` : ''}`}
                    style={{ fontSize: 12 }}
                    onClick={() => setPreviewTab(id)}
                  >
                    {label}
                  </button>
                ))}
              </div>
            ) : (
              <span className={c('previewTag')}>
                <Icon name="eye" size={13} /> 作品卡（发布时的样子）
              </span>
            )}
            {hasSourceMaterial && previewTab === 'video' ? (
              <div className={c('videoCard')}>
                {str(extra.sourceVideoFile) ? (
                  sourceVideoUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={sourceVideoUrl} controls playsInline style={{ width: '100%', maxHeight: '56vh', borderRadius: 10, background: '#000' }} />
                  ) : (
                    <div className={c('cardHint')}>⏳ 正在载入原视频…</div>
                  )
                ) : str(extra.sourceVideoError) ? (
                  <div className={c('cardHint')} style={{ color: '#9a4b00' }}>
                    ⚠ 原视频没下载成功:{str(extra.sourceVideoError)}
                  </div>
                ) : (
                  <div className={c('cardHint')}>⏳ 原视频正在后台下载…(大文件稍等,下好自动显示;也可先点下方链接在线看)</div>
                )}
                {str(extra.sourceUrl) ? (
                  <a href={str(extra.sourceUrl)} target="_blank" rel="noreferrer" className={c('cardHint')} style={{ marginTop: 8, display: 'inline-block' }}>看原视频 ↗</a>
                ) : null}
              </div>
            ) : hasSourceMaterial && previewTab === 'transcript' ? (
              <div className={c('videoCard')}>
                {str(extra.sourceTranscript) ? (
                  <>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                      <span className={c('cardHint')}>原口播/文案（{str(extra.sourceTranscript).replace(/\s+/g, '').length} 字）</span>
                      <button type="button" className={c('btn')} onClick={() => { void navigator.clipboard?.writeText(str(extra.sourceTranscript)); studioToast.ok('原文案已复制'); }}>复制</button>
                    </div>
                    <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontSize: 13, lineHeight: 1.7, maxHeight: '60vh', overflow: 'auto' }}>
                      {str(extra.sourceTranscript)}
                    </div>
                  </>
                ) : str(extra.sourceTranscriptStatus) === 'transcribing' ? (
                  <div className={c('cardHint')}>⏳ 正在转写口播文案…(约 1-3 分钟,完成后这里自动显示全文)</div>
                ) : str(extra.sourceTranscriptStatus) === 'empty' ? (
                  <div className={c('cardHint')}>这条视频没有识别到口播(可能纯音乐/无人声)——AI 将按标题+切入角度写;想洗稿请换一条有口播的原视频。</div>
                ) : str(extra.sourceTranscriptStatus) === 'failed' ? (
                  <div className={c('cardHint')}>❌ 口播转写失败:{str(extra.sourceTranscriptError) || '未知原因'}。检查「设置 → 媒体生成 → 火山语音」的 key 后,重新点一次「去创作」。</div>
                ) : (
                  <div className={c('cardHint')}>没有原文案——原视频下载完成后会自动带回;或去「创作」选题页用「提取文案仿写」。</div>
                )}
                {str(extra.sourceUrl) ? (
                  <a href={str(extra.sourceUrl)} target="_blank" rel="noreferrer" className={c('cardHint')} style={{ marginTop: 8, display: 'inline-block' }}>看原文 ↗</a>
                ) : null}
              </div>
            ) : (
            <div className={c('videoCard')}>
              <div className={c('videoCardTitle')}>{article.title || '（还没有标题）'}</div>
              <div className={c('videoCardMeta')}>
                {str(extra.targetPlatform) || '抖音'} · {str(extra.tone) || '真诚口播'} · {estimateDuration(speechText) || '时长未知'}
              </div>
              <div className={c('videoCardScript')}>
                {speechText.trim() ? speechText.slice(0, 1200) : '口播脚本会显示在这里…'}
              </div>
              {tags.trim() ? (
                <div className={c('row')}>
                  {tags.split(/[,，]/).filter(Boolean).slice(0, 8).map((t) => (
                    <span key={t} className={`${c('chip')} ${c('chipBlue')}`}>
                      #{t.trim()}
                    </span>
                  ))}
                </div>
              ) : null}
              <div className={c('videoCardMeta')}>{videoPath ? `成片：${videoPath.split('/').pop()}` : '成片：未就绪'}</div>
            </div>
            )}
          </div>
        ) : null}
      </div>
      <div ref={aiAnchorRef}>
        <StudioAiPanel
          ref={aiPanelRef}
          task={aiTask}
          onFinished={refreshAfterAiTask}
          onDismiss={() => setAiTask(null)}
          onRunningChange={setAiRunning}
          onStageChange={setAiStage}
        />
      </div>
      <StudioToastHost />
    </div>
  );
}
