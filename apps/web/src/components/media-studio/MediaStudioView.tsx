// 公众号创作台（Media Studio）— spec: specs/current/media-studio.md
//
// 四个子导航（选题/写作/排版/发布）围绕同一个持久「文章」实体，既能各自
// 独立使用（自由排版、手动选题），又天然串联（选题→写作→排版→发布）。
// 排版与发布是确定性产品代码（daemon 渲染器/发布器），不经过智能体。
//
// 文案约定：本模块为客户定制（纯中文交付），文案直接内联，不进 i18n 矩阵。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AccountProfileView,
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaSnippet,
  MediaTopic,
  StudioAiTaskKind,
  UpdateMediaArticleRequest,
} from '@open-design/contracts';
import { Icon } from '../Icon';
import { fetchPlatformAccounts } from '../../providers/daemon';
import {
  createStudioAiTask,
  createStudioArticle,
  createStudioSnippet,
  createStudioTopic,
  deleteStudioArticle,
  deleteStudioSnippet,
  deleteStudioTopic,
  fetchStudioArticle,
  fetchStudioArticles,
  fetchStudioPublishes,
  fetchStudioSnippets,
  fetchStudioTopics,
  generateArticleImage,
  lintStudioArticle,
  type StudioLintHit,
  publishStudioArticle,
  renderStudioArticle,
  renderStudioPreview,
  updateStudioArticle,
  uploadStudioAsset,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, KnowledgePanel, VersionsCard } from './StudioSharedCards';
import { openStudioBrowser } from '../../providers/media-studio';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { useOrphanRun } from './useOrphanRun';
import { loadPreferredImageModel, savePreferredImageModel } from './image-model-pref';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'wechat-mp';
const LAST_ARTICLE_KEY = 'open-design:studio:last-article';
// 用户字号偏好：改一次即成默认，之后新建的文章自动沿用（写进文章 extra，
// 发布端同源可见）。已有文章保持各自的设置不被追改。
const FONT_DEFAULTS_KEY = 'open-design:studio:font-defaults';

function loadFontDefaults(): { body: number; heading: number } | null {
  try {
    const raw = window.localStorage.getItem(FONT_DEFAULTS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { body?: unknown; heading?: unknown };
    const body = typeof parsed.body === 'number' ? parsed.body : 15;
    const heading = typeof parsed.heading === 'number' ? parsed.heading : 20;
    return { body, heading };
  } catch {
    return null;
  }
}

function saveFontDefaults(body: number, heading: number): void {
  if (body === 15 && heading === 20) window.localStorage.removeItem(FONT_DEFAULTS_KEY);
  else window.localStorage.setItem(FONT_DEFAULTS_KEY, JSON.stringify({ body, heading }));
}

type StudioTab = 'topics' | 'write' | 'cover' | 'images' | 'publish' | 'list' | 'knowledge';

const TABS: Array<{ id: StudioTab; label: string; step: string; optional?: boolean }> = [
  { id: 'topics', label: '选题', step: '1' },
  { id: 'write', label: '写作', step: '2' },
  { id: 'cover', label: '封面', step: '3' },
  { id: 'images', label: '配图', step: '4', optional: true },
  { id: 'publish', label: '发布', step: '5' },
];

/** 写作风格固定为「信息服务攻略」（2026-07-06 用户拍板只留一种）。 */
const FIXED_ARTICLE_TYPE = '信息服务攻略';
const WORD_COUNTS = ['800-1200', '1500-2000', '2500-3500', '4000 以上'];

/** 生图模型入口——将来接新模型往这里加一行即可（id 透传给 daemon 分发）。 */
const IMAGE_MODELS: Array<{ id: string; label: string }> = [
  { id: 'qwen', label: '千问 · 图像2.0 Pro（默认）' },
  // 火山按版本选：id 里 volc: 后面就是方舟的 Model ID（不带即用最新默认）。
  { id: 'volc', label: '火山 · Seedream 5.0（最新）' },
  { id: 'volc:doubao-seedream-5-0-lite-260128', label: '火山 · Seedream 5.0 Lite（快·联网）' },
  { id: 'volc:doubao-seedream-4-5-251128', label: '火山 · Seedream 4.5' },
  { id: 'gemini', label: 'Gemini（备用）' },
];

/** 正文里已生成/已插入的图片：![alt](src)。 */
const BODY_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

interface BodyImage {
  alt: string;
  src: string;
  md: string;
}

function parseBodyImages(bodyMd: string): BodyImage[] {
  const out: BodyImage[] = [];
  for (const m of bodyMd.matchAll(BODY_IMAGE_RE)) {
    out.push({ alt: m[1] ?? '', src: m[2] ?? '', md: m[0] ?? '' });
  }
  return out;
}

const IMAGE_STYLES: Array<{ id: string; label: string }> = [
  { id: 'whiteboard', label: '白板手绘（默认）' },
  { id: 'illustrated', label: '暖插画（带文字）' },
  { id: 'clean', label: '纯净插画（无文字）' },
];

/** 正文里的配图标注：<!-- IMAGE_1: 描述, 4:3 --> / <!-- IMAGE_COVER: 描述, 16:9 --> */
const IMAGE_MARKER_RE = /<!--\s*IMAGE_([A-Za-z0-9]+)\s*:\s*([\s\S]*?)-->/g;

interface ImageMarker {
  marker: string;
  description: string;
  ratio: string;
}

function parseImageMarkers(bodyMd: string): ImageMarker[] {
  const out: ImageMarker[] = [];
  for (const m of bodyMd.matchAll(IMAGE_MARKER_RE)) {
    const raw = (m[2] ?? '').trim();
    const ratioMatch = raw.match(/[,，]\s*(\d+:\d+)\s*$/);
    out.push({
      marker: m[1] ?? '',
      description: ratioMatch ? raw.slice(0, ratioMatch.index).trim() : raw,
      ratio: ratioMatch?.[1] ?? (String(m[1]).toUpperCase() === 'COVER' ? '16:9' : '4:3'),
    });
  }
  return out;
}

const SKINS: Array<{ id: string; name: string; color: string; hint: string }> = [
  { id: 'kaiti', name: '深红棕楷体', color: '#8B1E22', hint: '严肃长文（原默认）' },
  { id: 'moyu-green', name: '摸鱼绿 · 杂志风', color: '#059669', hint: '教程/测评/清单，信息密度高' },
  { id: 'red-white', name: '红白色系 · 编辑风', color: '#DC2626', hint: '深度分析/观点，力量感' },
  { id: 'graphite', name: '石墨极简', color: '#52525B', hint: '科技评论/专业观点，克制理性' },
  { id: 'zen', name: '留白禅意', color: '#4A5D52', hint: '深度随笔/极简生活，呼吸感' },
  { id: 'ticket', name: '摸鱼票据', color: '#059669', hint: '测评/工具对比，票据质感' },
  { id: 'olive', name: '橄榄手记 · 内刊风', color: '#ed7b2f', hint: '案例复盘/系统说明，内刊质感' },
];

const STATUS_LABEL: Record<MediaArticle['status'], { text: string; chip: string }> = {
  writing: { text: '写作中', chip: 'chipAmber' },
  rendered: { text: '已排版', chip: 'chipBlue' },
  published: { text: '已发草稿', chip: 'chipGreen' },
};

/** 公众号标题上限 64 字节（约 21 个中文字符）——超了 draft/add 报 45166。 */
function titleBytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
}

