// 短视频创作台 — spec: specs/current/media-studio.md
//
// 把 short-video-copy 总控 + 五个平台发布插件（抖音/小红书/快手/B站/视频号）
// 的能力抽象成一个可视化工作台：选题 → 脚本 → 配音（可选）→ 成片 → 多平台发布。
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
  fetchStudioArticle,
  fetchStudioArticles,
  fetchStudioPublishes,
  fetchStudioTopics,
  lintStudioArticle,
  type StudioLintHit,
  synthesizeStudioTts,
  updateStudioArticle,
  uploadStudioVideo,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { useOrphanRun } from './useOrphanRun';
import { usePlatformAccountNames } from './usePlatformAccounts';
import { navigate } from '../../router';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'short-video';
const LAST_ARTICLE_KEY = 'open-design:studio:last-video-article';

// 知识库已升级为左侧导航一级入口(/knowledge,全创作台共用),不再是台内 tab。
type VideoTab = 'topics' | 'script' | 'voice' | 'video' | 'publish' | 'list';

const SAU_PLATFORMS: Array<{ id: SauPlatformId; label: string }> = [
  { id: 'douyin', label: '抖音' },
  { id: 'xiaohongshu', label: '小红书' },
  { id: 'kuaishou', label: '快手' },
  { id: 'bilibili', label: 'B站' },
  { id: 'tencent', label: '视频号' },
];

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

