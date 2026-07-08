// 图文笔记创作台（第三台）— spec: specs/current/media-studio.md
//
// 内容形态矩阵的第三条腿：小红书为主的图文笔记（抖音/快手也收图文）。
// 步骤：选题(共享) → 文案(≤20字标题/≤1000字正文/标签,AI 写笔记) →
// 图集(按画面建议批量生成/上传/排序/删除,1-18 张) → 发布(sau upload-note
// 矩阵 + 定时 + 人工确认)。实体复用 media_articles(platform: note)，
// 图集存 extra.noteImages(资产 URL 数组,顺序即展示顺序)。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaTopic,
  UpdateMediaArticleRequest,
} from '@open-design/contracts';
import { Icon } from '../Icon';
import {
  checkSauLogin,
  createStudioAiTask,
  createStudioArticle,
  createStudioTopic,
  deleteStudioArticle,
  deleteStudioTopic,
  fetchStudioArticle,
  fetchStudioArticles,
  fetchStudioPublishes,
  fetchStudioTopics,
  generateArticleImage,
  lintStudioArticle,
  publishStudioNote,
  startSauLogin,
  updateStudioArticle,
  uploadStudioAsset,
  type StudioLintHit,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, KnowledgePanel, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { TopicsTab } from './TopicsTab';
import { loadPreferredImageModel, savePreferredImageModel } from './image-model-pref';
import { useOrphanRun } from './useOrphanRun';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'note';
const LAST_ARTICLE_KEY = 'open-design:studio:last-note';

type NoteTab = 'topics' | 'copy' | 'gallery' | 'publish' | 'list' | 'knowledge';

/** sau 支持图文的平台。 */
const NOTE_PLATFORMS: Array<{ id: string; label: string }> = [
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'douyin', label: '抖音' },
  { id: 'kuaishou', label: '快手' },
];

const IMAGE_STYLES: Array<{ id: string; label: string }> = [
  { id: 'whiteboard', label: '白板手绘（默认）' },
  { id: 'illustrated', label: '暖插画（带文字）' },
  { id: 'clean', label: '纯净插画（无文字）' },
];
const IMAGE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'qwen', label: '千问 · 图像2.0 Pro（默认）' },
  // 火山按版本选：id 里 volc: 后面就是方舟的 Model ID（不带即用最新默认）。
  { id: 'volc', label: '火山 · Seedream 5.0（最新）' },
  { id: 'volc:doubao-seedream-5-0-lite-260128', label: '火山 · Seedream 5.0 Lite（快·联网）' },
  { id: 'volc:doubao-seedream-4-5-251128', label: '火山 · Seedream 4.5' },
  { id: 'gemini', label: 'Gemini（备用）' },
];

const STATUS_LABEL: Record<MediaArticle['status'], { text: string; chip: string }> = {
  writing: { text: '创作中', chip: 'chipAmber' },
  rendered: { text: '已就绪', chip: 'chipBlue' },
  published: { text: '已发布', chip: 'chipGreen' },
};

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

function charCount(s: string): number {
  return s.replace(/\s+/g, '').length;
}

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

type LoginState = 'unknown' | 'checking' | 'in' | 'out' | 'logging';

