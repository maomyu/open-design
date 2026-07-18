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
import { IMAGE_RATIO_OPTIONS, IMAGE_STYLE_PRESETS } from '@open-design/contracts';
import { ImageStyleSamples } from './ImageStyleSamples';
import { Icon } from '../Icon';
import {
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
  importXhsNote,
  fetchSourceMaterial,
  topicOriginPlatform,
  lintStudioArticle,
  updateStudioArticle,
  uploadStudioAsset,
  type StudioLintHit,
} from '../../providers/media-studio';
import { buildStudioDraft } from './draft-builders';
import { hasFeature, useLicense } from '../../state/license';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { loadPreferredImageModel, savePreferredImageModel } from './image-model-pref';
import { loadStudioPref, saveStudioPref } from './studio-prefs';
import { useOrphanRun } from './useOrphanRun';
import { usePlatformAccountNames } from './usePlatformAccounts';
import { navigate } from '../../router';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'note';
const LAST_ARTICLE_KEY = 'open-design:studio:last-note';

// 知识库已升级为左侧导航一级入口(/knowledge,全创作台共用),不再是台内 tab。
type NoteTab = 'topics' | 'copy' | 'gallery' | 'publish' | 'list';

/** sau 支持图文的平台。 */
const NOTE_PLATFORMS: Array<{ id: string; label: string }> = [
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'douyin', label: '抖音' },
  { id: 'kuaishou', label: '快手' },
];

// 生图风格清单收进 contracts 共享(公众号台同源;15+ 常见风格,daemon 前缀表一一对应)。
const IMAGE_STYLES = IMAGE_STYLE_PRESETS;
// 参考图 = 风格轴上的一个选项(2026-07-18 用户拍板):选它=不套内置模板、照参考图的
// 调子生图,与内置预设互斥。风格下拉里排第一;选它但还没挑图→跳右侧「参考图」tab 去挑。
const REF_STYLE = '__ref__';
const IMAGE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'qwen', label: '千问 · 图像2.0 Pro（默认）' },
  // 火山按版本选：id 里 volc: 后面就是方舟的 Model ID（不带即用最新默认）。
  { id: 'volc', label: '火山 · Seedream 5.0（最新）' },
  { id: 'volc:doubao-seedream-5-0-lite-260128', label: '火山 · Seedream 5.0 Lite（快·联网）' },
  { id: 'volc:doubao-seedream-4-5-251128', label: '火山 · Seedream 4.5' },
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

