// 知乎创作台 — 独立一级入口(2026-07-10 用户拍板:按平台性质分台,不融进
// 公众号;同构架构:选题 → 写作 → 发布)。
//
// 与公众号台的关系:文章实体同构(platform: 'zhihu' 隔离存储),可「从公众号
// 导入」一键取用长文再各自加工;选题数据搜的是知乎自己的平台(TikHub 知乎
// 热榜/文章搜索),不是公众号生态。发布=应用内浏览器安全交接(真实键入+
// 知乎写作页自动存草稿),零机器直传。排版由知乎编辑器自己管,本台不做
// HTML 渲染(键入时空行已按知乎段落语义压缩)。
import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  MediaArticle,
  MediaArticleSummary,
  MediaPublishRecord,
  MediaTopic,
  UpdateMediaArticleRequest,
} from '@open-design/contracts';
import { IMAGE_STYLE_PRESETS } from '@open-design/contracts';
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
  updateStudioArticle,
  uploadStudioAsset,
} from '../../providers/media-studio';
import { buildStudioDraft, strippedBodyOf } from './draft-builders';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { CoverGenerator } from './MediaStudioView';
import { ImageStyleUpfront } from './ImageStyleUpfront';
import { zhihuPreviewDoc } from './zhihu-preview';
import { loadPreferredImageModel } from './image-model-pref';
import { loadStudioPref, saveStudioPref } from './studio-prefs';
import { hasFeature, useLicense } from '../../state/license';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { useOrphanRun } from './useOrphanRun';
import { usePlatformAccountNames } from './usePlatformAccounts';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'zhihu';
const LAST_ARTICLE_KEY = 'open-design:studio:last-zhihu-article';

type ZhihuTab = 'topics' | 'write' | 'cover' | 'images' | 'publish' | 'list';

const STATUS_LABEL: Record<MediaArticle['status'], { text: string; chip: string }> = {
  writing: { text: '创作中', chip: 'chipAmber' },
  rendered: { text: '已就绪', chip: 'chipBlue' },
  published: { text: '已发布', chip: 'chipGreen' },
};