export function NoteStudioView(): JSX.Element {
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<NoteTab>('copy');
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
  const [galleryProgress, setGalleryProgress] = useState<{ done: number; total: number } | null>(null);
  const [lightboxUrl, setLightboxUrl] = useState('');
  const dragIndexRef = useRef<number | null>(null);
  const [reviseNote, setReviseNote] = useState('');
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [publishes, setPublishes] = useState<MediaPublishRecord[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [lintHits, setLintHits] = useState<StudioLintHit[]>([]);
  const [scheduleAt, setScheduleAt] = useState('');
  const [galleryBusy, setGalleryBusy] = useState<string | null>(null);
  const [galleryPrompt, setGalleryPrompt] = useState('');
  const [galleryStyle, setGalleryStyle] = useState('illustrated');
  const [galleryModel, setGalleryModel] = useState(loadPreferredImageModel);
  const [matrix, setMatrix] = useState<Record<string, { on: boolean; account: string; login: LoginState; detail: string }>>(
    () => Object.fromEntries(NOTE_PLATFORMS.map((p) => [p.id, { on: false, account: 'main', login: 'unknown' as LoginState, detail: '' }])),
  );

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
  const tags = str(extra.tags);
  const imageIdeas = str(extra.imageIdeas);
  const noteImages: string[] = Array.isArray(extra.noteImages)
    ? (extra.noteImages as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];

  // ---- 数据加载 ----
  const refreshArticles = useCallback(async (): Promise<MediaArticleSummary[]> => {
    const list = (await fetchStudioArticles(PLATFORM)) ?? [];
    setArticles(list);
    return list;
  }, []);

  const selectArticle = useCallback(async (id: string | null) => {
    if (id) {
      const a = await fetchStudioArticle(PLATFORM, id);
      setArticle(a);
      if (a) window.localStorage.setItem(LAST_ARTICLE_KEY, a.id);
    } else {
      setArticle(null);
      window.localStorage.removeItem(LAST_ARTICLE_KEY);
    }
    setNotice(null);
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await refreshArticles();
      const remembered = window.localStorage.getItem(LAST_ARTICLE_KEY);
      const pick = list.find((a) => a.id === remembered) ?? list[0] ?? null;
      if (pick) await selectArticle(pick.id);
      else setTab('topics');
      setTopics((await fetchStudioTopics(PLATFORM)) ?? []);
    })();
  }, [refreshArticles, selectArticle]);

  // ---- 自动保存 ----
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
    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
    void lintStudioArticle(PLATFORM, article.id).then(setLintHits);
  }, [tab, article?.id, article?.updatedAt]);

  // ---- AI 任务 ----
  const startAiTask = useCallback(
    async (kind: 'topics' | 'write' | 'revise' | 'review', input?: { note?: string }) => {
      await flushSave();
      const current = articleRef.current;
      const created = await createStudioAiTask(PLATFORM, {
        kind,
        ...(kind !== 'topics' && current ? { articleId: current.id } : {}),
        input: { ...(input?.note ? { note: input.note } : {}) },
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

  // AI 任务运行中每 3 秒轮询——agent 中途写回的文案/图集建议实时上屏。
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
            studioToast.err('任务结束了但文案没有写回——请重跑一次；再发生请反馈');
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
    });
    if (!created) return;
    await refreshArticles();
    setArticle(created);
    window.localStorage.setItem(LAST_ARTICLE_KEY, created.id);
    setTab('copy');
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

  // ---- 图集操作 ----
  async function generateGalleryImage(description: string) {
    if (!article || !description.trim()) return;
    setGalleryBusy(description);
    setNotice(null);
    const result = await generateArticleImage(PLATFORM, article.id, {
      description: description.trim(),
      style: galleryStyle,
      model: galleryModel,
      ratio: '3:4',
    });
    setGalleryBusy(null);
    if ('error' in result) {
      setNotice({ ok: false, text: result.error });
      return;
    }
    if (result.url) {
      if (result.note) studioToast.info(result.note);
      editArticle({ extra: { noteImages: [...latestNoteImages(), result.url] } });
      setNotice({ ok: true, text: '已生成并加入图集' });
    }
  }

  /** 读最新图集——串行批量生成期间组件闭包会过期，靠 ref 拿实时数组防丢图。 */
  function latestNoteImages(): string[] {
    const raw = (articleRef.current?.extra as Record<string, unknown> | undefined)?.noteImages;
    return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === 'string') : [];
  }

  async function generateAllFromIdeas() {
    if (!article) return;
    const ideas = imageIdeas.split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 9);
    if (ideas.length === 0) return;
    setGalleryProgress({ done: 0, total: ideas.length });
    setGalleryBusy('__batch__');
    let acc = latestNoteImages();
    let okCount = 0;
    for (const [i, idea] of ideas.entries()) {
      // 逐张串行生成（图接口有频控；中途失败不影响已生成的）。
      // eslint-disable-next-line no-await-in-loop
      const result = await generateArticleImage(PLATFORM, article.id, {
        description: idea,
        style: galleryStyle,
        model: galleryModel,
        ratio: '3:4',
      });
      if ('error' in result) {
        studioToast.err(`第 ${i + 1} 张失败：${result.error}`);
      } else if (result.url) {
        if (result.note) studioToast.info(`第 ${i + 1} 张：${result.note}`);
        acc = [...acc, result.url];
        editArticle({ extra: { noteImages: acc } });
        okCount += 1;
      }
      setGalleryProgress({ done: i + 1, total: ideas.length });
    }
    setGalleryBusy(null);
    setGalleryProgress(null);
    studioToast.ok(`图集生成完成：成功 ${okCount}/${ideas.length} 张`);
  }

  function reorderImage(from: number, to: number) {
    if (from === to) return;
    const next = [...latestNoteImages()];
    if (from < 0 || from >= next.length || to < 0 || to >= next.length) return;
    const [item] = next.splice(from, 1);
    next.splice(to, 0, item!);
    editArticle({ extra: { noteImages: next } });
  }

  function moveImage(index: number, delta: number) {
    reorderImage(index, index + delta);
  }

  function removeImage(index: number) {
    editArticle({ extra: { noteImages: latestNoteImages().filter((_, i) => i !== index) } });
  }

  // ---- 发布 ----
  async function handleCheckLogin(platformId: string) {
    const entry = matrix[platformId];
    if (!entry) return;
    setMatrix((m) => ({ ...m, [platformId]: { ...m[platformId]!, login: 'checking', detail: '' } }));
    const result = await checkSauLogin(PLATFORM, { platform: platformId, account: entry.account });
    setMatrix((m) => ({
      ...m,
      [platformId]: {
        ...m[platformId]!,
        login: result.error ? 'unknown' : result.loggedIn ? 'in' : 'out',
        detail: result.error ?? (result.loggedIn ? '' : '未登录——点「扫码登录」'),
      },
    }));
  }

  async function handleLogin(platformId: string) {
    const entry = matrix[platformId];
    if (!entry) return;
    setMatrix((m) => ({ ...m, [platformId]: { ...m[platformId]!, login: 'logging', detail: '已弹出浏览器窗口，扫码后自动继续…' } }));
    const result = await startSauLogin(PLATFORM, { platform: platformId, account: entry.account });
    setMatrix((m) => ({
      ...m,
      [platformId]: {
        ...m[platformId]!,
        login: result.error ? 'unknown' : result.ok ? 'in' : 'out',
        detail: result.error ?? (result.ok ? '登录成功' : `未完成：${(result.detail ?? '').slice(0, 80)}`),
      },
    }));
  }

  async function handlePublish() {
    if (!article || publishing) return;
    const targets = NOTE_PLATFORMS.filter((p) => matrix[p.id]?.on).map((p) => ({
      platform: p.id,
      account: matrix[p.id]!.account.trim() || 'main',
    }));
    if (targets.length === 0) {
      setNotice({ ok: false, text: '先勾选至少一个发布平台' });
      return;
    }
    if (noteImages.length === 0) {
      setNotice({ ok: false, text: '图集为空——去「图集」生成或上传至少 1 张图' });
      setTab('gallery');
      return;
    }
    const summary = targets.map((t) => `${NOTE_PLATFORMS.find((p) => p.id === t.platform)?.label}（账号 ${t.account}）`).join('、');
    const schedule = scheduleAt ? scheduleAt.replace('T', ' ') : '';
    if (!window.confirm(`确认把笔记「${article.title || '(未命名)'}」（${noteImages.length} 张图）发布到：${summary}？${schedule ? `\n定时：${schedule}` : ''}\n\n这是真实对外发布。`)) return;
    setPublishing(true);
    setNotice(null);
    await flushSave();
    const result = await publishStudioNote(PLATFORM, article.id, {
      targets,
      ...(schedule ? { schedule } : {}),
    });
    setPublishing(false);
    if (result.error) {
      setNotice({ ok: false, text: result.error });
    } else {
      const ok = (result.records ?? []).filter((r) => r.status === 'ok').length;
      const failed = (result.records ?? []).length - ok;
      setNotice({ ok: failed === 0, text: `发布完成：成功 ${ok} 个${failed ? `，失败 ${failed} 个（详情见发布记录）` : ''}` });
      if (result.article) setArticle(result.article);
      await refreshArticles();
    }
    if (article) setPublishes(await fetchStudioPublishes(PLATFORM, article.id));
  }

  // ---- 步骤完成态 ----
  const stepDone: Record<NoteTab, boolean> = {
    topics: topics.some((t) => t.status === 'used'),
    copy: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    gallery: noteImages.length > 0,
    publish: article?.status === 'published',
    list: false,
    knowledge: false,
  };

  const TABS: Array<{ id: NoteTab; label: string; step: string }> = [
    { id: 'topics', label: '选题', step: '1' },
    { id: 'copy', label: '文案', step: '2' },
    { id: 'gallery', label: '图集', step: '3' },
    { id: 'publish', label: '发布', step: '4' },
  ];

  const activeStatus = article ? STATUS_LABEL[article.status] : null;
  const titleCount = article ? charCount(article.title) : 0;
  const bodyCount = article ? charCount(article.bodyMd) : 0;

  function emptyCta(text: string) {
    return (
      <div className={c('empty')}>
        <div>{text}</div>
        <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
          <Icon name="plus" size={14} /> 新建笔记
        </button>
      </div>
    );
  }

  return (
    <div className={c('root')}>
      <div className={c('head')}>
        <h1 className={c('title')}>图文笔记创作台</h1>
        {activeStatus ? <span className={`${c('chip')} ${c(activeStatus.chip)}`}>{activeStatus.text}</span> : null}
        <SaveStatusBadge state={saveState} savedAt={savedAt} onRetry={() => void flushSave()} />
        <div className={c('headSpacer')} />
        <div className={c('articlePicker')}>
          {/* 换文章走「文章」列表页(步骤条里已有可视化管理面)——头部只显
              当前在写哪篇,点击直达列表。 */}
          {article ? (
            <button
              type="button"
              className={c('btn')}
              title="点击打开列表切换"
              onClick={() => {
                void flushSave();
                setTab('list');
              }}
            >
              {(article.title || '(未命名)').slice(0, 18)}
              {(article.title || '').length > 18 ? '…' : ''} <Icon name="chevron-down" size={12} />
            </button>
          ) : null}
          <button type="button" className={c('btn')} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建
          </button>
          {article ? (
            <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void handleDeleteArticle()}>
              <Icon name="trash" size={14} />
            </button>
          ) : null}
        </div>
      </div>

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

      <div className={c('tabs')} role="tablist" aria-label="图文笔记创作台导航">
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
            {stepDone[item.id] ? <Icon name="check" size={12} /> : null}
          </button>
        ))}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #e1e5eb)', margin: '4px 6px' }} />
        <button type="button" role="tab" aria-selected={tab === 'list'} className={`${c('tab')}${tab === 'list' ? ` ${c('tabActive')}` : ''}`} onClick={() => setTab('list')}>
          笔记
        </button>
        <button type="button" role="tab" aria-selected={tab === 'knowledge'} className={`${c('tab')}${tab === 'knowledge' ? ` ${c('tabActive')}` : ''}`} onClick={() => setTab('knowledge')}>
          知识库
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
                setTab('copy');
              }}
              onDelete={(id) => {
                void (async () => {
                  const target = (articles ?? []).find((a) => a.id === id);
                  if (!window.confirm(`删除「${target?.title || '(未命名)'}」？`)) return;
                  await deleteStudioArticle(PLATFORM, id);
                  const list = await refreshArticles();
                  if (articleRef.current?.id === id) await selectArticle(list[0]?.id ?? null);
                })();
              }}
              onCreate={() => void handleCreateArticle()}
            />
          ) : null}
          {tab === 'knowledge' ? <KnowledgePanel platform={PLATFORM} accounts={[]} /> : null}
          {tab === 'topics' ? (
            <TopicsTab
              platform={PLATFORM}
              aiOnly
              topics={topics}
              onAdd={async (draft) => {
                const created = await createStudioTopic(PLATFORM, draft);
                if (created) setTopics((list) => [created, ...list]);
              }}
              onDelete={async (id) => {
                if (await deleteStudioTopic(PLATFORM, id)) setTopics((list) => list.filter((t) => t.id !== id));
              }}
              onWrite={(topic) => void handleCreateArticle(topic)}
              onAiFind={(note) => void startAiTask('topics', { note })}
              aiBusy={aiTask !== null}
            />
          ) : null}

          {tab === 'copy' ? (
            !article ? (
              emptyCta('还没有笔记。从「选题」挑一个开始，或新建一篇。')
            ) : (
              <>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    AI 写笔记
                    <span className={c('cardHint')}>一键全流程：先调研 → 小红书调性出稿（标题/正文/标签/图集建议）→ 清 AI 腔</span>
                  </div>
                  <div className={c('row')}>
                    <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void startAiTask('write')}>
                      <Icon name="sparkles" size={14} /> AI 写笔记
                    </button>
                    <input
                      className={`${c('input')} ${c('grow')}`}
                      value={reviseNote}
                      placeholder="想怎么改？例：再口语一点、开头换个钩子、结尾问句更抓人…"
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
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    标题
                    <span className={c('cardHint')} style={titleCount > 20 ? { color: '#b0342c', fontWeight: 600 } : undefined}>
                      {titleCount}/20 字{titleCount > 20 ? '（超了，发布会被截断/失败）' : ''}
                    </span>
                  </div>
                  <input
                    className={c('input')}
                    value={article.title}
                    placeholder="≤20 字，钩子前置…"
                    onChange={(e) => editArticle({ title: e.target.value })}
                  />
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    正文
                    <span className={c('cardHint')} style={bodyCount > 1000 ? { color: '#b0342c', fontWeight: 600 } : undefined}>
                      {bodyCount}/1000 字{bodyCount > 1000 ? '（超了）' : ''} · 短段落 · 结尾互动问题
                    </span>
                  </div>
                  <textarea
                    className={`${c('textarea')} ${c('textareaLarge')}`}
                    value={article.bodyMd}
                    placeholder={'开头一句钩子…\n\n分点干货（1-2 句一段）…\n\n结尾抛一个互动问题？'}
                    onChange={(e) => editArticle({ bodyMd: e.target.value })}
                  />
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    话题标签
                    <span className={c('cardHint')}>5-8 个，逗号分隔，发布时带上</span>
                  </div>
                  <input
                    className={c('input')}
                    value={tags}
                    placeholder="美国商标,出海,小团队,知识产权"
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
                  <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('gallery')}>
                    下一步：图集 <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </>
            )
          ) : null}

          {tab === 'gallery' ? (
            !article ? (
              emptyCta('图集属于某篇笔记——先去「文案」新建。')
            ) : (
              <>
                {imageIdeas.trim() ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>
                      AI 给的图集建议（{imageIdeas.split('\n').filter((l) => l.trim()).length} 张）
                      <span className={c('cardHint')}>一键按建议逐张生成（第 1 张当封面）</span>
                    </div>
                    <div className={c('videoCardScript')} style={{ maxHeight: 140 }}>{imageIdeas}</div>
                    <div className={c('row')}>
                      <select className={c('select')} value={galleryStyle} onChange={(e) => setGalleryStyle(e.target.value)}>
                        {IMAGE_STYLES.map((s) => (
                          <option key={s.id} value={s.id}>
                            {s.label}
                          </option>
                        ))}
                      </select>
                      <select className={c('select')} value={galleryModel} onChange={(e) => {
                          savePreferredImageModel(e.target.value);
                          setGalleryModel(e.target.value);
                        }}>
                        {IMAGE_MODELS.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                      <button
                        type="button"
                        className={`${c('btn')} ${c('btnPrimary')}`}
                        disabled={galleryBusy !== null}
                        onClick={() => void generateAllFromIdeas()}
                      >
                        {galleryProgress
                          ? `生成中 ${galleryProgress.done}/${galleryProgress.total}…`
                          : galleryBusy
                            ? '生成中…'
                            : '按建议生成全部'}
                      </button>
                    </div>
                  </div>
                ) : null}
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    单张生成 / 上传
                    <span className={c('cardHint')}>竖图 3:4；也可以直接传本机图</span>
                  </div>
                  <div className={c('row')}>
                    <input
                      className={`${c('input')} ${c('grow')}`}
                      value={galleryPrompt}
                      placeholder="画面描述，例：大字封面「美国商标 12-18 个月」+ 时间轴…"
                      onChange={(e) => setGalleryPrompt(e.target.value)}
                    />
                    <button
                      type="button"
                      className={`${c('btn')} ${c('btnPrimary')}`}
                      disabled={galleryBusy !== null || !galleryPrompt.trim()}
                      onClick={() => {
                        void generateGalleryImage(galleryPrompt).then(() => setGalleryPrompt(''));
                      }}
                    >
                      {galleryBusy ? '生成中…' : '生成加入图集'}
                    </button>
                    <label className={c('btn')} style={{ cursor: 'pointer' }}>
                      <Icon name="upload" size={14} /> 上传
                      <input
                        type="file"
                        accept="image/*"
                        multiple
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const files = [...(e.target.files ?? [])];
                          e.target.value = '';
                          if (files.length === 0 || !article) return;
                          void (async () => {
                            const urls: string[] = [];
                            for (const file of files) {
                              // eslint-disable-next-line no-await-in-loop
                              const result = await uploadStudioAsset(PLATFORM, article.id, file);
                              if (result.url) urls.push(result.url);
                              else if (result.error) setNotice({ ok: false, text: result.error });
                            }
                            if (urls.length > 0) {
                              editArticle({ extra: { noteImages: [...latestNoteImages(), ...urls] } });
                              setNotice({ ok: true, text: `已加入 ${urls.length} 张` });
                            }
                          })();
                        }}
                      />
                    </label>
                  </div>
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    图集（{noteImages.length}/18 · 第 1 张是封面）
                    <span className={c('cardHint')}>顺序即发布顺序，可左右移/删除</span>
                  </div>
                  {noteImages.length === 0 ? (
                    <div className={c('cardHint')}>还没有图——上面生成或上传。小红书笔记至少 1 张图才能发。</div>
                  ) : (
                    <div className={c('coverGrid')}>
                      {noteImages.map((url, i) => (
                        <div
                          key={url}
                          className={c('coverCard')}
                          draggable
                          title="拖拽调整顺序 · 点图看大图"
                          onDragStart={() => {
                            dragIndexRef.current = i;
                          }}
                          onDragOver={(e) => e.preventDefault()}
                          onDrop={(e) => {
                            e.preventDefault();
                            const from = dragIndexRef.current;
                            dragIndexRef.current = null;
                            if (from != null && from !== i) reorderImage(from, i);
                          }}
                          style={{ cursor: 'grab' }}
                        >
                          <img
                            className={c('coverThumb')}
                            style={{ aspectRatio: '3 / 4' }}
                            src={url}
                            alt={`图 ${i + 1}`}
                            onClick={() => setLightboxUrl(url)}
                          />
                          <div className={c('row')}>
                            <span className={`${c('chip')} ${i === 0 ? c('chipGreen') : c('chipGrey')}`}>{i === 0 ? '封面' : `#${i + 1}`}</span>
                            <span className={c('headSpacer')} />
                            <button type="button" className={c('btn')} disabled={i === 0} onClick={() => moveImage(i, -1)} title="前移">
                              ←
                            </button>
                            <button type="button" className={c('btn')} disabled={i === noteImages.length - 1} onClick={() => moveImage(i, 1)} title="后移">
                              →
                            </button>
                            <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => removeImage(i)}>
                              删
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <div className={c('row')}>
                  <button
                    type="button"
                    className={`${c('btn')} ${c('btnPrimary')}`}
                    disabled={noteImages.length === 0}
                    onClick={() => setTab('publish')}
                    title={noteImages.length === 0 ? '至少要 1 张图' : ''}
                  >
                    下一步：发布 <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </>
            )
          ) : null}

          {tab === 'publish' ? (
            !article ? (
              emptyCta('发布属于某篇笔记——先去「文案」新建。')
            ) : (
              <>
                <SafeHandoffCard
                  studioPlatform={PLATFORM}
                  articleId={article.id}
                  articleTitle={article.title}
                  targets={NOTE_PLATFORMS}
                  defaultTarget="xiaohongshu"
                  hasAssets={noteImages.length > 0}
                  copyText={() => {
                    const tagLine = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => `#${t}`).join(' ');
                    return `${article.title}\n\n${article.bodyMd.trim()}${tagLine ? `\n\n${tagLine}` : ''}`;
                  }}
                  copyParts={() => {
                    const tagLine = tags.split(/[,，]/).map((t) => t.trim()).filter(Boolean).map((t) => `#${t}`).join(' ');
                    return [
                      { label: '标题', text: article.title },
                      { label: '正文', text: article.bodyMd.trim() },
                      { label: '标签', text: tagLine },
                    ];
                  }}
                  onMarked={() => {
                    void fetchStudioArticle(PLATFORM, article.id).then((a) => a && setArticle(a));
                    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
                    void refreshArticles();
                  }}
                />
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    自动发布（sau 直传）
                    <span className={c('cardHint')}>⚠️ 小红书对自动化风控严格，容易限流——建议小红书走上面的安全发布，抖音/快手可自动</span>
                  </div>
                  {NOTE_PLATFORMS.map((p) => {
                    const entry = matrix[p.id]!;
                    return (
                      <div key={p.id} className={c('row')}>
                        <label className={c('row')} style={{ minWidth: 96 }}>
                          <input
                            type="checkbox"
                            checked={entry.on}
                            onChange={(e) => setMatrix((m) => ({ ...m, [p.id]: { ...m[p.id]!, on: e.target.checked } }))}
                          />
                          <strong>{p.label}</strong>
                        </label>
                        <input
                          className={c('input')}
                          style={{ width: 130 }}
                          value={entry.account}
                          onChange={(e) => setMatrix((m) => ({ ...m, [p.id]: { ...m[p.id]!, account: e.target.value } }))}
                        />
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={entry.login === 'checking' || entry.login === 'logging'}
                          onClick={() => void handleCheckLogin(p.id)}
                        >
                          {entry.login === 'checking' ? '检查中…' : '检查登录'}
                        </button>
                        {entry.login === 'in' ? <span className={`${c('chip')} ${c('chipGreen')}`}>已登录</span> : null}
                        {entry.login === 'out' ? (
                          <>
                            <span className={`${c('chip')} ${c('chipRed')}`}>未登录</span>
                            <button type="button" className={c('btn')} onClick={() => void handleLogin(p.id)}>
                              扫码登录
                            </button>
                          </>
                        ) : null}
                        {entry.login === 'logging' ? <span className={`${c('chip')} ${c('chipAmber')}`}>等扫码…</span> : null}
                        {entry.detail ? <span className={c('cardHint')}>{entry.detail.slice(0, 60)}</span> : null}
                      </div>
                    );
                  })}
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    定时发布（可选）
                    <span className={c('cardHint')}>空 = 立即发</span>
                  </div>
                  <div className={c('row')}>
                    <input
                      type="datetime-local"
                      className={c('input')}
                      style={{ width: 220 }}
                      value={scheduleAt}
                      onChange={(e) => setScheduleAt(e.target.value)}
                    />
                    {scheduleAt ? (
                      <button type="button" className={c('btn')} onClick={() => setScheduleAt('')}>
                        清除
                      </button>
                    ) : null}
                  </div>
                </div>
                {lintHits.length > 0 ? (
                  <div className={`${c('notice')} ${c('noticeErr')}`}>
                    文案命中敏感词 {lintHits.length} 处（{lintHits.slice(0, 5).map((h) => h.word).join('、')}
                    {lintHits.length > 5 ? '…' : ''}）——防限流建议回「文案」改掉再发。
                  </div>
                ) : null}
                <div className={c('row')}>
                  <button
                    type="button"
                    className={`${c('btn')} ${c('btnPrimary')}`}
                    disabled={publishing}
                    onClick={() => void handlePublish()}
                  >
                    {publishing ? (scheduleAt ? '排定时…' : '发布中…') : scheduleAt ? '定时发布到已选平台' : '发布到已选平台'}
                  </button>
                  <span className={c('saveHint')}>真实对外发布 · 点击后还有一次明细确认</span>
                </div>
                {article.status === 'published' ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>
                      发布复盘
                      <span className={c('cardHint')}>24-48 小时后填数据，AI 给下一篇建议</span>
                    </div>
                    <input
                      className={c('input')}
                      value={str(extra.reviewData)}
                      placeholder="例：小红书曝光 8000 点赞 120 收藏 40，评论多问价格"
                      onChange={(e) => editArticle({ extra: { reviewData: e.target.value } })}
                    />
                    <div className={c('row')}>
                      <button type="button" className={c('btn')} onClick={() => void startAiTask('review')}>
                        <Icon name="sparkles" size={14} /> AI 复盘并给下一篇建议
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

          {notice ? <div className={`${c('notice')} ${notice.ok ? c('noticeOk') : c('noticeErr')}`}>{notice.text}</div> : null}
          {tab === 'copy' && stepDone.copy ? (
            <NextStepBar hint="文案完成，下一步准备图集（第 1 张即封面）" label="去图集" onGo={() => setTab('gallery')} />
          ) : null}
          {tab === 'gallery' && stepDone.gallery ? (
            <NextStepBar hint="图集就绪，去发布（推荐安全发布，零风控指纹）" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>

        {article && tab !== 'topics' && tab !== 'list' && tab !== 'knowledge' ? (
          <div className={c('previewCol')}>
            <span className={c('previewTag')}>
              <Icon name="eye" size={13} /> 笔记卡（发布时的样子）
            </span>
            <div className={c('videoCard')}>
              {noteImages.length > 0 ? (
                <img
                  src={noteImages[0]}
                  alt="封面"
                  title="点击看大图"
                  style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 10, cursor: 'zoom-in' }}
                  onClick={() => setLightboxUrl(noteImages[0]!)}
                />
              ) : (
                <div className={c('cardHint')} style={{ aspectRatio: '3 / 4', display: 'flex', alignItems: 'center', justifyContent: 'center', border: '1.5px dashed var(--border, #e1e5eb)', borderRadius: 10 }}>
                  封面图会显示在这里
                </div>
              )}
              {noteImages.length > 1 ? (
                <div className={c('row')}>
                  {noteImages.slice(1, 7).map((url, i) => (
                    <img
                      key={url}
                      src={url}
                      alt={`图 ${i + 2}`}
                      title="点击看大图"
                      style={{ width: 52, aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 6, cursor: 'zoom-in' }}
                      onClick={() => setLightboxUrl(url)}
                    />
                  ))}
                  {noteImages.length > 7 ? <span className={c('cardHint')}>+{noteImages.length - 7}</span> : null}
                </div>
              ) : null}
              <div className={c('videoCardTitle')}>{article.title || '（还没有标题）'}</div>
              <div className={c('videoCardScript')} style={{ maxHeight: '30vh' }}>
                {article.bodyMd.trim() ? article.bodyMd.slice(0, 1000) : '正文会显示在这里…'}
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
            </div>
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
      {lightboxUrl ? (
        <div
          className={c('lightbox')}
          role="button"
          tabIndex={0}
          onClick={() => setLightboxUrl('')}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') setLightboxUrl('');
          }}
        >
          <img className={c('lightboxImg')} src={lightboxUrl} alt="大图预览" />
        </div>
      ) : null}
    </div>
  );
}
