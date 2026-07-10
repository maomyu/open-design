// 微博创作台 — 独立一级入口(2026-07-10 用户拍板:按平台性质分台,同构
// 架构:选题 → 写作 → 发布)。
//
// 选题搜微博自己的平台(TikHub 微博热搜 50 条/站内搜索);文章实体
// platform: 'weibo' 隔离存储,可「从公众号导入」长文改写成微博体。
// 发布=安全交接(带稿开后台+复制粘贴;注入器待账号登录实测后接入)。
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
  createStudioAiTask,
  createStudioArticle,
  createStudioTopic,
  deleteStudioArticle,
  deleteStudioTopic,
  fetchStudioArticle,
  fetchStudioArticles,
  fetchStudioPublishes,
  fetchStudioTopics,
  updateStudioArticle,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { NextStepBar, SaveStatusBadge, StudioToastHost, studioToast } from './StudioFeedback';
import { ArticleListCard, SafeHandoffCard, VersionsCard } from './StudioSharedCards';
import { buildStudioDraft, strippedBodyOf } from './draft-builders';
import { loadStudioPref, saveStudioPref } from './studio-prefs';
import { TopicsTab, type PickedHit } from './TopicsTab';
import { weiboPreviewDoc } from './zhihu-preview';
import { useOrphanRun } from './useOrphanRun';
import { usePlatformAccountNames } from './usePlatformAccounts';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

const PLATFORM = 'weibo';
const LAST_ARTICLE_KEY = 'open-design:studio:last-weibo-article';

type WeiboTab = 'topics' | 'write' | 'publish' | 'list';

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

export function WeiboStudioView(): JSX.Element {
  const [articles, setArticles] = useState<MediaArticleSummary[] | null>(null);
  const [article, setArticle] = useState<MediaArticle | null>(null);
  const [tab, setTab] = useState<WeiboTab>('write');
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
  const [aiWordCount, setAiWordCount] = useState(() => loadStudioPref('wordcount:weibo', '100-140'));
  const [publishes, setPublishes] = useState<MediaPublishRecord[]>([]);
  const [importOpen, setImportOpen] = useState(false);
  const [importList, setImportList] = useState<MediaArticleSummary[] | null>(null);
  const platformAccounts = usePlatformAccountNames();

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

  const stepDone: Record<WeiboTab, boolean> = {
    topics: topics.some((t) => t.status === 'used'),
    write: Boolean(article && article.title.trim() && article.bodyMd.trim()),
    publish: article?.status === 'published',
    list: false,
  };

  const TABS: Array<{ id: WeiboTab; label: string; step: string }> = [
    { id: 'topics', label: '选题', step: '1' },
    { id: 'write', label: '写作', step: '2' },
    { id: 'publish', label: '发布', step: '3' },
  ];

  const activeStatus = article ? STATUS_LABEL[article.status] : null;
  const weiboAccounts = platformAccounts[PLATFORM] ?? [];

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
        <button type="button" className={c('btn')} onClick={() => { setImportOpen((v) => !v); if (!importList) void fetchStudioArticles('wechat-mp').then(setImportList); }}>
          <Icon name="import" size={14} /> 从公众号导入
        </button>
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
        <h1 className={c('title')}>微博创作台</h1>
        {activeStatus ? <span className={`${c('chip')} ${c(activeStatus.chip)}`}>{activeStatus.text}</span> : null}
        {article && weiboAccounts.length > 0 ? (
          <select
            className={c('select')}
            value={article.accountId ?? ''}
            title="这篇文章发到哪个微博账号——发布用它的登录档案"
            onChange={(e) => editArticle({ accountId: e.target.value || null })}
          >
            <option value="">（未绑定账号）</option>
            {weiboAccounts.map((name) => (
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

      <div className={c('tabs')} role="tablist" aria-label="微博创作台导航">
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
              tikhubTargets={[{ id: 'weibo', label: '微博' }]}
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
              emptyCta('先新建一条微博，或从「选题」一键开写。')
            ) : (
              <>
                <div className={c('card')}>
                  <div className={c('cardLabel')}>
                    标题
                    <span className={c('cardHint')}>微博头条文章标题;普通微博可留空只发正文</span>
                    <span className={c('headSpacer')} />
                    <button type="button" className={c('btn')} onClick={() => { setImportOpen((v) => !v); if (!importList) void fetchStudioArticles('wechat-mp').then(setImportList); }}>
                      <Icon name="import" size={13} /> 从公众号导入
                    </button>
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
                    <span className={c('cardHint')}>普通微博建议 140 字内更利传播;长文走头条文章。发布时复制粘贴到微博发布框</span>
                  </div>
                  <textarea
                    className={c('textarea')}
                    style={{ minHeight: 380 }}
                    value={article.bodyMd}
                    placeholder="微博正文;可「从公众号导入」长文再压缩成微博体…"
                    onChange={(e) => editArticle({ bodyMd: e.target.value })}
                  />
                  <div className={c('row')}>
                    <select className={c('select')} value={aiWordCount} onChange={(e) => { setAiWordCount(e.target.value); saveStudioPref('wordcount:weibo', e.target.value, '100-140'); }}>
                      {['100-140', '300-500', '800-1200'].map((w) => (
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

          {tab === 'publish' ? (
            !article ? (
              emptyCta('发布属于某篇文章——先去「写作」新建。')
            ) : (
              <>
                <SafeHandoffCard
                  studioPlatform={PLATFORM}
                  articleId={article.id}
                  articleTitle={article.title}
                  targets={[{ id: 'weibo', label: '微博' }]}
                  defaultTarget="weibo"
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
                  oneClickLabel="一键填发布框"
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
          {tab === 'write' && stepDone.write ? (
            <NextStepBar hint="稿件就绪,去发布——带稿开微博后台" label="去发布" onGo={() => setTab('publish')} />
          ) : null}
        </div>
        {tab === 'write' && article ? (
          <div className={c('previewCol')}>
            <span className={c('previewTag')}>
              <Icon name="eye" size={13} /> 实时预览（微博发布效果）
            </span>
            <div className={c('previewShell')}>
              <iframe
                className={c('previewFrame')}
                sandbox=""
                title="微博预览"
                srcDoc={weiboPreviewDoc({ title: article.title, bodyMd: article.bodyMd })}
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