/** 预览外壳：手机宽度白底 + 标题区，内容就是 daemon 渲染的 <section> 片段。 */
function previewDoc(title: string, fragment: string): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body{margin:0;background:#ededed;font-family:-apple-system,BlinkMacSystemFont,'PingFang SC','Segoe UI',sans-serif;}
  .wrap{max-width:414px;margin:0 auto;background:#fff;min-height:100vh;padding:22px 16px 48px;box-sizing:border-box;}
  h1.__t{font-size:22px;line-height:1.4;margin:0 0 6px;font-weight:700;color:#111;}
  .__meta{font-size:13px;color:#a0a0a0;margin-bottom:18px;}
  img{max-width:100%;}
  </style></head><body><div class="wrap">${
    title ? `<h1 class="__t">${escapeHtml(title)}</h1><div class="__meta">公众号预览 · 实时</div>` : ''
  }${fragment}</div></body></html>`;
}

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MediaStudioView(): JSX.Element {
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<StudioTab>('write');
  const [topics, setTopics] = useState<MediaTopic[]>([]);
  const [snippets, setSnippets] = useState<MediaSnippet[]>([]);
  const [accounts, setAccounts] = useState<AccountProfileView[]>([]);
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewNotes, setPreviewNotes] = useState<string[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [publishes, setPublishes] = useState<MediaPublishRecord[]>([]);
  const [publishing, setPublishing] = useState(false);
  const [publishNotice, setPublishNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [lintHits, setLintHits] = useState<StudioLintHit[]>([]);
  const [renderNotice, setRenderNotice] = useState<string | null>(null);
  // AI 任务折叠面板（每步的智能体动作共用一个面板，一次跑一个）
  const [aiTask, setAiTask] = useState<StudioAiTask | null>(null);
  const aiSeqRef = useRef(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStage, setAiStage] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiPanelRef = useRef<StudioAiPanelHandle | null>(null);
  const aiAnchorRef = useRef<HTMLDivElement | null>(null);
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [aiWordCount, setAiWordCount] = useState('1500-2000');
  const [reviseNote, setReviseNote] = useState('');
  const [imageBusy, setImageBusy] = useState<string | null>(null);
  const [snippetDraft, setSnippetDraft] = useState<{ slot: 'header' | 'footer'; name: string } | null>(null);
  const [snippetManage, setSnippetManage] = useState<'header' | 'footer' | null>(null);
  const [imageNotice, setImageNotice] = useState<string | null>(null);
  // 预览宽度：默认全宽（用户拍板），手机 375px 作为可选切换。
  const [phonePreview, setPhonePreview] = useState(false);
  // 封面候选：一次生成 2 张对比选用；点「用这张」才落为封面。
  const [coverCandidates, setCoverCandidates] = useState<string[]>([]);
  const [coverGenBusy, setCoverGenBusy] = useState(false);
  // 划选改写：正文选中 ≥10 字时，「按我说的改」只改选中段。
  const [reviseSelection, setReviseSelection] = useState('');
  // 配图操作一步撤销：重生成/移除前记正文快照，正文没再动过就能一键还原。
  const [imageUndo, setImageUndo] = useState<{ prevBodyMd: string; afterBodyMd: string; label: string } | null>(null);
  const [imageLightbox, setImageLightbox] = useState('');

  const articleRef = useRef<MediaArticle | null>(null);
  articleRef.current = article;
  const aiTaskRef = useRef<StudioAiTask | null>(null);
  aiTaskRef.current = aiTask;
  // 页面刷新/热更后仍在跑的后台任务：恢复感知（亮条+驱动轮询+可中止）。
  const { orphan, cancelOrphan } = useOrphanRun(aiTask === null);
  const effectiveAiRunning = aiRunning || orphan != null;
  const saveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ id: string; patch: UpdateMediaArticleRequest } | null>(null);

  // ---- data loading ----
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
    setPublishNotice(null);
    setRenderNotice(null);
  }, []);

  useEffect(() => {
    void (async () => {
      const list = await refreshArticles();
      const remembered = window.localStorage.getItem(LAST_ARTICLE_KEY);
      const pick = list.find((a) => a.id === remembered) ?? list[0] ?? null;
      if (pick) await selectArticle(pick.id);
      else setTab('topics');
      const [topicList, snippetList, accountsResp] = await Promise.all([
        fetchStudioTopics(PLATFORM),
        fetchStudioSnippets(PLATFORM),
        fetchPlatformAccounts(),
      ]);
      setTopics(topicList ?? []);
      setSnippets(snippetList);
      const platformAccounts = accountsResp?.platforms.find((p) => p.id === PLATFORM)?.accounts ?? [];
      setAccounts(platformAccounts);
    })();
  }, [refreshArticles, selectArticle]);

  // ---- autosave ----
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
    setArticle((a) =>
      a && a.id === updated.id ? { ...a, status: updated.status, updatedAt: updated.updatedAt } : a,
    );
    setArticles((list) =>
      list
        ? list.map((s) =>
            s.id === updated.id
              ? { ...s, title: updated.title, skin: updated.skin, status: updated.status, updatedAt: updated.updatedAt }
              : s,
          )
        : list,
    );
  }, []);

  const editArticle = useCallback(
    (patch: UpdateMediaArticleRequest) => {
      const current = articleRef.current;
      if (!current) return;
      setArticle((a) => (a ? ({ ...a, ...patch } as MediaArticle) : a));
      const pending = pendingRef.current;
      pendingRef.current =
        pending && pending.id === current.id
          ? { id: current.id, patch: { ...pending.patch, ...patch } }
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

  // Cmd/Ctrl+S：跳过防抖立即落库（徽标即反馈，不弹 toast）。
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

  // ---- live preview（防抖调无状态渲染；写作页所见即排版产物） ----
  const articleExtra = (article?.extra ?? {}) as Record<string, unknown>;
  const bodyFontSize = typeof articleExtra.bodyFontSize === 'number' ? articleExtra.bodyFontSize : 15;
  const headingFontSize = typeof articleExtra.headingFontSize === 'number' ? articleExtra.headingFontSize : 20;
  const previewSource = article
    ? {
        skin: article.skin,
        headerMd: article.headerMd,
        bodyMd: article.bodyMd,
        footerMd: article.footerMd,
        bodyFontSize,
        headingFontSize,
      }
    : null;
  // 调字号 = 同时更新本篇 + 记为个人默认（新建文章自动沿用，避免每篇重调）。
  const applyFontSizes = (nextBody: number, nextHeading: number) => {
    saveFontDefaults(nextBody, nextHeading);
    const isDefault = nextBody === 15 && nextHeading === 20;
    editArticle({
      extra: {
        bodyFontSize: isDefault ? null : nextBody,
        headingFontSize: isDefault ? null : nextHeading,
      },
    });
  };

  const previewSourceRef = useRef(previewSource);
  previewSourceRef.current = previewSource;
  const previewKey = previewSource ? JSON.stringify(previewSource) : '';
  useEffect(() => {
    if (!previewKey) {
      setPreviewHtml('');
      setPreviewNotes([]);
      return;
    }
    const timer = window.setTimeout(() => {
      const src = previewSourceRef.current;
      if (!src) return;
      void (async () => {
        const r = await renderStudioPreview({ platform: PLATFORM, ...src });
        if (r) {
          setPreviewHtml(r.html);
          setPreviewNotes(r.notes);
        }
      })();
    }, 450);
    return () => window.clearTimeout(timer);
  }, [previewKey]);

  // ---- publish records + 敏感词扫描 ----
  useEffect(() => {
    if (tab !== 'publish' || !article) return;
    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
    void lintStudioArticle(PLATFORM, article.id).then(setLintHits);
  }, [tab, article?.id, article?.updatedAt]);

  // ---- AI 任务（每步的智能体动作） ----
  const startAiTask = useCallback(
    async (kind: StudioAiTaskKind, input?: { note?: string; articleType?: string; wordCount?: string; picked?: PickedHit[] }) => {
      await flushSave();
      const current = articleRef.current;
      const created = await createStudioAiTask(PLATFORM, {
        kind,
        ...(kind !== 'topics' && current ? { articleId: current.id } : {}),
        input: {
          ...(input?.note ? { note: input.note } : {}),
          ...(input?.articleType ? { articleType: input.articleType } : {}),
          ...(input?.wordCount ? { wordCount: input.wordCount } : {}),
          ...(input?.picked && input.picked.length > 0 ? { picked: input.picked } : {}),
          ...(current?.accountId ? { accountId: current.accountId } : {}),
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

  // AI 任务运行中每 3 秒轮询——agent 中途经 od studio 写回的内容实时上屏
  // （不等任务结束）。有未落库的本地编辑时跳过，绝不覆盖用户正在打的字。
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
          // 兜底告警：写作类任务「完成」但正文仍空 = agent 没执行写回
          //（曾发生把稿子写成本地文件交差）。明确告诉用户而不是静默。
          const t = aiTaskRef.current;
          if (outcome === 'done' && a && t && /写/.test(t.title) && !a.bodyMd.trim()) {
            studioToast.err('任务结束了但正文没有写回——请重跑一次；再发生请反馈');
          }
        });
      }
    },
    [refreshArticles],
  );

  // ---- actions ----
  async function handleCreateArticle(fromTopic?: MediaTopic) {
    await flushSave();
    const created = await createStudioArticle(PLATFORM, {
      ...(fromTopic ? { fromTopicId: fromTopic.id, title: fromTopic.title, topic: fromTopic.title } : {}),
      // 账号（人设）在创建时就绑定——AI 写作从第一版就按人设写。
      ...(accounts[0] ? { accountId: accounts[0].id } : {}),
    });
    if (!created) return;
    await refreshArticles();
    setArticle(created);
    // startAiTask 走 articleRef 取当前文章；setArticle 要到下次渲染才同步
    // 到 ref，这里手动先同步，让「去写作」能立刻带起 AI 写作。
    articleRef.current = created;
    // 用户字号偏好自动带入新文章（写进 extra，发布端同源）。
    const fontDefaults = loadFontDefaults();
    if (fontDefaults) {
      editArticle({ extra: { bodyFontSize: fontDefaults.body, headingFontSize: fontDefaults.heading } });
    }
    window.localStorage.setItem(LAST_ARTICLE_KEY, created.id);
    setTab('write');
    if (fromTopic) {
      setTopics((list) => list.map((t) => (t.id === fromTopic.id ? { ...t, status: 'used' } : t)));
      // 从选题过来 = 意图明确就是要写这篇——直接开写，不用再点一次。
      studioToast.ok('已建稿，AI 开始写作（右上角可看进度）');
      void startAiTask('write', { articleType: FIXED_ARTICLE_TYPE, wordCount: aiWordCount });
    } else {
      studioToast.ok('已新建文章');
    }
  }

  async function handleDeleteArticle() {
    if (!article) return;
    if (!window.confirm(`删除文章「${article.title || '(无标题)'}」？发布记录会一并删除。`)) return;
    pendingRef.current = null;
    await deleteStudioArticle(PLATFORM, article.id);
    const list = await refreshArticles();
    await selectArticle(list[0]?.id ?? null);
  }

  async function handleSaveRender() {
    if (!article) return;
    await flushSave();
    const r = await renderStudioArticle(PLATFORM, article.id, article.skin);
    if (r?.article) {
      setArticle(r.article);
      setRenderNotice(`已保存排版（${SKINS.find((s) => s.id === r.skin)?.name ?? r.skin}）`);
      await refreshArticles();
    } else {
      setRenderNotice('保存排版失败');
    }
  }

  async function handleCopyHtml() {
    if (!previewHtml) return;
    try {
      await navigator.clipboard.writeText(previewHtml);
      setRenderNotice('已复制 HTML 到剪贴板');
    } catch {
      setRenderNotice('复制失败——浏览器未授权剪贴板');
    }
  }

  async function handlePublish() {
    if (!article || publishing) return;
    const accountId = article.accountId ?? accounts[0]?.id ?? '';
    if (!accountId) {
      setPublishNotice({ ok: false, text: '还没有公众号账号——先去「账号」页添加一个（含 AppID/AppSecret）' });
      return;
    }
    setPublishing(true);
    setPublishNotice(null);
    await flushSave();
    const result = await publishStudioArticle(PLATFORM, article.id, accountId);
    setPublishing(false);
    if (result.error) {
      setPublishNotice({ ok: false, text: result.error });
    } else if (result.record) {
      setPublishNotice({
        ok: true,
        text: `已发到草稿箱（media_id: ${result.record.draftMediaId}）。去公众号后台确认群发——这里绝不自动正式发布。`,
      });
      if (result.article) setArticle(result.article);
      await refreshArticles();
    }
    if (article) setPublishes(await fetchStudioPublishes(PLATFORM, article.id));
  }


  // ---- sub renders ----
  const activeSummaryStatus = article ? STATUS_LABEL[article.status] : null;

  function renderSnippetControls(slot: 'header' | 'footer', value: string) {
    const slotSnippets = snippets.filter((sn) => sn.slot === slot);
    const slotName = slot === 'header' ? '开头' : '结尾';
    const draftOpen = snippetDraft?.slot === slot;
    return (
      <>
        <div className={c('row')}>
          {slotSnippets.length > 0 ? (
            <select
              className={c('select')}
              value=""
              onChange={(e) => {
                const sn = slotSnippets.find((x) => x.id === e.target.value);
                if (sn) editArticle(slot === 'header' ? { headerMd: sn.contentMd } : { footerMd: sn.contentMd });
              }}
            >
              <option value="" disabled>
                插入固定{slotName}…
              </option>
              {slotSnippets.map((sn) => (
                <option key={sn.id} value={sn.id}>
                  {sn.name}
                </option>
              ))}
            </select>
          ) : null}
          <label className={c('btn')} style={{ cursor: 'pointer' }} title={`上传图片插入固定${slotName}`}>
            <Icon name="upload" size={14} /> 插入图片
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                const current = articleRef.current;
                if (!file || !current) return;
                void (async () => {
                  const result = await uploadStudioAsset(PLATFORM, current.id, file);
                  if (result.error) {
                    setImageNotice(result.error);
                    return;
                  }
                  if (result.url) {
                    const md = `![固定${slotName}图](${result.url})`;
                    if (slot === 'header') {
                      editArticle({ headerMd: current.headerMd ? `${current.headerMd}\n\n${md}` : md });
                    } else {
                      editArticle({ footerMd: current.footerMd ? `${current.footerMd}\n\n${md}` : md });
                    }
                  }
                })();
              }}
            />
          </label>
          <button
            type="button"
            className={c('btn')}
            disabled={!value.trim()}
            onClick={() => setSnippetDraft(draftOpen ? null : { slot, name: '' })}
          >
            存为片段
          </button>
          {slotSnippets.length > 0 ? (
            <button
              type="button"
              className={c('btn')}
              onClick={() => setSnippetManage(snippetManage === slot ? null : slot)}
            >
              管理（{slotSnippets.length}）
            </button>
          ) : null}
        </div>
        {draftOpen ? (
          <div className={c('row')}>
            <input
              className={`${c('input')} ${c('grow')}`}
              value={snippetDraft?.name ?? ''}
              placeholder={`给这段固定${slotName}起个名字…`}
              autoFocus
              onChange={(e) => setSnippetDraft({ slot, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && snippetDraft?.name.trim()) void saveSnippetDraft(slot, value);
                if (e.key === 'Escape') setSnippetDraft(null);
              }}
            />
            <button
              type="button"
              className={`${c('btn')} ${c('btnPrimary')}`}
              disabled={!snippetDraft?.name.trim()}
              onClick={() => void saveSnippetDraft(slot, value)}
            >
              保存
            </button>
            <button type="button" className={c('btn')} onClick={() => setSnippetDraft(null)}>
              取消
            </button>
          </div>
        ) : null}
        {snippetManage === slot ? (
          <div className={c('records')}>
            {slotSnippets.map((sn) => (
              <div key={sn.id} className={c('record')}>
                <strong>{sn.name}</strong>
                <span className={c('cardHint')}>{sn.contentMd.replace(/\s+/g, '').length} 字</span>
                <span className={c('headSpacer')} />
                <button
                  type="button"
                  className={`${c('btn')} ${c('btnDanger')}`}
                  onClick={async () => {
                    if (await deleteStudioSnippet(PLATFORM, sn.id)) {
                      setSnippets((list) => list.filter((x) => x.id !== sn.id));
                    }
                  }}
                >
                  删除
                </button>
              </div>
            ))}
          </div>
        ) : null}
      </>
    );
  }

  async function saveSnippetDraft(slot: 'header' | 'footer', content: string) {
    const name = snippetDraft?.name.trim();
    if (!name) return;
    const created = await createStudioSnippet(PLATFORM, { slot, name, contentMd: content });
    if (created) {
      setSnippets((list) => [created, ...list]);
      setSnippetDraft(null);
    }
  }

  function renderTopicsTab() {
    return (
      <TopicsTab
        platform={PLATFORM}
        aiOnly
        topics={topics}
        onAdd={async (draft) => {
          const created = await createStudioTopic(PLATFORM, draft);
          if (created) setTopics((list) => [created, ...list]);
        }}
        onDelete={async (id) => {
          if (await deleteStudioTopic(PLATFORM, id)) {
            setTopics((list) => list.filter((t) => t.id !== id));
          }
        }}
        onWrite={(topic) => void handleCreateArticle(topic)}
        onAiFind={(note, picked) => void startAiTask('topics', { note, ...(picked && picked.length > 0 ? { picked } : {}) })}
        aiBusy={aiTask !== null}
      />
    );
  }

  function renderWriteTab() {
    if (!article) {
      return (
        <div className={c('empty')}>
          <div>还没有文章。从「选题」挑一个开始，或直接新建一篇空白文章。</div>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建文章
          </button>
        </div>
      );
    }
    return (
      <>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            AI 写作
            <span className={c('cardHint')}>一键全流程：先调研素材 → 按人设写（信息服务风格）→ 自动清 AI 腔；选个目标字数即可</span>
          </div>
          <div className={c('row')}>
            <select className={c('select')} value={aiWordCount} title="目标字数" onChange={(e) => setAiWordCount(e.target.value)}>
              {WORD_COUNTS.map((t) => (
                <option key={t} value={t}>
                  {t} 字
                </option>
              ))}
            </select>
            <button
              type="button"
              className={`${c('btn')} ${c('btnPrimary')}`}
              onClick={() => void startAiTask('write', { articleType: FIXED_ARTICLE_TYPE, wordCount: aiWordCount })}
            >
              <Icon name="sparkles" size={14} /> AI 写一版
            </button>

          </div>
          {reviseSelection ? (
            <div className={c('row')}>
              <span className={`${c('chip')} ${c('chipBlue')}`}>
                已选中正文 {reviseSelection.trim().length} 字 · 将只改写这一段
              </span>
              <button type="button" className={c('btn')} onClick={() => setReviseSelection('')}>
                取消选中
              </button>
            </div>
          ) : null}
          <div className={c('row')}>
            <input
              className={`${c('input')} ${c('grow')}`}
              value={reviseNote}
              placeholder={
                reviseSelection
                  ? '这一段想怎么改？例：更口语、压缩到一半、加个例子…'
                  : '想怎么改？例：第二段太啰嗦、标题换一个、结尾加行动引导…（想只改某段：先在正文里选中它）'
              }
              onChange={(e) => setReviseNote(e.target.value)}
            />
            <button
              type="button"
              className={c('btn')}
              disabled={!reviseNote.trim()}
              onClick={() => {
                const note = reviseSelection
                  ? `【只改写下面选中的段落，文章其余部分一字不动】\n选中段落：\n${reviseSelection.trim()}\n\n修改要求：${reviseNote.trim()}`
                  : reviseNote.trim();
                void startAiTask('revise', { note });
                setReviseNote('');
                setReviseSelection('');
              }}
            >
              {reviseSelection ? '只改选中段' : '按我说的改'}
            </button>
          </div>
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            标题
            <span className={c('cardHint')} style={titleBytes(article.title) > 64 ? { color: '#b0342c', fontWeight: 600 } : undefined}>
              只进公众号标题栏 · {titleBytes(article.title)}/64 字节{titleBytes(article.title) > 64 ? '（超了，发布会失败）' : ''}
            </span>
          </div>
          <input
            className={c('input')}
            value={article.title}
            placeholder="文章标题…"
            onChange={(e) => editArticle({ title: e.target.value })}
          />
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            固定开头
            <span className={c('cardHint')}>可选 · 文字+图片都行（关注引导图/栏目头图），可存成片段跨文章复用</span>
          </div>
          <textarea
            className={c('textarea')}
            value={article.headerMd}
            placeholder="例：你好，我是 XX。这是「XX 栏目」第 N 篇…"
            onChange={(e) => editArticle({ headerMd: e.target.value })}
          />
          {renderSnippetControls('header', article.headerMd)}
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            正文（Markdown）
            <span className={c('cardHint')}>
              ## 小节标题 · **加粗** · &gt; 引用 · 1. 列表 · ![图](地址) · {article.bodyMd.length} 字
            </span>
          </div>
          <textarea
            className={`${c('textarea')} ${c('textareaLarge')}`}
            value={article.bodyMd}
            placeholder={'从导语直接开始写（不要在开头再写一遍大标题）。\n\n## 第一个小节\n\n正文…'}
            onChange={(e) => {
              editArticle({ bodyMd: e.target.value });
              if (reviseSelection) setReviseSelection('');
            }}
            onSelect={(e) => {
              // 划选 ≥10 字即进入「只改这段」模式；点别处（选区折叠）自动退出。
              const t = e.currentTarget;
              const sel = t.value.slice(t.selectionStart ?? 0, t.selectionEnd ?? 0);
              setReviseSelection(sel.trim().length >= 10 ? sel : '');
            }}
          />
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            固定结尾
            <span className={c('cardHint')}>可选 · 文字+图片都行（二维码/签名档/引导在看图），可存成片段跨文章复用</span>
          </div>
          <textarea
            className={c('textarea')}
            value={article.footerMd}
            placeholder="例：> 关注我，每周三篇实战干货。"
            onChange={(e) => editArticle({ footerMd: e.target.value })}
          />
          {renderSnippetControls('footer', article.footerMd)}
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            排版皮肤
            <span className={c('cardHint')}>右侧预览就是最终草稿的样子（所见即所发）；切换即时生效</span>
          </div>
          <div className={c('skinGrid')}>
            {SKINS.map((s) => {
              // 已下架皮肤（如 purple）的旧文章：渲染器回退 kaiti，高亮也跟着回退。
              const activeSkin = SKINS.some((x) => x.id === article.skin) ? article.skin : 'kaiti';
              return (
                <button
                  key={s.id}
                  type="button"
                  className={`${c('skinCard')}${activeSkin === s.id ? ` ${c('skinCardActive')}` : ''}`}
                  onClick={() => editArticle({ skin: s.id })}
                >
                  <span className={c('skinSwatch')} style={{ background: s.color }} />
                  <span className={c('skinName')}>{s.name}</span>
                  <span className={c('skinHint')}>{s.hint}</span>
                </button>
              );
            })}
          </div>
          <div className={c('row')}>
            <span className={c('cardHint')} title="调整后自动成为你的默认字号——以后新建的文章直接沿用">正文字号</span>
            <button
              type="button"
              className={c('btn')}
              disabled={bodyFontSize <= 12}
              onClick={() => applyFontSizes(Math.max(12, bodyFontSize - 1), headingFontSize)}
            >
              A−
            </button>
            <span style={{ fontSize: 12.5, minWidth: 38, textAlign: 'center' }}>{bodyFontSize}px</span>
            <button
              type="button"
              className={c('btn')}
              disabled={bodyFontSize >= 22}
              onClick={() => applyFontSizes(Math.min(22, bodyFontSize + 1), headingFontSize)}
            >
              A＋
            </button>
            <span className={c('cardHint')} style={{ marginLeft: 12 }}>小节标题</span>
            <button
              type="button"
              className={c('btn')}
              disabled={headingFontSize <= 14}
              onClick={() => applyFontSizes(bodyFontSize, Math.max(14, headingFontSize - 1))}
            >
              A−
            </button>
            <span style={{ fontSize: 12.5, minWidth: 38, textAlign: 'center' }}>{headingFontSize}px</span>
            <button
              type="button"
              className={c('btn')}
              disabled={headingFontSize >= 30}
              onClick={() => applyFontSizes(bodyFontSize, Math.min(30, headingFontSize + 1))}
            >
              A＋
            </button>
            {bodyFontSize !== 15 || headingFontSize !== 20 ? (
              <button
                type="button"
                className={c('btn')}
                title="恢复皮肤默认字号（正文 15 / 标题 20），并清除个人默认"
                onClick={() => applyFontSizes(15, 20)}
              >
                重置
              </button>
            ) : null}
          </div>
          <div className={c('row')}>
            <button type="button" className={c('btn')} onClick={() => void handleSaveRender()}>
              保存排版
            </button>
            <button type="button" className={c('btn')} disabled={!previewHtml} onClick={() => void handleCopyHtml()}>
              复制 HTML
            </button>
            {renderNotice ? <span className={c('saveHint')}>{renderNotice}</span> : null}
          </div>
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
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('cover')}>
            下一步：封面 <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </>
    );
  }

  function renderCoverTab() {
    if (!article) {
      return (
        <div className={c('empty')}>
          <div>封面属于某篇文章——先去「写作」新建一篇。</div>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建文章
          </button>
        </div>
      );
    }
    const coverMarker = parseImageMarkers(article.bodyMd).find((m) => m.marker.toUpperCase() === 'COVER') ?? null;
    const coverSnippets = snippets.filter((s) => s.slot === 'cover');
    // 一次并行出 2 张候选（asCover:false 只产资产不落库），点「用这张」才成为封面。
    const generateCover = async (desc: string, style: string, referenceImage: string, model: string) => {
      setCoverGenBusy(true);
      setImageNotice(null);
      const request = {
        description: desc,
        style,
        model,
        ratio: '16:9',
        asCover: false,
        ...(referenceImage.trim() ? { referenceImage: referenceImage.trim() } : {}),
      };
      const results = await Promise.all([
        generateArticleImage(PLATFORM, article.id, request),
        generateArticleImage(PLATFORM, article.id, request),
      ]);
      setCoverGenBusy(false);
      const urls = results.flatMap((r) => ('error' in r ? [] : [r.url]));
      const genNote = results.map((r) => ('error' in r ? null : r.note)).find(Boolean);
      if (genNote) studioToast.info(genNote);
      if (urls.length === 0) {
        const first = results[0];
        setImageNotice('error' in first ? first.error : '生成失败');
        return;
      }
      // 去重兜底：同 URL 只留一条（React key 必须唯一）。
      setCoverCandidates((prev) => [...new Set([...urls, ...prev])].slice(0, 6));
      studioToast.ok(urls.length === 2 ? '2 张候选已生成，对比后点「用这张」' : '生成 1 张候选（另一张失败）');
    };
    const saveCoverToLibrary = async () => {
      if (!article.coverSource) return;
      const name = window.prompt('给这张封面起个名字（存入封面库，后续文章可复用）：', article.title.slice(0, 12));
      if (!name || !name.trim()) return;
      const created = await createStudioSnippet(PLATFORM, {
        slot: 'cover',
        name: name.trim(),
        contentMd: article.coverSource,
      });
      if (created) {
        setSnippets((list) => [created, ...list]);
        setImageNotice(`封面「${created.name}」已存入封面库`);
      }
    };
    return (
      <>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            当前封面（16:9 · 发布必需）
            <span className={c('cardHint')}>
              {article.coverSource ? '' : '还没有封面——公众号草稿必须有封面，先在下面生成或从封面库挑一张'}
            </span>
          </div>
          {article.coverSource ? (
            <div className={c('row')}>
              <img
                className={c('coverPreview')}
                src={article.coverSource}
                alt="当前封面"
                title="点击看大图"
                style={{ cursor: 'zoom-in' }}
                onClick={() => setImageLightbox(article.coverSource)}
              />
              <div className={c('row')}>
                <button type="button" className={c('btn')} onClick={() => void saveCoverToLibrary()}>
                  存入封面库
                </button>
                <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => editArticle({ coverSource: '' })}>
                  移除
                </button>
              </div>
            </div>
          ) : null}
          <div className={c('row')}>
            <label className={c('btn')} style={{ cursor: 'pointer' }}>
              <Icon name="upload" size={14} /> 用本机图片作封面
              <input
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = '';
                  if (!file) return;
                  void (async () => {
                    setImageNotice('上传中…');
                    const result = await uploadStudioAsset(PLATFORM, article.id, file);
                    if (result.error) setImageNotice(result.error);
                    else if (result.url) {
                      editArticle({ coverSource: result.url });
                      setImageNotice('本机图片已设为封面');
                    }
                  })();
                }}
              />
            </label>
          </div>
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            生成封面
            <span className={c('cardHint')}>提示词可自由改；给参考图（URL 或本机绝对路径）可让画面跟着参考走</span>
          </div>
          <CoverGenerator
            initialDescription={coverMarker?.description ?? article.title}
            busy={coverGenBusy}
            onGenerate={(desc, style, ref, model) => void generateCover(desc, style, ref, model)}
            onUploadReference={async (file) => {
              const result = await uploadStudioAsset(PLATFORM, article.id, file);
              if (result.error) {
                setImageNotice(result.error);
                return null;
              }
              return result.url ?? null;
            }}
          />
          {coverGenBusy || coverCandidates.length > 0 ? (
            <div className={c('coverGrid')}>
              {coverGenBusy
                ? [0, 1].map((i) => <div key={`cover-skeleton-${i}`} className={c('coverSkeleton')} />)
                : null}
              {coverCandidates.map((url) => (
                <div key={url} className={c('coverCard')}>
                  <img
                    className={c('coverThumb')}
                    src={url}
                    alt="候选封面"
                    title="点击看大图"
                    style={{ cursor: 'zoom-in' }}
                    onClick={() => setImageLightbox(url)}
                  />
                  <div className={c('row')}>
                    <button
                      type="button"
                      className={`${c('btn')} ${c('btnPrimary')}`}
                      onClick={() => {
                        editArticle({ coverSource: url });
                        studioToast.ok('已设为当前封面');
                      }}
                    >
                      用这张
                    </button>
                    <button
                      type="button"
                      className={c('btn')}
                      onClick={() => setCoverCandidates((list) => list.filter((u) => u !== url))}
                    >
                      弃
                    </button>
                  </div>
                </div>
              ))}
            </div>
          ) : null}
        </div>
        {coverSnippets.length > 0 ? (
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              封面库（{coverSnippets.length}）
              <span className={c('cardHint')}>沉淀下来的好封面，点「用这张」直接设为当前封面</span>
            </div>
            <div className={c('coverGrid')}>
              {coverSnippets.map((s) => (
                <div key={s.id} className={c('coverCard')}>
                  <img
                    className={c('coverThumb')}
                    src={s.contentMd}
                    alt={s.name}
                    title="点击看大图"
                    style={{ cursor: 'zoom-in' }}
                    onClick={() => setImageLightbox(s.contentMd)}
                  />
                  <div className={c('row')}>
                    <span className={c('grow')}>{s.name}</span>
                    <button type="button" className={c('btn')} onClick={() => editArticle({ coverSource: s.contentMd })}>
                      用这张
                    </button>
                    <button
                      type="button"
                      className={`${c('btn')} ${c('btnDanger')}`}
                      onClick={async () => {
                        if (await deleteStudioSnippet(PLATFORM, s.id)) {
                          setSnippets((list) => list.filter((x) => x.id !== s.id));
                        }
                      }}
                    >
                      删
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {imageNotice ? (
          <div className={`${c('notice')} ${imageNotice.includes('失败') || imageNotice.includes('缺少') ? c('noticeErr') : c('noticeOk')}`}>
            {imageNotice}
          </div>
        ) : null}
        <div className={c('row')}>
          <button type="button" className={c('btn')} onClick={() => setTab('images')}>
            下一步：配图（可选） <Icon name="chevron-right" size={14} />
          </button>
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={!article.coverSource}
            onClick={() => setTab('publish')}
            title={article.coverSource ? '' : '先生成或选择封面'}
          >
            直接去发布 <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </>
    );
  }

  function renderImagesTab() {
    if (!article) {
      return (
        <div className={c('empty')}>
          <div>配图需要先有文章——去「写作」新建一篇（AI 写稿会自动带上配图标注）。</div>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建文章
          </button>
        </div>
      );
    }
    const bodyMarkers = parseImageMarkers(article.bodyMd).filter((m) => m.marker.toUpperCase() !== 'COVER');
    const bodyImages = parseBodyImages(article.bodyMd);
    const generate = async (opts: { marker: string; description: string; ratio?: string; style: string; model: string }) => {
      setImageBusy(opts.marker);
      setImageNotice(null);
      const result = await generateArticleImage(PLATFORM, article.id, {
        description: opts.description,
        style: opts.style,
        model: opts.model,
        ...(opts.ratio ? { ratio: opts.ratio } : {}),
        marker: opts.marker,
      });
      setImageBusy(null);
      if ('error' in result) {
        setImageNotice(result.error);
        return;
      }
      setArticle(result.article);
      if (result.note) studioToast.info(result.note);
      setImageNotice(`图 ${opts.marker} 已生成并插入正文（右侧预览可见）`);
    };
    // 对已生成的图：改提示词重生成（原位替换，可一步撤销）。
    const regenerate = async (img: BodyImage, description: string, style: string, model: string) => {
      setImageBusy(img.src);
      setImageNotice(null);
      const result = await generateArticleImage(PLATFORM, article.id, {
        description,
        style,
        model,
        ratio: '4:3',
      });
      setImageBusy(null);
      if ('error' in result) {
        setImageNotice(result.error);
        return;
      }
      if (result.url) {
        if (result.note) studioToast.info(result.note);
        const current = articleRef.current;
        if (!current) return;
        const next = current.bodyMd.replace(img.md, `![${description.slice(0, 40)}](${result.url})`);
        setImageUndo({ prevBodyMd: current.bodyMd, afterBodyMd: next, label: '替换' });
        editArticle({ bodyMd: next });
        setImageNotice('已重新生成并替换（不满意可点右边「撤销」换回旧图）');
      }
    };
    const removeImage = (img: BodyImage) => {
      const current = articleRef.current;
      if (!current) return;
      const next = current.bodyMd.replace(img.md, '').replace(/\n{3,}/g, '\n\n');
      setImageUndo({ prevBodyMd: current.bodyMd, afterBodyMd: next, label: '移除' });
      editArticle({ bodyMd: next });
      setImageNotice('已从正文移除（图片文件保留在资产目录）');
    };
    const undoImageAction = () => {
      if (!imageUndo) return;
      const current = articleRef.current;
      if (!current) return;
      if (current.bodyMd !== imageUndo.afterBodyMd) {
        studioToast.err('正文在这之后又被改过，请从「写作」页的历史版本找回');
        setImageUndo(null);
        return;
      }
      editArticle({ bodyMd: imageUndo.prevBodyMd });
      setImageUndo(null);
      setImageNotice(null);
      studioToast.ok(`已撤销${imageUndo.label}`);
    };
    // 每张图在正文里的位置提示：取图前最近一段文字的结尾片段。
    const contextBefore = (img: BodyImage): string => {
      const idx = article.bodyMd.indexOf(img.md);
      if (idx <= 0) return '';
      const before = article.bodyMd
        .slice(0, idx)
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
        .replace(/[#>*`]/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return before.length > 26 ? `…${before.slice(-26)}` : before;
    };
    return (
      <>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            正文配图位（{bodyMarkers.length}）· 可选
            <span className={c('cardHint')}>来自正文的 &lt;!-- IMAGE_N --&gt; 标注；生成后自动替换成图片、预览立即可见。不配图也能发。</span>
          </div>
          {bodyMarkers.length === 0 ? (
            <div className={c('cardHint')}>
              正文里没有配图标注。AI 写稿会自动标注；手写的话在正文插入一行：&lt;!-- IMAGE_1: 场景描述, 4:3 --&gt;
            </div>
          ) : (
            <div className={c('genGrid')}>
              {bodyMarkers.map((m) => (
                <MarkerRow
                  key={m.marker}
                  marker={m}
                  busy={imageBusy === m.marker}
                  onGenerate={(desc, style, model) =>
                    void generate({ marker: m.marker, description: desc, ratio: m.ratio, style, model })
                  }
                />
              ))}
            </div>
          )}
        </div>
        {bodyImages.length > 0 ? (
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              已生成的图（{bodyImages.length}）
              <span className={c('cardHint')}>不满意就改提示词重生成（原位替换），或直接移除</span>
            </div>
            <div className={c('genGrid')}>
              {bodyImages.map((img) => (
                <GeneratedImageRow
                  key={img.src}
                  image={img}
                  context={contextBefore(img)}
                  busy={imageBusy === img.src}
                  onPreview={() => setImageLightbox(img.src)}
                  onRegenerate={(desc, style, model) => void regenerate(img, desc, style, model)}
                  onRemove={() => removeImage(img)}
                />
              ))}
            </div>
          </div>
        ) : null}
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            上传本机图片插入正文
            <span className={c('cardHint')}>直接选图，插到正文末尾（预览可见；发布时自动上传微信）</span>
          </div>
          <label className={c('btn')} style={{ cursor: 'pointer', alignSelf: 'flex-start' }}>
            <Icon name="upload" size={14} /> 选择图片
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                void (async () => {
                  setImageNotice('上传中…');
                  const result = await uploadStudioAsset(PLATFORM, article.id, file);
                  if (result.error) setImageNotice(result.error);
                  else if (result.url) {
                    editArticle({ bodyMd: `${article.bodyMd}\n\n![配图](${result.url})` });
                    setImageNotice('图片已插入正文末尾（可在写作页调整位置）');
                  }
                })();
              }}
            />
          </label>
        </div>
        {imageNotice ? (
          <div className={`${c('notice')} ${imageNotice.includes('失败') || imageNotice.includes('缺少') ? c('noticeErr') : c('noticeOk')}`}>
            {imageNotice}
            {imageUndo ? (
              <button type="button" className={c('btn')} style={{ marginLeft: 8 }} onClick={undoImageAction}>
                撤销{imageUndo.label}
              </button>
            ) : null}
          </div>
        ) : null}
        <div className={c('row')}>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('publish')}>
            下一步：发布 <Icon name="chevron-right" size={14} />
          </button>
        </div>
      </>
    );
  }

  function renderPublishTab() {
    if (!article) {
      return (
        <div className={c('empty')}>
          <div>发布需要先有文章——去「写作」新建一篇，或从「选题」开始。</div>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建文章
          </button>
        </div>
      );
    }
    const boundAccount = accounts.find((a) => a.id === article.accountId) ?? null;
    const effectiveAccount = boundAccount ?? accounts[0] ?? null;
    const missingCreds =
      effectiveAccount && !(effectiveAccount.credentials?.WECHAT_APPID && effectiveAccount.credentials?.WECHAT_SECRET);
    // 发布预检：全绿才允许点发布——不让用户点了才报错。
    const bytes = titleBytes(article.title.trim());
    const leftoverMarkers = parseImageMarkers(article.bodyMd).filter((m) => m.marker.toUpperCase() !== 'COVER').length;
    const checks: Array<{ ok: boolean; text: string; goto?: StudioTab; required: boolean }> = [
      { ok: article.title.trim().length > 0 && bytes <= 64, text: `标题就绪（${bytes}/64 字节）`, goto: 'write', required: true },
      { ok: article.bodyMd.trim().length > 0, text: '正文非空', goto: 'write', required: true },
      { ok: Boolean(article.coverSource), text: '封面已设置', goto: 'cover', required: true },
      { ok: Boolean(effectiveAccount && !missingCreds), text: '账号凭证就绪（AppID/AppSecret）', required: true },
      { ok: leftoverMarkers === 0, text: leftoverMarkers > 0 ? `${leftoverMarkers} 个配图占位未处理（可发，但草稿里没这些图）` : '配图占位已全部处理', goto: 'images', required: false },
      { ok: lintHits.length === 0, text: lintHits.length > 0 ? `敏感词 ${lintHits.length} 处（点开下方明细，防限流建议改掉）` : '敏感词扫描通过', goto: 'write', required: false },
    ];
    const readyToPublish = checks.filter((k) => k.required).every((k) => k.ok);
    return (
      <>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            发布前检查
            <span className={c('cardHint')}>必查项全绿才能发</span>
          </div>
          <div className={c('records')}>
            {checks.map((k) => (
              <div key={k.text} className={c('record')}>
                <span className={`${c('chip')} ${k.ok ? c('chipGreen') : k.required ? c('chipRed') : c('chipAmber')}`}>
                  {k.ok ? '✓' : k.required ? '✗' : '!'}
                </span>
                <span>{k.text}</span>
                <span className={c('headSpacer')} />
                {!k.ok && k.goto ? (
                  <button type="button" className={c('btn')} onClick={() => setTab(k.goto!)}>
                    去处理
                  </button>
                ) : null}
              </div>
            ))}
          </div>
        </div>
        {lintHits.length > 0 ? (
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              敏感词明细（{lintHits.length}）
              <span className={c('cardHint')}>广告法/平台高危方向，误报可忽略——但限流删文风险自负</span>
            </div>
            <div className={c('records')}>
              {lintHits.map((h) => (
                <div key={h.word} className={c('record')}>
                  <span className={`${c('chip')} ${c('chipAmber')}`}>{h.category}</span>
                  <strong>{h.word}</strong>
                  {h.count > 1 ? <span className={c('cardHint')}>×{h.count}</span> : null}
                  <span className={c('cardHint')}>{h.context.slice(0, 46)}</span>
                </div>
              ))}
            </div>
          </div>
        ) : null}
        <div className={c('card')}>
          <div className={c('cardLabel')}>公众号账号</div>
          {accounts.length === 0 ? (
            <div>
              还没有公众号账号。去{' '}
              <a className={c('link')} href="/accounts">
                账号页
              </a>{' '}
              添加（名称 + AppID/AppSecret，注意公众号后台要配 IP 白名单）。
            </div>
          ) : (
            <>
              <select
                className={c('select')}
                value={effectiveAccount?.id ?? ''}
                onChange={(e) => editArticle({ accountId: e.target.value })}
              >
                {accounts.map((a) => (
                  <option key={a.id} value={a.id}>
                    {a.name}
                  </option>
                ))}
              </select>
              {missingCreds ? (
                <div className={`${c('notice')} ${c('noticeErr')}`}>
                  账号「{effectiveAccount?.name}」缺少 WECHAT_APPID / WECHAT_SECRET——去「账号」页补上后再发。
                </div>
              ) : null}
            </>
          )}
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            摘要
            <span className={c('cardHint')}>可选 · 空则自动取正文前 100 字</span>
          </div>
          <input
            className={c('input')}
            value={article.digest}
            placeholder="显示在会话卡片里的一句话…"
            onChange={(e) => editArticle({ digest: e.target.value })}
          />
        </div>
        <div className={c('card')}>
          <div className={c('cardLabel')}>封面</div>
          {article.coverSource ? (
            <div className={c('row')}>
              <img className={c('coverPreview')} src={article.coverSource} alt="封面" />
              <button type="button" className={c('btn')} onClick={() => setTab('cover')}>
                换封面
              </button>
            </div>
          ) : (
            <div className={`${c('notice')} ${c('noticeErr')}`}>
              还没有封面——公众号草稿必须有封面。
              <button type="button" className={c('btn')} style={{ marginLeft: 8 }} onClick={() => setTab('cover')}>
                去「封面」步生成
              </button>
            </div>
          )}
        </div>
        <div className={c('row')}>
          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={publishing || accounts.length === 0 || !readyToPublish}
            title={readyToPublish ? '' : '上面的必查项还有红的'}
            onClick={() => void handlePublish()}
          >
            {publishing ? '发布中…' : '发到草稿箱'}
          </button>
          <button
            type="button"
            className={c('btn')}
            title="按当前账号打开公众号后台的专属浏览器（档案隔离，多号不串）"
            onClick={() =>
              void openStudioBrowser({
                platform: 'wechat-mp',
                account: effectiveAccount?.name ?? 'main',
              })
            }
          >
            打开公众号后台
          </button>
          <span className={c('saveHint')}>只发草稿箱，正式群发你在公众号后台自己点</span>
        </div>
        {publishNotice ? (
          <div className={`${c('notice')} ${publishNotice.ok ? c('noticeOk') : c('noticeErr')}`}>
            {publishNotice.text}
            {publishNotice.ok ? (
              <>
                {' '}
                <button
                  type="button"
                  className={c('link')}
                  style={{ border: 'none', background: 'none', cursor: 'pointer', font: 'inherit', padding: 0 }}
                  onClick={() =>
                    void openStudioBrowser({
                      platform: 'wechat-mp',
                      account: effectiveAccount?.name ?? 'main',
                    })
                  }
                >
                  去公众号后台确认群发 →（专属浏览器）
                </button>
              </>
            ) : null}
          </div>
        ) : null}
        {publishes.length > 0 ? (
          <div className={c('card')}>
            <div className={c('cardLabel')}>发布记录</div>
            <div className={c('records')}>
              {publishes.map((p) => (
                <div key={p.id} className={c('record')}>
                  <span className={c('recordTime')}>{timeLabel(p.createdAt)}</span>
                  <span className={`${c('chip')} ${p.status === 'ok' ? c('chipGreen') : c('chipRed')}`}>
                    {p.status === 'ok' ? '成功' : `失败 · ${p.failedStep ?? ''}`}
                  </span>
                  <span>{p.accountName}</span>
                  {p.draftMediaId ? <span className={c('mono')}>{p.draftMediaId}</span> : null}
                  {p.error ? <span className={c('recordError')}>{p.error}</span> : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}
        {article.status === 'published' ? (
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              发布复盘
              <span className={c('cardHint')}>群发 24-48 小时后回来填实际数据，AI 给下一篇的改进建议</span>
            </div>
            <input
              className={c('input')}
              value={String((article.extra as Record<string, unknown>)?.reviewData ?? '')}
              placeholder="例：阅读 3200，点赞 45，在看 12，转发 30，主要来自朋友圈"
              onChange={(e) => editArticle({ extra: { reviewData: e.target.value } })}
            />
            <div className={c('row')}>
              <button type="button" className={c('btn')} onClick={() => void startAiTask('review')}>
                <Icon name="sparkles" size={14} /> AI 复盘并给下一篇建议
              </button>
            </div>
          </div>
        ) : null}
      </>
    );
  }

  const showPreview = tab === 'write' || tab === 'cover' || tab === 'images' || tab === 'publish';
  // 列表/知识库是管理面，不占预览列。

  return (
    <div className={c('root')}>
      <div className={c('head')}>
        <h1 className={c('title')}>公众号创作台</h1>
        {activeSummaryStatus ? (
          <span className={`${c('chip')} ${c(activeSummaryStatus.chip)}`}>{activeSummaryStatus.text}</span>
        ) : null}
        {article && accounts.length > 0 ? (
          <select
            className={c('select')}
            value={article.accountId ?? ''}
            title="这篇文章属于哪个公众号——AI 按它的人设写作、发布用它的凭证"
            onChange={(e) => editArticle({ accountId: e.target.value || null })}
          >
            <option value="">（未绑定账号）</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        ) : null}
        <SaveStatusBadge state={saveState} savedAt={savedAt} onRetry={() => void flushSave()} />
        <div className={c('headSpacer')} />
        <div className={c('articlePicker')}>
          <button type="button" className={c('btn')} onClick={() => void handleCreateArticle()}>
            <Icon name="plus" size={14} /> 新建
          </button>
          {article ? (
            <button
              type="button"
              className={`${c('btn')} ${c('btnDanger')}`}
              onClick={() => void handleDeleteArticle()}
              title="删除当前文章"
            >
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

      <div className={c('tabs')} role="tablist" aria-label="创作台导航">
        {TABS.map((item) => {
          // 步骤完成态：让用户一眼看到这篇文章走到哪一步了。
          const done =
            item.id === 'write'
              ? Boolean(article && article.title.trim() && article.bodyMd.trim())
              : item.id === 'cover'
                ? Boolean(article?.coverSource)
                : item.id === 'publish'
                  ? article?.status === 'published'
                  : false;
          return (
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
              {done ? <Icon name="check" size={12} /> : null}
            </button>
          );
        })}
        <span style={{ width: 1, alignSelf: 'stretch', background: 'var(--border, #e1e5eb)', margin: '4px 6px' }} />
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'list'}
          className={`${c('tab')}${tab === 'list' ? ` ${c('tabActive')}` : ''}`}
          onClick={() => setTab('list')}
        >
          文章
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'knowledge'}
          className={`${c('tab')}${tab === 'knowledge' ? ` ${c('tabActive')}` : ''}`}
          onClick={() => setTab('knowledge')}
        >
          知识库
        </button>
      </div>

      <div className={c('main')}>
        <div className={c('editorCol')}>
          {tab === 'list' ? (
            <ArticleListCard
              articles={articles ?? []}
              statusLabel={(st) => STATUS_LABEL[st]}
              accountNameOf={(id) => accounts.find((a) => a.id === id)?.name ?? '—'}
              onOpen={(id) => {
                void flushSave().then(() => selectArticle(id));
                setTab('write');
              }}
              onDelete={(id) => {
                void (async () => {
                  const target = (articles ?? []).find((a) => a.id === id);
                  if (!window.confirm(`删除文章「${target?.title || '(无标题)'}」？发布记录会一并删除。`)) return;
                  await deleteStudioArticle(PLATFORM, id);
                  const list = await refreshArticles();
                  if (articleRef.current?.id === id) await selectArticle(list[0]?.id ?? null);
                })();
              }}
              onCreate={() => void handleCreateArticle()}
            />
          ) : null}
          {tab === 'knowledge' ? (
            <KnowledgePanel platform={PLATFORM} accounts={accounts.map((a) => ({ id: a.id, name: a.name }))} />
          ) : null}
          {tab === 'topics' ? renderTopicsTab() : null}
          {tab === 'write' ? renderWriteTab() : null}
          {tab === 'cover' ? renderCoverTab() : null}
          {tab === 'images' ? renderImagesTab() : null}
          {tab === 'publish' ? renderPublishTab() : null}
          {tab === 'write' && article && article.title.trim() && article.bodyMd.trim() ? (
            <NextStepBar hint="写作完成，下一步生成封面（发布必经）" label="去封面" onGo={() => setTab('cover')} />
          ) : null}
          {tab === 'cover' && article?.coverSource ? (
            <NextStepBar hint="封面已就绪；配图可选，也可以直接去发布" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
          {tab === 'images' && article?.coverSource ? (
            <NextStepBar hint="配图满意后就可以发布了" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>
        {showPreview && article ? (
          <div className={c('previewCol')}>
            <span className={c('previewTag')}>
              <Icon name="eye" size={13} /> 实时预览（与发布产物同源）
              <span className={c('headSpacer')} />
              <button
                type="button"
                className={`${c('previewModeBtn')}${phonePreview ? ` ${c('previewModeBtnActive')}` : ''}`}
                title="按手机宽度（375px）预览——读者真实看到的样子"
                onClick={() => setPhonePreview(true)}
              >
                手机
              </button>
              <button
                type="button"
                className={`${c('previewModeBtn')}${!phonePreview ? ` ${c('previewModeBtnActive')}` : ''}`}
                title="铺满预览列"
                onClick={() => setPhonePreview(false)}
              >
                全宽
              </button>
            </span>
            <div className={`${c('previewShell')}${phonePreview ? ` ${c('previewShellPhone')}` : ''}`}>
              <iframe
                className={`${c('previewFrame')}${phonePreview ? ` ${c('previewFramePhone')}` : ''}`}
                sandbox=""
                title="公众号排版预览"
                srcDoc={previewDoc(article?.title ?? '', previewHtml)}
              />
            </div>
            {previewNotes.length > 0 ? (
              <ul className={c('previewNotes')}>
                {previewNotes.map((n) => (
                  <li key={n}>· {n}</li>
                ))}
              </ul>
            ) : null}
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
      {imageLightbox ? (
        <div
          className={c('lightbox')}
          role="button"
          tabIndex={0}
          onClick={() => setImageLightbox('')}
          onKeyDown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') setImageLightbox('');
          }}
        >
          <img className={c('lightboxImg')} src={imageLightbox} alt="配图大图" />
        </div>
      ) : null}
    </div>
  );
}

// ---- 配图子组件 ----

function CoverGenerator({
  initialDescription,
  busy,
  onGenerate,
  onUploadReference,
}: {
  initialDescription: string;
  busy: boolean;
  onGenerate: (description: string, style: string, referenceImage: string, model: string) => void;
  /** 选本机图作参考：上传后返回可用 URL（失败返回 null）。 */
  onUploadReference?: (file: File) => Promise<string | null>;
}): JSX.Element {
  const [desc, setDesc] = useState(initialDescription);
  const [style, setStyle] = useState('whiteboard');
  const [model, setModel] = useState(loadPreferredImageModel);
  const [reference, setReference] = useState('');
  useEffect(() => {
    setDesc(initialDescription);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialDescription]);
  return (
    <>
      <textarea
        className={c('textarea')}
        value={desc}
        placeholder="封面提示词：画面里有什么、什么氛围、要不要文字…"
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className={c('row')}>
        <input
          className={`${c('input')} ${c('grow')}`}
          value={reference}
          placeholder="参考图（可选）：https://… 或 /Users/…/参考.jpg"
          onChange={(e) => setReference(e.target.value)}
        />
        {onUploadReference ? (
          <label className={c('btn')} style={{ cursor: 'pointer' }} title="选本机图片作参考">
            <Icon name="upload" size={14} />
            <input
              type="file"
              accept="image/*"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                e.target.value = '';
                if (!file) return;
                void onUploadReference(file).then((url) => {
                  if (url) setReference(url);
                });
              }}
            />
          </label>
        ) : null}
        <select className={c('select')} value={style} onChange={(e) => setStyle(e.target.value)}>
          {IMAGE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={c('select')} value={model} title="生图模型" onChange={(e) => {
            savePreferredImageModel(e.target.value);
            setModel(e.target.value);
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
          disabled={busy || !desc.trim()}
          onClick={() => onGenerate(desc.trim(), style, reference, model)}
        >
          {busy ? '生成中…' : '生成 2 张候选'}
        </button>
      </div>
    </>
  );
}

function MarkerRow({
  marker,
  busy,
  onGenerate,
}: {
  marker: ImageMarker;
  busy: boolean;
  onGenerate: (description: string, style: string, model: string) => void;
}): JSX.Element {
  const [desc, setDesc] = useState(marker.description);
  const [style, setStyle] = useState('whiteboard');
  const [model, setModel] = useState(loadPreferredImageModel);
  return (
    <div className={c('genCard')}>
      <div className={c('row')}>
        <span className={`${c('chip')} ${c('chipBlue')}`}>图 {marker.marker} · {marker.ratio}</span>
        <span className={c('cardHint')}>待生成</span>
      </div>
      <textarea
        className={c('textarea')}
        rows={2}
        style={{ minHeight: 0 }}
        value={desc}
        placeholder="画面描述：有什么、什么氛围…"
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className={c('row')}>
        <select className={c('select')} value={style} onChange={(e) => setStyle(e.target.value)}>
          {IMAGE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={c('select')} value={model} title="生图模型" onChange={(e) => {
            savePreferredImageModel(e.target.value);
            setModel(e.target.value);
          }}>
          {IMAGE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className={c('headSpacer')} />
        <button
          type="button"
          className={`${c('btn')} ${c('btnPrimary')}`}
          disabled={busy || !desc.trim()}
          onClick={() => onGenerate(desc.trim(), style, model)}
        >
          {busy ? '生成中…' : '生成'}
        </button>
      </div>
    </div>
  );
}

function GeneratedImageRow({
  image,
  context,
  busy,
  onPreview,
  onRegenerate,
  onRemove,
}: {
  image: BodyImage;
  /** 图在正文中的位置提示（前文摘录），改描述时有参照。 */
  context?: string;
  busy: boolean;
  onPreview: () => void;
  onRegenerate: (description: string, style: string, model: string) => void;
  onRemove: () => void;
}): JSX.Element {
  const [desc, setDesc] = useState(image.alt || '');
  const [style, setStyle] = useState('whiteboard');
  const [model, setModel] = useState(loadPreferredImageModel);
  return (
    <div className={c('genCard')}>
      <button type="button" className={c('genImgBtn')} title="点击看大图" onClick={onPreview}>
        <img className={c('genImgLarge')} src={image.src} alt={image.alt} />
        {busy ? <span className={c('genImgBusy')}>重新生成中…</span> : null}
      </button>
      {context ? <div className={c('genContext')}>位于「{context}」之后</div> : null}
      <textarea
        className={c('textarea')}
        rows={2}
        style={{ minHeight: 0 }}
        value={desc}
        placeholder="改一下画面描述再重生成…"
        onChange={(e) => setDesc(e.target.value)}
      />
      <div className={c('row')}>
        <select className={c('select')} value={style} onChange={(e) => setStyle(e.target.value)}>
          {IMAGE_STYLES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
        <select className={c('select')} value={model} title="生图模型" onChange={(e) => {
            savePreferredImageModel(e.target.value);
            setModel(e.target.value);
          }}>
          {IMAGE_MODELS.map((m) => (
            <option key={m.id} value={m.id}>
              {m.label}
            </option>
          ))}
        </select>
        <span className={c('headSpacer')} />
        <button
          type="button"
          className={`${c('btn')} ${c('btnPrimary')}`}
          disabled={busy || !desc.trim()}
          onClick={() => onRegenerate(desc.trim(), style, model)}
        >
          {busy ? '生成中…' : '重生成'}
        </button>
        <button type="button" className={`${c('btn')} ${c('btnDanger')}`} disabled={busy} onClick={onRemove}>
          移除
        </button>
      </div>
    </div>
  );
}