// entryMode(2026-07-18 用户拍板:小红书第三形态「直接生图」;同日单页创作流加 embedded):
//  'note'         = 完整流程(选题→文案→图集→发布),默认。
//  'direct-image' = 用户已有想法,跳过选题直接进图集:落地即建草稿、顶部自由框
//                   「想法→生图/AI文案」,选题步隐藏。图集/文案机制完全复用本组件。
//  'embedded'     = 内嵌进统一创作台(零跳页):隐藏台头/选题步,只露 文案→图集→发布,
//                   选中创作台指定的稿(articleId)。「正在做」条由创作台提供。
export function NoteStudioView({ entryMode = 'note', articleId }: { entryMode?: 'note' | 'direct-image' | 'embedded'; articleId?: string } = {}): JSX.Element {
  const directImage = entryMode === 'direct-image';
  const embedded = entryMode === 'embedded';
  const license = useLicense();
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<NoteTab>(directImage ? 'gallery' : 'copy');
  // 直接生图:顶部自由提示词(用户自己的想法/画面),独立于 AI 图集建议。
  const [freePrompt, setFreePrompt] = useState('');
  // 参考图(2026-07-18 用户拍板):选一张参考图后,图集里任何生图(AI写的提示词行/你自己写的)
  // 都带它的风格(自动不套模板);清空=普通模板生图。参考素材/图集里的图都能设为参考。
  const [refImage, setRefImage] = useState('');
  // 右侧预览 tab(2026-07-18 用户拍板省空间):成稿(当前创作)/原文(原文案)/参考图(原图)。
  const [previewTab, setPreviewTab] = useState<'draft' | 'source' | 'refs'>('draft');
  // 取原素材(url-only 候选补回原文案/原图)。
  const [fetchingSource, setFetchingSource] = useState(false);
  const fetchSourceNow = async (url: string) => {
    if (!article) return;
    setFetchingSource(true);
    const r = await fetchSourceMaterial(url);
    if ('error' in r) {
      // 拉取失败(常见:AI 选题引用的新闻/公众号链接已过期)不阻断创作——明确告知可直接写。
      studioToast.err(`原素材拉取失败:${r.error}。不影响创作——可直接点「AI 写笔记」按标题+知识库写`);
      setFetchingSource(false);
      return;
    }
    // 原图存进【参考素材区】extra.sourceImages,不直接进图集(2026-07-18 用户拍板:
    // 别人的原图是参考,不能当自己成品直接发——防盗图;想用点参考图上的「+加入图集」)。
    let imageUrls: string[] = [];
    if (r.images.length > 0) {
      const imp = await importXhsNote(article.id, r.text, r.images);
      if (!('error' in imp)) imageUrls = imp.imageUrls;
    }
    // 重新拉取时若接口只返回图没返回文(或反之),别用空值覆盖已取到的原文案/原图。
    const prevContent = str((articleRef.current?.extra as Record<string, unknown> | undefined)?.sourceContent);
    await updateStudioArticle(PLATFORM, article.id, { extra: { sourceContent: r.text || prevContent, ...(imageUrls.length ? { sourceImages: imageUrls } : {}) } });
    const fresh = await fetchStudioArticle(PLATFORM, article.id);
    if (fresh) setArticle(fresh);
    setFetchingSource(false);
    studioToast.ok(imageUrls.length
      ? `已取回原素材:原文案+${imageUrls.length}张原图 ✓(右侧「原文」「参考图」)`
      : '已取回原文案 ✓(右侧「原文」;该来源无原图,如公众号/新闻页)');
  };
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
  const [lintHits, setLintHits] = useState<StudioLintHit[]>([]);
  const [galleryBusy, setGalleryBusy] = useState<string | null>(null);
  const [galleryPrompt, setGalleryPrompt] = useState('');
  const [galleryStyle, setGalleryStyleRaw] = useState(() => {
    // 旧偏好可能存着已移除的风格(illustrated/clean/cyber)→ 兜底回默认白板
    const v = loadStudioPref('gallery-style', 'photo-film');
    return IMAGE_STYLE_PRESETS.some((s) => s.id === v) ? v : 'photo-film';
  });
  const [galleryRatio, setGalleryRatioRaw] = useState(() => loadStudioPref('gallery-ratio', '3:4'));
  const setGalleryRatio = (v: string) => {
    setGalleryRatioRaw(v);
    saveStudioPref('gallery-ratio', v, '3:4');
  };
  // 记住上次选的图片风格模板当默认（用户报：选完不该每次重置）。
  const setGalleryStyle = (v: string) => {
    setGalleryStyleRaw(v);
    saveStudioPref('gallery-style', v, 'photo-film');
  };
  const [galleryModel, setGalleryModel] = useState(loadPreferredImageModel);
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
  const tags = str(extra.tags);
  const imageIdeas = str(extra.imageIdeas);
  // 图集建议逐条化:每行一条画面建议,单独渲染+各自带「生图」按钮(不再挤成一坨文本)。
  const ideaLines = imageIdeas.split('\n').map((l) => l.trim()).filter(Boolean);
  const noteImages: string[] = Array.isArray(extra.noteImages)
    ? (extra.noteImages as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  // 参考素材(原图)——独立于图集,仅供参考/仿风格/手动加入(防盗图,2026-07-18)。
  const sourceImages: string[] = Array.isArray(extra.sourceImages)
    ? (extra.sourceImages as unknown[]).filter((v): v is string => typeof v === 'string')
    : [];
  const sourceContent = str(extra.sourceContent);
  const sourceUrl = str(extra.sourceUrl);

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

  // 自动取原素材(2026-07-18 用户反馈"去创作后看不到原文/原图"):选中的稿有原文链接
  // 但还没原文案/原图 → 自动按链接抓一次(不用手点「取原素材」)。每篇只自动抓一次。
  const autoFetchedRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const a = article;
    if (!a) return;
    const ex = a.extra as Record<string, unknown>;
    const url = typeof ex.sourceUrl === 'string' ? ex.sourceUrl : '';
    const hasContent = typeof ex.sourceContent === 'string' && ex.sourceContent;
    const hasImgs = Array.isArray(ex.sourceImages) && ex.sourceImages.length > 0;
    // 文案+原图都齐了才跳过;缺任一(常见:真抓爆款自带文案但图数组为空)就自动补拉
    // (2026-07-18 用户反馈:去创作要自动把原文案+素材图都拉回来,别只拉到文案缺图)。
    if (!url || (hasContent && hasImgs) || fetchingSource || autoFetchedRef.current.has(a.id)) return;
    autoFetchedRef.current.add(a.id);
    void fetchSourceNow(url);
  }, [article?.id]);

  useEffect(() => {
    void (async () => {
      const list = await refreshArticles();
      // 内嵌模式:直接选创作台指定的稿,不走"上次记忆"。
      if (embedded && articleId) {
        await selectArticle(articleId);
        setTab('copy');
        setTopics((await fetchStudioTopics(PLATFORM)) ?? []);
        return;
      }
      const remembered = window.localStorage.getItem(LAST_ARTICLE_KEY);
      const pick = list.find((a) => a.id === remembered) ?? list[0] ?? null;
      if (pick) await selectArticle(pick.id);
      else if (directImage) {
        // 直接生图:没有现成稿就自动建一篇空白草稿承载图集/文案,用户无需先去选题。
        const created = await createStudioArticle(PLATFORM, { title: '' });
        if (created) {
          setArticles((await refreshArticles()) as MediaArticleSummary[]);
          await selectArticle(created.id);
        }
        setTab('gallery');
      } else setTab('topics');
      setTopics((await fetchStudioTopics(PLATFORM)) ?? []);
    })();
  }, [refreshArticles, selectArticle, directImage, embedded, articleId]);

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
    async (kind: 'topics' | 'write' | 'revise' | 'review', input?: { note?: string; picked?: PickedHit[] }) => {
      await flushSave();
      const current = articleRef.current;
      const created = await createStudioAiTask(PLATFORM, {
        kind,
        ...(kind !== 'topics' && current ? { articleId: current.id } : {}),
        input: {
          ...(input?.note ? { note: input.note } : {}),
          ...(input?.picked && input.picked.length > 0 ? { picked: input.picked } : {}),
          // 图文笔记台只面向小红书:AI 选题引用只准小红书站内链接(2026-07-18 用户拍板)。
          ...(kind === 'topics' ? { sourcePlatform: 'xiaohongshu' } : {}),
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

  // 图文笔记台「提取图文仿写」:采到的小红书图文爆款 → 建笔记 → 下载原图进图集 + 取原文案 →
  // 按知识库风格 AI 仿写成新图文笔记(原图/原文案存进文章,文案页展示原文参考)。
  async function handleExtractNote(hitTitle: string, text: string, images: string[]) {
    if (!images.length) { studioToast.err('这条没带回图文内容(可能是视频/已删),换一条'); return; }
    await flushSave();
    studioToast.info('正在下载原图进图集…(稍候别切走)');
    const created = await createStudioArticle(PLATFORM, { title: hitTitle, topic: hitTitle });
    if (!created) { studioToast.err('建笔记失败'); return; }
    window.localStorage.setItem(LAST_ARTICLE_KEY, created.id);
    const r = await importXhsNote(created.id, text, images);
    if ('error' in r) {
      await refreshArticles(); setArticle(created); setTab('copy');
      studioToast.err(`下载图文失败:${r.error}`);
      return;
    }
    const updated = await updateStudioArticle(PLATFORM, created.id, {
      extra: { noteImages: r.imageUrls, sourceContent: text, targetPlatform: '小红书' },
    });
    await refreshArticles();
    setArticle(updated ?? created);
    setTab('copy');
    // 让 articleRef 更新到新文章后再发 AI 任务(startAiTask 按 articleRef.current 挂 articleId)。
    await new Promise((res) => setTimeout(res, 60));
    studioToast.ok(`已下 ${r.imageUrls.length} 张原图进图集 + 取到原文案 ✓ 正按你的风格仿写成新笔记…`);
    await startAiTask('write');
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
  async function generateGalleryImage(description: string, referenceImageOverride?: string) {
    if (!article || !description.trim()) return;
    // 参考图:显式传入的优先;否则用当前选中的 refImage(模式)。有参考图 → 自动切
    // 「不用模板」让模型学参考图真实风格,不被内置模板覆盖(2026-07-18 用户拍板)。
    const referenceImage = referenceImageOverride || refImage;
    setGalleryBusy(description);
    setNotice(null);
    const result = await generateArticleImage(PLATFORM, article.id, {
      description: description.trim(),
      style: referenceImage ? 'none' : galleryStyle,
      model: galleryModel,
      ratio: galleryRatio,
      ...(referenceImage ? { referenceImage } : {}),
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

  // 风格轴统一入口(2026-07-18):内置预设和「参考图」二选一,互斥。
  //   - 下拉/样例当前值:有参考图→显示「参考图」,否则→当前预设。
  //   - 选内置预设:清掉参考图(退出参考图模式)+设预设。
  //   - 选「参考图」但还没挑图:跳右侧「参考图」tab 让用户点某张「作参考」。
  const styleAxisValue = refImage ? REF_STYLE : galleryStyle;
  function onStyleAxisSelect(v: string) {
    if (v === REF_STYLE) {
      if (!refImage) {
        setPreviewTab('refs');
        studioToast.info('在右侧「参考图」里点某张原图的「作参考」,即用它的风格生图');
      }
      return;
    }
    if (refImage) setRefImage('');   // 切回内置预设 = 退出参考图模式
    setGalleryStyle(v);
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
        // 参考图是风格轴:批量生成同样吃它(有参考图→不套模板,照它的调子)。
        style: refImage ? 'none' : galleryStyle,
        model: galleryModel,
        ratio: galleryRatio,
        ...(refImage ? { referenceImage: refImage } : {}),
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
  // 自动发布(sau 直传)已下线(2026-07-09 用户拍板):小红书/抖音只走
  // 「带稿开后台 → 人工存草稿」。daemon 端点与 od CLI 保留可恢复。

  // ---- 步骤完成态 ----
  const stepDone: Record<NoteTab, boolean> = {
    topics: topics.some((t) => t.status === 'used'),
    copy: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    gallery: noteImages.length > 0,
    publish: article?.status === 'published',
    list: false,
  };

  const TABS: Array<{ id: NoteTab; label: string; step: string }> = [
    // 直接生图形态隐藏「选题」——用户已有想法,不走选题funnel。
    ...((directImage || embedded) ? [] : [{ id: 'topics' as NoteTab, label: '选题', step: '1' }]),
    { id: 'copy', label: '文案', step: '2' },
    // 图集(图片生成)跟 cap.image。客户只要文案不要生图时,授权不含 cap.image → 图集隐藏。
    ...(hasFeature(license, 'cap.image') ? [{ id: 'gallery' as NoteTab, label: '图集', step: '3' }] : []),
    { id: 'publish', label: '发布', step: '4' },
  ].map((t, i): { id: NoteTab; label: string; step: string } => ({ ...t, id: t.id as NoteTab, step: String(i + 1) })); // 裁剪后步骤号顺序化

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
      {embedded ? null : (
      <div className={c('head')}>
        <h1 className={c('title')}>图文笔记创作台</h1>
        {activeStatus ? <span className={`${c('chip')} ${c(activeStatus.chip)}`}>{activeStatus.text}</span> : null}
        <SaveStatusBadge state={saveState} savedAt={savedAt} onRetry={() => void flushSave()} />
        <div className={c('headSpacer')} />
        <div className={c('articlePicker')}>
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
          {tab === 'topics' ? (
            <TopicsTab
              platform={PLATFORM}
              /* 图文笔记=小红书图文笔记:选题走【小红书爆款采集】(与短视频台小红书一致,TikHub 直采),
                 而不是纯 AI 找题。图文笔记只面向小红书,采集平台固定小红书。
                 列表过滤(2026-07-18 用户拍板):只显示 小红书链接的 + 无链接灵感题,站外/其它平台不出现。 */
              browserCollect
              collectPlatforms={['xiaohongshu']}
              topics={topics.filter((t) => { const o = topicOriginPlatform(t.url); return o === 'any' || o === 'xiaohongshu'; })}
              onAdd={async (draft) => {
                const created = await createStudioTopic(PLATFORM, draft);
                if (created) setTopics((list) => [created, ...list]);
              }}
              onDelete={async (id) => {
                if (await deleteStudioTopic(PLATFORM, id)) setTopics((list) => list.filter((t) => t.id !== id));
              }}
              onWrite={(topic) => void handleCreateArticle(topic)}
              onAiFind={(note, picked) => void startAiTask('topics', { note, ...(picked && picked.length > 0 ? { picked } : {}) })}
              onExtractNote={(title, text, images) => void handleExtractNote(title, text, images)}
              aiBusy={effectiveAiRunning}
            />
          ) : null}

          {tab === 'copy' ? (
            !article ? (
              emptyCta('还没有笔记。从「选题」挑一个开始，或新建一篇。')
            ) : (
              <>
                {/* 原素材拉取(2026-07-18 用户拍板:去创作的第一步就是自动拉取,不设手动按钮):
                    进创作即自动拉原文案+原图,原文进右侧「原文」tab、原图进「参考图」tab。
                    这里只在拉取进行中给一条状态,拉完即隐藏;拉完后由用户主动点「AI 写笔记」。 */}
                {fetchingSource ? (
                  <div className={c('card')}>
                    <div className={c('cardHint')}>⏳ 第一步·正在自动拉取原素材(原文案+原图)——完成后见右侧「原文」「参考图」,再点下方「AI 写笔记」按原文仿写正文</div>
                  </div>
                ) : null}
                {/* 参考素材区已移到「图集」步(2026-07-18 用户拍板:参考图属于生图环节)。 */}
                {hasFeature(license, 'cap.ai') ? (
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    AI 写笔记
                    <span className={c('cardHint')}>原素材拉好后点这里：先调研 → 按原文+知识库风格仿写出稿（标题/正文/标签/图集建议）→ 清 AI 腔</span>
                  </div>
                  <div className={c('row')}>
                    <button
                      type="button"
                      className={`${c('btn')} ${c('btnPrimary')}`}
                      disabled={effectiveAiRunning || fetchingSource}
                      title={fetchingSource ? '原素材拉取中——拉完再点,AI 才有原文可仿' : '按原素材(如有)+知识库风格仿写,结果写进下方标题/正文'}
                      onClick={() => void startAiTask('write')}
                    >
                      <Icon name="sparkles" size={14} /> {fetchingSource ? '原素材拉取中…' : 'AI 写笔记'}
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
                ) : null}
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
                {/* 参考图横幅(2026-07-18 用户拍板):选了参考图后,下面任何生图(AI写的
                    提示词行/你自己写的)都参考它的风格质感,自动不套模板。✕ 清除。 */}
                {refImage ? (
                  <div className={c('card')} style={{ borderColor: '#e8582e', display: 'flex', alignItems: 'center', gap: 12 }}>
                    <img src={refImage} alt="参考图" style={{ width: 56, height: 72, objectFit: 'cover', borderRadius: 8 }} />
                    <div style={{ flex: 1 }}>
                      <div style={{ fontWeight: 700, fontSize: 13 }}>已选参考图 · 生图将模仿它的风格质感</div>
                      <div className={c('cardHint')}>下面写提示词(自己写或用 AI 图集建议),点生图即出同款风格;自动不套内置模板</div>
                    </div>
                    <button type="button" className={c('btn')} onClick={() => setRefImage('')}>✕ 清除参考</button>
                  </div>
                ) : null}
                {/* 参考素材(原图)已移到右侧预览的「参考图」tab(2026-07-18 用户拍板省空间)。 */}
                {/* 生图·你的想法:非直接生图模式也显示(便于写自定义提示词+配参考图)。 */}
                {directImage || refImage ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>
                      {refImage ? '写提示词 · 配上方参考图生图' : '直接生图 · 你的想法'}
                      <span className={c('cardHint')}>
                        {refImage
                          ? '描述你要的画面/产品,点「生图」按上方参考图的风格质感出图(不套模板)'
                          : '描述你想要的画面(产品/场景/风格),选下方风格与比例,点「生图」直接出图;也可让 AI 据此写小红书文案'}
                      </span>
                    </div>
                    <textarea
                      className={c('textarea')}
                      style={{ minHeight: 64, marginBottom: 8 }}
                      placeholder="例:水果娜旅行洗护8件套摆在浅粉色梳妆台上,樱花点缀,清新少女风,俯拍"
                      value={freePrompt}
                      onChange={(e) => setFreePrompt(e.target.value)}
                    />
                    <div className={c('row')} style={{ gap: 8 }}>
                      <button
                        type="button"
                        className={`${c('btn')} ${c('btnPrimary')}`}
                        disabled={galleryBusy !== null || !freePrompt.trim()}
                        onClick={() => void generateGalleryImage(freePrompt.trim())}
                      >
                        {galleryBusy === freePrompt.trim() ? '生成中…' : refImage ? '✨ 按参考图生图' : '✨ 生图(用下方风格)'}
                      </button>
                      {directImage ? (
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={effectiveAiRunning || !freePrompt.trim()}
                          title="按你的想法让 AI 写一篇小红书文案(标题+正文+标签),到「文案」步查看"
                          onClick={() => void startAiTask('write', { note: freePrompt.trim() })}
                        >
                          {effectiveAiRunning ? 'AI 写作中…' : '📝 AI 帮我写文案'}
                        </button>
                      ) : null}
                    </div>
                  </div>
                ) : null}
                {ideaLines.length > 0 ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>
                      AI 给的图集建议（{ideaLines.length} 张）
                      <span className={c('cardHint')}>每条可单独生图,也可一键全部（第 1 张当封面）</span>
                    </div>
                    {/* 逐条一行:可编辑的提示词输入框 + 各自的「生图」按钮(2026-07-17 用户反馈:
                        别挤成一坨 + 提示词要能改)。失焦把修改回存 extra.imageIdeas,切页不丢。 */}
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, margin: '6px 0 10px' }}>
                      {ideaLines.map((idea, i) => (
                        <div
                          key={`${i}-${idea}`}
                          className={c('row')}
                          style={{ alignItems: 'center', gap: 8, flexWrap: 'nowrap' }}
                        >
                          <input
                            className={`${c('input')} ${c('grow')}`}
                            style={{ minWidth: 0, fontSize: 12.5 }}
                            defaultValue={idea}
                            title="可直接修改这条画面提示词,改完点右侧「生图」"
                            onBlur={(e) => {
                              const v = e.target.value.trim();
                              if (v === idea) return;
                              const next = [...ideaLines];
                              if (v) next[i] = v;
                              else next.splice(i, 1);   // 清空=删除这条建议
                              editArticle({ extra: { imageIdeas: next.join('\n') } });
                            }}
                            onKeyDown={(e) => {
                              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                            }}
                          />
                          <button
                            type="button"
                            className={c('btn')}
                            style={{ flexShrink: 0 }}
                            disabled={galleryBusy !== null}
                            title={refImage ? '按这条提示词 + 上方参考图生图(学参考图风格)' : '按左侧(可编辑的)提示词只生成这一张,用当前选中的风格/模型'}
                            onClick={(e) => {
                              // 就地取输入框当前值:没失焦的最新编辑也要生效。refImage 由
                              // generateGalleryImage 默认带上——AI 建议行同样吃参考图。
                              const input = (e.currentTarget.parentElement?.querySelector('input') as HTMLInputElement | null);
                              const text = (input?.value ?? idea).trim();
                              if (text) void generateGalleryImage(text);
                            }}
                          >
                            {galleryBusy === idea ? '生成中…' : refImage ? '生图·参考' : '生图'}
                          </button>
                        </div>
                      ))}
                    </div>
                    <div className={c('row')}>
                      <select className={c('select')} value={styleAxisValue} title="风格:内置预设 或 参考图(二选一)" onChange={(e) => onStyleAxisSelect(e.target.value)}>
                        <option value={REF_STYLE}>🖼 参考图{refImage ? '(已选·照它生)' : ''}</option>
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
                      <select className={c('select')} value={galleryRatio} title="生图比例" onChange={(e) => setGalleryRatio(e.target.value)}>
                        {IMAGE_RATIO_OPTIONS.map((r) => (
                          <option key={r.id} value={r.id}>
                            {r.label}
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
                    <ImageStyleSamples value={refImage ? '' : galleryStyle} onSelect={onStyleAxisSelect} />
                  </div>
                ) : null}
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    AI 生图 / 上传
                    <span className={c('cardHint')}>
                      选风格模板出图稳；选「不用模板」提示词原样直达模型，画风全凭你描述。竖图 3:4，也可直接传本机图
                    </span>
                  </div>
                  <div className={c('row')}>
                    <select
                      className={c('select')}
                      value={styleAxisValue}
                      title="风格:内置预设 或 参考图(二选一)——「不用模板」时画风全由提示词决定"
                      onChange={(e) => onStyleAxisSelect(e.target.value)}
                    >
                      <option value={REF_STYLE}>🖼 参考图{refImage ? '(已选·照它生)' : ''}</option>
                      {IMAGE_STYLES.map((s) => (
                        <option key={s.id} value={s.id}>
                          {s.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={c('select')}
                      value={galleryModel}
                      onChange={(e) => {
                        savePreferredImageModel(e.target.value);
                        setGalleryModel(e.target.value);
                      }}
                    >
                      {IMAGE_MODELS.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.label}
                        </option>
                      ))}
                    </select>
                    <select className={c('select')} value={galleryRatio} title="生图比例" onChange={(e) => setGalleryRatio(e.target.value)}>
                      {IMAGE_RATIO_OPTIONS.map((r) => (
                        <option key={r.id} value={r.id}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <ImageStyleSamples value={refImage ? '' : galleryStyle} onSelect={onStyleAxisSelect} />
                  <div className={c('row')}>
                    <input
                      className={`${c('input')} ${c('grow')}`}
                      value={galleryPrompt}
                      placeholder={
                        galleryStyle === 'none'
                          ? '完整画面描述（含画风），例：胶片质感街拍，暖橘色调，一位职场女性在咖啡店窗边看笔记本…'
                          : '画面描述，例：大字封面「美国商标 12-18 个月」+ 时间轴…'
                      }
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
                            {/* 设为参考图:上方「参考图」栏亮起,再写提示词生同款风格
                                (2026-07-18 用户拍板:参考图+提示词两步,不再一点就生)。 */}
                            <button
                              type="button"
                              className={`${c('btn')} ${url === refImage ? c('btnPrimary') : ''}`}
                              title="把这张设为参考图 → 上方写提示词按它的风格生新图(不套模板)"
                              onClick={() => setRefImage(url === refImage ? '' : url)}
                            >
                              {url === refImage ? '✓ 参考中' : '作参考'}
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
                  accountsOf={(pid) => platformAccounts[pid] ?? []}
                  buildDraft={(target) => buildStudioDraft(target, article)}
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
                {/* 自动发布(sau 直传)与定时发布已下线(2026-07-09 用户拍板):
                    小红书/抖音只走「带稿开后台 → 人工存草稿」,零自动化指纹。
                    daemon 端点与 od CLI 保留,要恢复把矩阵卡加回来即可。 */}
                {lintHits.length > 0 ? (
                  <div className={`${c('notice')} ${c('noticeErr')}`}>
                    文案命中敏感词 {lintHits.length} 处（{lintHits.slice(0, 5).map((h) => h.word).join('、')}
                    {lintHits.length > 5 ? '…' : ''}）——防限流建议回「文案」改掉再发。
                  </div>
                ) : null}
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
                      <button type="button" className={c('btn')} onClick={() => {
                        void startAiTask('review');
                      }}>
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

        {article && tab !== 'topics' && tab !== 'list' ? (
          <div className={c('previewCol')}>
            {/* 预览 tab:成稿(发布样子)/原文(原文案参考)/参考图(原图,可作参考·加入图集)。
                把参考素材从左栏挪进这里,省左栏空间(2026-07-18 用户拍板)。 */}
            <div className={c('row')} style={{ gap: 6, marginBottom: 8 }}>
              {([['draft', '📱 成稿'], ['source', '📄 原文'], ['refs', `🖼 参考图${sourceImages.length ? `(${sourceImages.length})` : ''}`]] as const).map(([id, label]) => (
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
            {previewTab === 'source' ? (
              <div className={c('videoCard')}>
                {str((article.extra as Record<string, unknown>).sourceContent) ? (
                  <div style={{ whiteSpace: 'pre-wrap', fontSize: 13, lineHeight: 1.7, maxHeight: '60vh', overflow: 'auto' }}>
                    {str((article.extra as Record<string, unknown>).sourceContent)}
                  </div>
                ) : (
                  <div className={c('cardHint')}>{fetchingSource ? '⏳ 正在自动拉取原文案…' : '没有原文案(此稿非爆款来源)。'}</div>
                )}
                {str((article.extra as Record<string, unknown>).sourceUrl) ? (
                  <a href={str((article.extra as Record<string, unknown>).sourceUrl)} target="_blank" rel="noreferrer" className={c('cardHint')} style={{ marginTop: 8, display: 'inline-block' }}>看原文 ↗</a>
                ) : null}
              </div>
            ) : previewTab === 'refs' ? (
              <div className={c('videoCard')}>
                {sourceImages.length === 0 ? (
                  <div>
                    <div className={c('cardHint')}>{fetchingSource ? '⏳ 正在自动拉取原图…' : '没有参考原图(此稿非爆款来源)。'}</div>
                    {/* 拉取是自动的(去创作第一步),不设常驻按钮;仅自动拉失败后留一个重试兜底。 */}
                    {!fetchingSource && sourceUrl ? (
                      <button
                        type="button"
                        className={c('btn')}
                        style={{ marginTop: 8 }}
                        onClick={() => void fetchSourceNow(sourceUrl)}
                      >
                        自动拉取失败?点此重试
                      </button>
                    ) : null}
                  </div>
                ) : (
                  // 九宫格:一行 3 张缩略图,区域内部独立滚动(2026-07-18 用户拍板:图太大+滑整页麻烦)。
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6, maxHeight: '58vh', overflowY: 'auto', paddingRight: 4 }}>
                    {sourceImages.map((url, i) => (
                      <div key={url} style={{ display: 'flex', flexDirection: 'column', gap: 3, outline: url === refImage ? '2px solid #e8582e' : 'none', outlineOffset: 2, borderRadius: 8 }}>
                        <img
                          src={url}
                          alt={`参考 ${i + 1}`}
                          title="点看大图"
                          style={{ width: '100%', aspectRatio: '3 / 4', objectFit: 'cover', borderRadius: 8, cursor: 'zoom-in' }}
                          onClick={() => setLightboxUrl(url)}
                        />
                        <div style={{ display: 'flex', gap: 3 }}>
                          <button
                            type="button"
                            className={`${c('btn')} ${url === refImage ? c('btnPrimary') : ''}`}
                            style={{ flex: 1, padding: '2px 4px', fontSize: 11 }}
                            title="设为参考图:去左边写提示词生成同款风格质感的新图(不盗原图)"
                            onClick={() => setRefImage(url === refImage ? '' : url)}
                          >
                            {url === refImage ? '✓参考' : '作参考'}
                          </button>
                          <button
                            type="button"
                            className={c('btn')}
                            style={{ padding: '2px 5px', fontSize: 11 }}
                            title="确实要用这张原图 → 放进图集(版权自负,别人的图慎发)"
                            onClick={() => editArticle({ extra: { noteImages: [...latestNoteImages(), url] } })}
                          >
                            +集
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                <div className={c('cardHint')} style={{ marginTop: 6 }}>一行3张·区内滚动;原图仅供参考,不自动进图集/发布。</div>
              </div>
            ) : (
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