export function ShortVideoStudioView(): JSX.Element {
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
  const [ttsBusy, setTtsBusy] = useState(false);
  // 试听音色：preview 音频独立存放，绝不覆盖正式配音。
  const [voicePreviewUrl, setVoicePreviewUrl] = useState('');
  const [voicePreviewBusy, setVoicePreviewBusy] = useState(false);
  const [videoUploadBusy, setVideoUploadBusy] = useState(false);
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
  const audioUrl = str(extra.audioUrl);
  const videoPath = str(extra.videoPath);
  const tags = str(extra.tags);

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
    });
    if (!created) return;
    await refreshArticles();
    setArticle(created);
    window.localStorage.setItem(LAST_ARTICLE_KEY, created.id);
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

  // ---- 配音 ----
  async function handleTts() {
    if (!article || ttsBusy) return;
    await flushSave();
    setTtsBusy(true);
    setNotice(null);
    const voice = str(extra.voice);
    const result = await synthesizeStudioTts(PLATFORM, article.id, voice ? { voice } : {});
    setTtsBusy(false);
    if (result.error) {
      setNotice({ ok: false, text: result.error });
      return;
    }
    if (result.article) setArticle(result.article);
    setNotice({ ok: true, text: '配音已生成，下面直接试听' });
  }

  // ---- 发布 ----
  // 自动发布(sau 矩阵直传)已下线(2026-07-09 用户拍板):抖音等平台只走
  // 「带稿开后台 → 人工存草稿/发布」。daemon 端点与 od CLI 保留可恢复。

  // ---- 步骤完成态（用户一眼看到走到哪了） ----
  const stepDone: Record<VideoTab, boolean> = {
    topics: topics.some((t) => t.status === 'used'),
    script: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    voice: Boolean(audioUrl),
    video: Boolean(videoPath.trim()),
    publish: article?.status === 'published',
    list: false,
  };

  const TABS: Array<{ id: VideoTab; label: string; step: string; optional?: boolean }> = [
    { id: 'topics', label: '选题', step: '1' },
    { id: 'script', label: '脚本', step: '2' },
    { id: 'voice', label: '配音', step: '3', optional: true },
    { id: 'video', label: '成片', step: '4' },
    { id: 'publish', label: '发布', step: '5' },
  ];

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
              topics={topics}
              onAdd={async (draft) => {
                const created = await createStudioTopic(PLATFORM, draft);
                if (created) setTopics((list) => [created, ...list]);
              }}
              onDelete={async (id) => {
                if (await deleteStudioTopic(PLATFORM, id)) setTopics((list) => list.filter((t) => t.id !== id));
              }}
              onWrite={(topic) => void handleCreateArticle(topic)}
              onAiFind={(note, picked) => void startAiTask('topics', { note, ...(picked && picked.length > 0 ? { picked } : {}) })}
              aiBusy={effectiveAiRunning}
            />
          ) : null}

          {tab === 'script' ? (
            !article ? (
              emptyCta('还没有作品。从「选题」挑一个开始，或新建一个空白作品。')
            ) : (
              <>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    AI 写脚本
                    <span className={c('cardHint')}>按主发平台调性 + 语气 + 时长出稿（标题备选/口播稿/标签/封面文字一次到位）</span>
                  </div>
                  <div className={c('row')}>
                    <select
                      className={c('select')}
                      value={str(extra.targetPlatform) || '抖音'}
                      onChange={(e) => editArticle({ extra: { targetPlatform: e.target.value } })}
                    >
                      {SAU_PLATFORMS.map((p) => (
                        <option key={p.id} value={p.label}>
                          主发 {p.label}
                        </option>
                      ))}
                    </select>
                    <select
                      className={c('select')}
                      value={str(extra.tone) || '真诚口播'}
                      onChange={(e) => editArticle({ extra: { tone: e.target.value } })}
                    >
                      {TONES.map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                    <select
                      className={c('select')}
                      value={str(extra.duration) || '30s'}
                      onChange={(e) => editArticle({ extra: { duration: e.target.value } })}
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
                  <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('voice')}>
                    下一步：配音（可选） <Icon name="chevron-right" size={14} />
                  </button>
                </div>
              </>
            )
          ) : null}

          {tab === 'voice' ? (
            !article ? (
              emptyCta('配音属于某个作品——先去「脚本」新建。')
            ) : (
              <>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    配音（火山复刻音色）· 可选
                    <span className={c('cardHint')}>用口播脚本直接合成；音色 ID 以 S_ 开头为复刻音色，空用默认「解说1号」</span>
                  </div>
                  <div className={c('row')}>
                    <input
                      className={`${c('input')} ${c('grow')}`}
                      value={str(extra.voice)}
                      placeholder="音色 ID（可选，默认 S_M46v4EJ42 解说1号）"
                      onChange={(e) => editArticle({ extra: { voice: e.target.value } })}
                    />
                    <button
                      type="button"
                      className={c('btn')}
                      disabled={voicePreviewBusy}
                      title="用一句短文本快速听这个音色的语气节奏，不覆盖正式配音"
                      onClick={() => {
                        void (async () => {
                          setVoicePreviewBusy(true);
                          const voice = str(extra.voice).trim();
                          const result = await synthesizeStudioTts(PLATFORM, article.id, {
                            text: '大家好，这是当前音色的试听效果，听听语气和节奏合不合适。',
                            ...(voice ? { voice } : {}),
                            preview: true,
                          });
                          setVoicePreviewBusy(false);
                          if (result.error) studioToast.err(result.error);
                          else if (result.url) setVoicePreviewUrl(result.url);
                        })();
                      }}
                    >
                      {voicePreviewBusy ? '试听生成中…' : '试听音色'}
                    </button>
                    <button
                      type="button"
                      className={`${c('btn')} ${c('btnPrimary')}`}
                      disabled={ttsBusy || !article.bodyMd.trim()}
                      onClick={() => void handleTts()}
                    >
                      {ttsBusy ? '合成中…' : '生成配音'}
                    </button>
                  </div>
                  {voicePreviewUrl ? (
                    <div className={c('row')}>
                      <span className={c('cardHint')}>试听：</span>
                      {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                      <audio controls src={voicePreviewUrl} style={{ flex: 1, height: 32 }} />
                    </div>
                  ) : null}
                  {audioUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <audio controls src={audioUrl} style={{ width: '100%' }} />
                  ) : (
                    <div className={c('cardHint')}>还没有配音。不需要配音（真人出镜/已有成片）直接去下一步。</div>
                  )}
                </div>
                <div className={c('row')}>
                  <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => setTab('video')}>
                    下一步：成片 <Icon name="chevron-right" size={14} />
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
                    成片（发布必需）
                    <span className={c('cardHint')}>已有成片给本机绝对路径；要 AI 生成视频，用「插件」页的短视频工作流跑完再把成片路径填回来</span>
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
                {/* 自动发布(sau 矩阵直传)与定时发布已下线(2026-07-09 用户
                    拍板):抖音等平台只走「带稿开后台 → 人工存草稿/发布」,
                    零自动化指纹。daemon 端点与 od CLI 保留,可恢复。 */}
                <SafeHandoffCard
                  studioPlatform={PLATFORM}
                  articleId={article.id}
                  articleTitle={article.title}
                  targets={SAU_PLATFORMS}
                  defaultTarget="douyin"
                  hasAssets={Boolean(videoPath.trim())}
                  assetsLabel="成片文件夹"
                  accountsOf={(pid) => platformAccounts[pid] ?? []}
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
                      <button type="button" className={c('btn')} onClick={() => void startAiTask('review')}>
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
            <NextStepBar hint="脚本完成；配音可选，也可以直接填成片" label="去配音" onGo={() => setTab('voice')} />
          ) : null}
          {tab === 'voice' && stepDone.voice ? (
            <NextStepBar hint="配音就绪，下一步准备成片" label="去成片" onGo={() => setTab('video')} />
          ) : null}
          {tab === 'video' && stepDone.video ? (
            <NextStepBar hint="成片就绪，去发布——带稿开后台存草稿" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>

        {article && tab !== 'topics' && tab !== 'list' ? (
          <div className={c('previewCol')}>
            <span className={c('previewTag')}>
              <Icon name="eye" size={13} /> 作品卡（发布时的样子）
            </span>
            <div className={c('videoCard')}>
              <div className={c('videoCardTitle')}>{article.title || '（还没有标题）'}</div>
              <div className={c('videoCardMeta')}>
                {str(extra.targetPlatform) || '抖音'} · {str(extra.tone) || '真诚口播'} · {estimateDuration(speechText) || '时长未知'}
              </div>
              {audioUrl ? (
                // eslint-disable-next-line jsx-a11y/media-has-caption
                <audio controls src={audioUrl} style={{ width: '100%' }} />
              ) : null}
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