function timeLabel(ts: number): string {
  if (!ts) return '';
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function ZhihuStudioView(): JSX.Element {
  const license = useLicense();
  // 「从公众号导入」仅当客户买了公众号(article.wechat-mp)才显示——本客户没有公众号功能,
  // 克隆自公众号台的这个入口要隐藏(2026-07-20 用户报"没有公众号却出现导入")。
  const canImportWechat = hasFeature(license, 'article.wechat-mp');
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<ZhihuTab>('write');
  // 封面/正文配图风格【按文章存】(article.extra,2026-07-20 用户拍板:写作前就分开选定,
  // AI 写配图提示词按它来、封面/配图生图也用它——所见即所得)。切文章时从 extra 同步。
  const [coverStyle, setCoverStyleRaw] = useState('bigtext');
  const [imageStyle, setImageStyleRaw] = useState('whiteboard');
  useEffect(() => {
    const ex = (article?.extra ?? {}) as Record<string, unknown>;
    const pick = (v: unknown, dflt: string) =>
      typeof v === 'string' && IMAGE_STYLE_PRESETS.some((s) => s.id === v) ? v : dflt;
    setCoverStyleRaw(pick(ex.coverStyle, 'bigtext'));
    setImageStyleRaw(pick(ex.imageStyle, 'whiteboard'));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [article?.id]);
  const setCoverStyle = (v: string) => { setCoverStyleRaw(v); void editArticle({ extra: { coverStyle: v } }); };
  const setImageStyle = (v: string) => { setImageStyleRaw(v); void editArticle({ extra: { imageStyle: v } }); };
  // 授权裁剪后的 tab 回落。
  useEffect(() => {
    if ((tab === 'cover' || tab === 'images') && !hasFeature(license, 'cap.image')) setTab('write');
  }, [tab, license]);
  const [topics, setTopics] = useState<MediaTopic[]>([]);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<Date | null>(null);
  const [aiTask, setAiTask] = useState<StudioAiTask | null>(null);
  const aiSeqRef = useRef(0);
  const [aiRunning, setAiRunning] = useState(false);
  const [aiStage, setAiStage] = useState('');
  const [aiElapsed, setAiElapsed] = useState(0);
  const aiPanelRef = useRef<StudioAiPanelHandle | null>(null);
  const [reviseNote, setReviseNote] = useState('');
  const [aiWordCount, setAiWordCount] = useState(() => loadStudioPref('wordcount:zhihu', '1500-2000'));
  const [publishes, setPublishes] = useState<MediaPublishRecord[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importList, setImportList] = useState<MediaArticleSummary[] | null>(null);
  const platformAccounts = usePlatformAccountNames();
  // 封面/配图/实时预览(2026-07-10 用户拍板:和公众号一致)。
  const [coverGenBusy, setCoverGenBusy] = useState(false);
  const [coverCandidates, setCoverCandidates] = useState<string[]>([]);
  const [imageBusy, setImageBusy] = useState(false);
  const [imagePrompt, setImagePrompt] = useState('');
  const [imageNotice, setImageNotice] = useState<string | null>(null);

  const articleRef = useRef<MediaArticle | null>(null);
  articleRef.current = article;
  const aiTaskRef = useRef<StudioAiTask | null>(null);
  aiTaskRef.current = aiTask;
  const { orphan, cancelOrphan } = useOrphanRun(aiTask === null);
  const effectiveAiRunning = aiRunning || orphan != null;
  const saveTimerRef = useRef<number | null>(null);
  const pendingRef = useRef<{ id: string; patch: UpdateMediaArticleRequest } | null>(null);

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
      if (a) {
        window.localStorage.setItem(LAST_ARTICLE_KEY, a.id);
        setPublishes(await fetchStudioPublishes(PLATFORM, a.id));
      }
    } else {
      setArticle(null);
      window.localStorage.removeItem(LAST_ARTICLE_KEY);
    }
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

  // ---- 自动保存(与其余创作台同款机制) ----
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
    setArticles((list) =>
      list ? list.map((s) => (s.id === updated.id ? { ...s, title: updated.title, status: updated.status, updatedAt: updated.updatedAt } : s)) : list,
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

  useEffect(
    () => () => {
      if (saveTimerRef.current) window.clearTimeout(saveTimerRef.current);
      void flushSave();
    },
    [flushSave],
  );

  // ---- AI 任务 ----
  const startAiTask = useCallback(
    async (kind: 'topics' | 'write' | 'revise', input?: { note?: string; wordCount?: string; picked?: PickedHit[] }) => {
      await flushSave();
      const current = articleRef.current;
      const created = await createStudioAiTask(PLATFORM, {
        kind,
        ...(kind !== 'topics' && current ? { articleId: current.id } : {}),
        input: {
          ...(input?.note ? { note: input.note } : {}),
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

  // AI 计时(全局条的 mm:ss)。
  useEffect(() => {
    if (!effectiveAiRunning) {
      setAiElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = window.setInterval(() => setAiElapsed(Math.floor((Date.now() - started) / 1000)), 1000);
    return () => window.clearInterval(timer);
  }, [effectiveAiRunning]);

  // AI 跑动期间 3 秒轮询,产物实时上屏。
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
        });
      }
    },
    [refreshArticles],
  );

  // ---- 实时预览:知乎自己的文章版式(2026-07-10 用户拍板:不套公众号),
  // 纯前端 markdown→知乎 HTML,含封面/正文配图/文末话题,导入的图片可见。 ----

  // ---- 封面:生成 2 张候选 / 上传 / 选用(coverSource,和公众号一致)。 ----
  async function generateCover(desc: string, style: string, ref: string, model: string) {
    if (!article) return;
    setCoverGenBusy(true);
    setImageNotice(null);
    const req = {
      description: desc,
      style,
      model,
      ratio: '16:9',
      asCover: false,
      ...(ref.trim() ? { referenceImage: ref.trim() } : {}),
    };
    const results = await Promise.all([
      generateArticleImage(PLATFORM, article.id, req),
      generateArticleImage(PLATFORM, article.id, req),
    ]);
    setCoverGenBusy(false);
    const urls = results.flatMap((r) => ('error' in r ? [] : [r.url]));
    if (urls.length === 0) {
      const first = results[0];
      setImageNotice('error' in first ? first.error : '生成失败');
      return;
    }
    setCoverCandidates((prev) => [...new Set([...urls, ...prev])].slice(0, 6));
  }

  /** 单张配图:AI 生成/上传 → 追加 ![](url) 到正文末尾(发布时原位插入)。 */
  async function addBodyImage(url: string) {
    const current = articleRef.current;
    if (!current) return;
    const sep = current.bodyMd.endsWith('\n') ? '' : '\n';
    editArticle({ bodyMd: `${current.bodyMd}${sep}\n![](${url})\n` });
    setImageNotice('配图已插入正文末尾——可在正文里把它挪到合适位置');
  }
  async function generateBodyImage(desc: string) {
    if (!article || !desc.trim()) return;
    setImageBusy(true);
    setImageNotice(null);
    const result = await generateArticleImage(PLATFORM, article.id, { description: desc.trim(), style: imageStyle, model: loadPreferredImageModel(), ratio: '4:3' });
    setImageBusy(false);
    if ('error' in result) {
      setImageNotice(result.error);
      return;
    }
    if (result.url) await addBodyImage(result.url);
  }

  async function handleCreateArticle(topic?: MediaTopic) {
    await flushSave();
    const created = await createStudioArticle(PLATFORM, {
      ...(topic ? { title: topic.title, topic: topic.title, fromTopicId: topic.id } : {}),
    });
    if (!created) {
      studioToast.err('新建失败——稍后重试');
      return;
    }
    await refreshArticles();
    await selectArticle(created.id);
    setTab('write');
    if (topic) {
      articleRef.current = created;
      void startAiTask('write');
    }
  }

  async function handleDeleteArticle() {
    const current = articleRef.current;
    if (!current) return;
    if (!window.confirm(`删除文章「${current.title || '(无标题)'}」？发布记录会一并删除。`)) return;
    await deleteStudioArticle(PLATFORM, current.id);
    const list = await refreshArticles();
    await selectArticle(list[0]?.id ?? null);
  }

  /** 从公众号导入:复制标题/正文/摘要/封面到知乎平台的新文章(图片 URL
   *  保持指向源文章资产目录——全局可访问,发布注入时按 URL 内文章 id 映射)。 */
  async function importFromWechat(summaryId: string) {
    const src = await fetchStudioArticle('wechat-mp', summaryId);
    if (!src) {
      studioToast.err('读取公众号文章失败');
      return;
    }
    const created = await createStudioArticle(PLATFORM, {
      title: src.title,
      topic: src.topic,
      bodyMd: src.bodyMd,
    });
    if (!created) {
      studioToast.err('导入失败——稍后重试');
      return;
    }
    if (src.coverSource || src.digest) {
      await updateStudioArticle(PLATFORM, created.id, {
        ...(src.coverSource ? { coverSource: src.coverSource } : {}),
        ...(src.digest ? { digest: src.digest } : {}),
      });
    }
    setImportOpen(false);
    await refreshArticles();
    await selectArticle(created.id);
    setTab('write');
    studioToast.ok(`「${src.title}」已导入——正文/封面随后可按知乎风格再改`);
  }

  const stepDone: Record<ZhihuTab, boolean> = {
    topics: topics.some((t) => t.status === 'used'),
    write: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    cover: Boolean(article?.coverSource),
    images: false,
    publish: article?.status === 'published',
    list: false,
  };

  const TABS: Array<{ id: ZhihuTab; label: string; step: string; optional?: boolean }> = [
    { id: 'topics', label: '选题', step: '1' },
    { id: 'write', label: '写作', step: '2' },
    // 授权裁剪:封面/配图跟 cap.image(发布 tab 保留——含手动复制路径)。
    ...(hasFeature(license, 'cap.image')
      ? ([{ id: 'cover', label: '封面', step: '3', optional: true }, { id: 'images', label: '配图', step: '4', optional: true }] as const)
      : []),
    { id: 'publish', label: '发布', step: '5' },
  ];
  // 写作/封面/配图 tab 显示右侧实时预览。
  const showPreview = (tab === 'write' || tab === 'cover' || tab === 'images') && Boolean(article);

  const activeStatus = article ? STATUS_LABEL[article.status] : null;
  const zhihuAccounts = platformAccounts[PLATFORM] ?? [];

  function emptyCta(text: string) {
    return (
      <div className={c('empty')}>
        <div>{text}</div>
        {importOpen ? (
          <div className={c('records')} style={{ width: '100%', maxWidth: 560, textAlign: 'left' }}>
            {(importList ?? []).length === 0 ? (
              <div className={c('cardHint')}>{importList ? '公众号台还没有文章' : '加载中…'}</div>
            ) : (
              (importList ?? []).slice(0, 12).map((a) => (
                <div key={a.id} className={c('record')}>
                  <span className={c('grow')}>{a.title || '(无标题)'}</span>
                  <button type="button" className={c('btn')} onClick={() => void importFromWechat(a.id)}>
                    导入
                  </button>
                </div>
              ))
            )}
          </div>
        ) : null}
        <div className={c('row')} style={{ justifyContent: 'center' }}>
        {canImportWechat ? (
        <button type="button" className={c('btn')} onClick={() => { setImportOpen((v) => !v); if (!importList) void fetchStudioArticles('wechat-mp').then(setImportList); }}>
          <Icon name="import" size={14} /> 从公众号导入
        </button>
        ) : null}
        <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void handleCreateArticle()}>
          <Icon name="plus" size={14} /> 新建文章
        </button>
        </div>
      </div>
    );
  }

  return (
    <div className={c('root')}>
      <div className={c('head')}>
        <h1 className={c('title')}>知乎创作台</h1>
        {activeStatus ? <span className={`${c('chip')} ${c(activeStatus.chip)}`}>{activeStatus.text}</span> : null}
        {article && zhihuAccounts.length > 0 ? (
          <select
            className={c('select')}
            value={article.accountId ?? ''}
            title="这篇文章发到哪个知乎账号——发布用它的登录档案"
            onChange={(e) => editArticle({ accountId: e.target.value || null })}
          >
            <option value="">（未绑定账号）</option>
            {zhihuAccounts.map((name) => (
              <option key={name} value={name}>
                {name}
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
            <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => void handleDeleteArticle()} title="删除当前文章">
              <Icon name="trash" size={14} />
            </button>
          ) : null}
        </div>
      </div>

      {effectiveAiRunning ? (
        <div className={c('aiGlobalBar')}>
          <Icon name="spinner" size={14} />
          <span>
            AI 任务运行中{aiStage ? ` · ${aiStage}` : ''}
            {aiElapsed > 0 ? ` · ${Math.floor(aiElapsed / 60)}:${String(aiElapsed % 60).padStart(2, '0')}` : ''}
          </span>
          <span className={c('headSpacer')} />
          <button type="button" className={c('aiGlobalBtn')} onClick={() => (orphan ? cancelOrphan() : aiPanelRef.current?.cancel())}>
            中止
          </button>
        </div>
      ) : null}

      <div className={c('tabs')} role="tablist" aria-label="知乎创作台导航">
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
          文章
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
                setTab('write');
              }}
              onDelete={(id) => {
                void (async () => {
                  const target = (articles ?? []).find((a) => a.id === id);
                  if (!window.confirm(`删除文章「${target?.title || '(无标题)'}」？`)) return;
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
              aiOnly
              tikhubTargets={[{ id: 'zhihu', label: '知乎' }]}
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

          {tab === 'write' ? (
            !article ? (
              emptyCta('先新建一篇文章，或从「选题」一键开写。')
            ) : (
              <>
                <ImageStyleUpfront coverStyle={coverStyle} imageStyle={imageStyle} onCoverChange={setCoverStyle} onImageChange={setImageStyle} />
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    标题
                    <span className={c('cardHint')}>知乎标题上限 100 字</span>
                    <span className={c('headSpacer')} />
                    {canImportWechat ? (
                    <button type="button" className={c('btn')} onClick={() => { setImportOpen((v) => !v); if (!importList) void fetchStudioArticles('wechat-mp').then(setImportList); }}>
                      <Icon name="import" size={13} /> 从公众号导入
                    </button>
                    ) : null}
                  </div>
                  {importOpen ? (
                    <div className={c('records')}>
                      {(importList ?? []).length === 0 ? (
                        <div className={c('cardHint')}>{importList ? '公众号台还没有文章' : '加载中…'}</div>
                      ) : (
                        (importList ?? []).slice(0, 12).map((a) => (
                          <div key={a.id} className={c('record')}>
                            <span className={c('grow')}>{a.title || '(无标题)'}</span>
                            <span className={c('recordTime')}>{timeLabel(a.updatedAt)}</span>
                            <button type="button" className={c('btn')} onClick={() => void importFromWechat(a.id)}>
                              导入
                            </button>
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                  <input
                    className={c('input')}
                    value={article.title}
                    placeholder="文章标题"
                    onChange={(e) => editArticle({ title: e.target.value })}
                  />
                </div>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    正文（markdown）
                    <span className={c('cardHint')}>知乎排版由其编辑器自动处理——这里专注内容;图片标注保留,发布时原位插入</span>
                  </div>
                  <textarea
                    className={c('textarea')}
                    style={{ minHeight: 380 }}
                    value={article.bodyMd}
                    placeholder="正文内容;可以「从公众号导入」后按知乎读者口味改写…"
                    onChange={(e) => editArticle({ bodyMd: e.target.value })}
                  />
                  {hasFeature(license, 'cap.ai') ? (
                    <>
                      <div className={c('row')}>
                        <select className={c('select')} value={aiWordCount} onChange={(e) => { setAiWordCount(e.target.value); saveStudioPref('wordcount:zhihu', e.target.value, '1500-2000'); }}>
                          {['800-1200', '1500-2000', '2500-3500'].map((w) => (
                            <option key={w} value={w}>
                              {w} 字
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          className={`${c('btn')} ${c('btnPrimary')}`}
                          disabled={effectiveAiRunning}
                          onClick={() => void startAiTask('write', { wordCount: aiWordCount })}
                        >
                          <Icon name="sparkles" size={14} /> {effectiveAiRunning ? 'AI 任务进行中…' : 'AI 写一版'}
                        </button>
                      </div>
                      <div className={c('row')}>
                        <input
                          className={`${c('input')} ${c('grow')}`}
                          value={reviseNote}
                          placeholder="改稿指令，例：开头改成提问式，第二节加个案例…"
                          onChange={(e) => setReviseNote(e.target.value)}
                        />
                        <button
                          type="button"
                          className={c('btn')}
                          disabled={effectiveAiRunning || !reviseNote.trim()}
                          onClick={() => {
                            void startAiTask('revise', { note: reviseNote.trim() });
                            setReviseNote('');
                          }}
                        >
                          按我说的改
                        </button>
                      </div>
                    </>
                  ) : null}
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
              </>
            )
          ) : null}

          {tab === 'cover' && article ? (
            <>
              <div className={c('card')}>
                <div className={c('cardLabel')}>
                  当前封面（16:9 · 知乎文章封面）
                  <span className={c('cardHint')}>{article.coverSource ? '' : '还没有封面——生成或上传一张，发布时自动上到知乎封面区'}</span>
                </div>
                {article.coverSource ? (
                  <div className={c('row')}>
                    <img className={c('coverPreview')} src={article.coverSource} alt="当前封面" />
                    <button type="button" className={`${c('btn')} ${c('btnDanger')}`} onClick={() => editArticle({ coverSource: '' })}>
                      移除
                    </button>
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
                <div className={c('cardLabel')}>生成封面</div>
                <CoverGenerator
                  initialDescription={article.title}
                  style={coverStyle}
                  onStyleChange={setCoverStyle}
                  busy={coverGenBusy}
                  onGenerate={(desc, style, ref, model) => void generateCover(desc, style, ref, model)}
                  onUploadReference={async (file) => {
                    const result = await uploadStudioAsset(PLATFORM, article.id, file);
                    return result.error ? null : result.url ?? null;
                  }}
                />
                {coverCandidates.length > 0 ? (
                  <div className={c('coverGrid')}>
                    {coverCandidates.map((url) => (
                      <div key={url} className={c('coverCard')}>
                        <img className={c('coverThumb')} src={url} alt="候选封面" />
                        <div className={c('row')}>
                          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => { editArticle({ coverSource: url }); setImageNotice('已设为封面'); }}>
                            用这张
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : null}
              </div>
              {imageNotice ? <div className={`${c('notice')} ${c('noticeOk')}`}>{imageNotice}</div> : null}
            </>
          ) : null}

          {tab === 'images' && article ? (
            <div className={c('card')}>
              <div className={c('cardLabel')}>
                正文配图
                <span className={c('cardHint')}>AI 生成或上传，插入正文（发布时按位置原位插到知乎正文）</span>
              </div>
              <div className={c('row')}>
                <input
                  className={`${c('input')} ${c('grow')}`}
                  value={imagePrompt}
                  placeholder="画面描述，例：一位职场女性在咖啡店窗边看笔记本，暖色调…"
                  onChange={(e) => setImagePrompt(e.target.value)}
                />
                <button
                  type="button"
                  className={`${c('btn')} ${c('btnPrimary')}`}
                  disabled={imageBusy || !imagePrompt.trim()}
                  onClick={() => void generateBodyImage(imagePrompt).then(() => setImagePrompt(''))}
                >
                  {imageBusy ? '生成中…' : '生成并插入'}
                </button>
                <label className={c('btn')} style={{ cursor: 'pointer' }}>
                  <Icon name="upload" size={14} /> 上传
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: 'none' }}
                    onChange={(e) => {
                      const file = e.target.files?.[0];
                      e.target.value = '';
                      if (!file) return;
                      void (async () => {
                        setImageBusy(true);
                        const result = await uploadStudioAsset(PLATFORM, article.id, file);
                        setImageBusy(false);
                        if (result.error) setImageNotice(result.error);
                        else if (result.url) await addBodyImage(result.url);
                      })();
                    }}
                  />
                </label>
              </div>
              {imageNotice ? <div className={c('cardHint')}>{imageNotice}</div> : null}
              <div className={c('cardHint')}>提示:插入的图片以 markdown 出现在正文里,可在「写作」正文框里调整位置。</div>
            </div>
          ) : null}

          {tab === 'write' && stepDone.write ? (
            <NextStepBar hint="正文完成，可选加封面/配图，或直接去发布" label="去封面" onGo={() => setTab('cover')} />
          ) : null}

          {tab === 'publish' ? (
            !article ? (
              emptyCta('发布属于某篇文章——先去「写作」新建。')
            ) : (
              <>
                <SafeHandoffCard
                  studioPlatform={PLATFORM}
                  articleId={article.id}
                  articleTitle={article.title}
                  targets={[{ id: 'zhihu', label: '知乎' }]}
                  defaultTarget="zhihu"
                  hasAssets={false}
                  requiresAssets={false}
                  allowAutoPublish
                  accountsOf={(pid) => platformAccounts[pid] ?? []}
                  copyText={() => `${article.title}\n\n${strippedBodyOf(article.bodyMd)}`}
                  copyParts={() => [
                    { label: '标题', text: article.title },
                    { label: '正文', text: strippedBodyOf(article.bodyMd) },
                  ]}
                  buildDraft={(target) => buildStudioDraft(target, article)}
                  onMarked={() => {
                    void fetchStudioPublishes(PLATFORM, article.id).then(setPublishes);
                    void refreshArticles();
                  }}
                />
                {publishes.length > 0 ? (
                  <div className={c('card')}>
                    <div className={c('cardLabel')}>发布记录</div>
                    <div className={c('records')}>
                      {publishes.map((p) => (
                        <div key={p.id} className={c('record')}>
                          <span className={c('recordTime')}>{timeLabel(p.createdAt)}</span>
                          <span className={`${c('chip')} ${p.status === 'ok' ? c('chipGreen') : c('chipRed')}`}>
                            {p.status === 'ok' ? '成功' : '失败'}
                          </span>
                          <span>{p.accountName}</span>
                          {p.error ? <span className={c('recordError')}>{p.error.slice(0, 120)}</span> : null}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </>
            )
          ) : null}

          {tab === 'topics' && stepDone.topics ? (
            <NextStepBar hint="选题已用,去写作出稿" label="去写作" onGo={() => setTab('write')} />
          ) : null}
          {tab === 'cover' && article?.coverSource ? (
            <NextStepBar hint="封面已就绪;配图可选,也可以直接去发布" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>
        {showPreview ? (
          <div className={c('previewCol')}>
            <span className={c('previewTag')}>
              <Icon name="eye" size={13} /> 实时预览（图文效果，含导入的图片）
            </span>
            <div className={c('previewShell')}>
              <iframe
                className={c('previewFrame')}
                sandbox=""
                title="知乎文章预览"
                srcDoc={zhihuPreviewDoc({
                  title: article?.title ?? '',
                  bodyMd: article?.bodyMd ?? '',
                  ...(article?.coverSource ? { coverUrl: article.coverSource } : {}),
                })}
              />
            </div>
          </div>
        ) : null}
      </div>

      {aiTask ? (
        <StudioAiPanel
          ref={aiPanelRef}
          task={aiTask}
          onFinished={refreshAfterAiTask}
          onDismiss={() => setAiTask(null)}
          onRunningChange={setAiRunning}
          onStageChange={setAiStage}
        />
      ) : null}
      <StudioToastHost />
    </div>
  );
}
