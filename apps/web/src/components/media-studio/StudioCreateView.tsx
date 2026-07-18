// 统一创作台(2026-07-18 用户拍板路线B;同日修正:选题平台【单选】+平台导航入口移除;
// 再修正:选题平台区卡片化+AI 任务接 StudioAiPanel 实时进度,用户反馈"看不到智能体在干嘛")。
// 唯一创作动线:选平台找灵感(chip 单选,逐平台选题) → 「去写作」形态分岔(图文→小红书
// 图文台;视频→目标平台建稿跳对应台,源平台置顶) → 各台完成后发布步「一稿多发」。
// 平台 view/路由保留(跳转到达+标签栏可回),导航不再显示平台入口(与创作重复)。
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MediaTopic } from '@open-design/contracts';
import { TopicsTab } from './TopicsTab';
import {
  createStudioAiTask,
  createStudioArticle,
  createStudioTopic,
  deleteStudioTopic,
  fetchStudioTopics,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { studioToast, StudioToastHost } from './StudioFeedback';
import { useOrphanRun } from './useOrphanRun';
import { NoteStudioView } from './NoteStudioView';
import { ShortVideoStudioView } from './ShortVideoStudioView';
import type { SauPlatformId } from '@open-design/contracts';
import { hasFeature, hasShortVideoPlatform, useLicense, type LicenseInfo } from '../../state/license';
import styles from './MediaStudio.module.css';

/** 单页创作流(2026-07-18 用户拍板"零跳页"):去写作后就地展开嵌入台。localStorage 恢复。 */
interface ActiveDraft { articleId: string; form: 'note' | 'video'; svId?: SauPlatformId; title: string }
const DRAFT_KEY = 'open-design:studio:create:active-draft';
function loadActiveDraft(): ActiveDraft | null {
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const d = JSON.parse(raw) as ActiveDraft;
    return d && typeof d.articleId === 'string' && (d.form === 'note' || d.form === 'video') ? d : null;
  } catch {
    return null;
  }
}

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 选题池与短视频台共享(short-video):创作台采的爆款/候选,各平台台也看得到。 */
const TOPIC_POOL = 'short-video';
const SOURCES_KEY = 'open-design:studio:create:sources';

/** 数据源目录:id=引擎采集平台 id(视频号=channels 走极致数据),按授权过滤。 */
const SOURCE_DEFS: Array<{ id: string; label: string; licensed: (l: LicenseInfo) => boolean }> = [
  { id: 'xiaohongshu', label: '🔴 小红书', licensed: (l) => hasShortVideoPlatform(l, 'xiaohongshu') || hasFeature(l, 'note.xiaohongshu') },
  { id: 'douyin', label: '🎵 抖音', licensed: (l) => hasShortVideoPlatform(l, 'douyin') },
  { id: 'kuaishou', label: '⚡ 快手', licensed: (l) => hasShortVideoPlatform(l, 'kuaishou') },
  { id: 'bilibili', label: '📺 B站', licensed: (l) => hasShortVideoPlatform(l, 'bilibili') },
  { id: 'channels', label: '📱 视频号', licensed: (l) => hasShortVideoPlatform(l, 'tencent') },
];

/** 视频形态的目标平台(建稿归属,targetPlatform 存中文名与各台过滤一致)。 */
const VIDEO_TARGETS: Array<{ nav: string; svId: string; label: string; licensed: (l: LicenseInfo) => boolean }> = [
  { nav: 'studio-douyin', svId: 'douyin', label: '抖音', licensed: (l) => hasShortVideoPlatform(l, 'douyin') },
  { nav: 'studio-xiaohongshu', svId: 'xiaohongshu', label: '小红书', licensed: (l) => hasShortVideoPlatform(l, 'xiaohongshu') },
  { nav: 'studio-kuaishou', svId: 'kuaishou', label: '快手', licensed: (l) => hasShortVideoPlatform(l, 'kuaishou') },
  { nav: 'studio-bilibili', svId: 'bilibili', label: 'B站', licensed: (l) => hasShortVideoPlatform(l, 'bilibili') },
  { nav: 'studio-shipinhao', svId: 'tencent', label: '视频号', licensed: (l) => hasShortVideoPlatform(l, 'tencent') },
];

function loadSource(allowed: string[]): string {
  try {
    const raw = window.localStorage.getItem(SOURCES_KEY);
    if (raw && allowed.includes(raw)) return raw;
  } catch { /* fall through */ }
  // 默认小红书(演示优先);没授权则第一个可用源。
  return allowed.includes('xiaohongshu') ? 'xiaohongshu' : (allowed[0] ?? 'xiaohongshu');
}

export function StudioCreateView({ onNavigate }: { onNavigate: (view: string) => void }): JSX.Element {
  const license = useLicense();
  const allowedSources = useMemo(() => SOURCE_DEFS.filter((s) => s.licensed(license)), [license]);
  // 数据源【单选】(2026-07-18 用户拍板:创作时逐个平台选题,不混采)。chip 切换,记忆上次。
  const [source, setSource] = useState<string>(() => loadSource(allowedSources.map((s) => s.id)));
  const [xhsType, setXhsType] = useState<'image' | 'video'>('image');
  const [topics, setTopics] = useState<MediaTopic[]>([]);
  // AI 任务走 StudioAiPanel(与各平台台同款):实时流式输出/工具步骤/可中止,
  // 用户反馈"只显示执行中看不到进度"——薄版轮询已废弃。
  const [aiTask, setAiTask] = useState<StudioAiTask | null>(null);
  const [aiRunning, setAiRunning] = useState(false);
  const aiSeqRef = useRef(0);
  const aiPanelRef = useRef<StudioAiPanelHandle | null>(null);
  // 页面刷新/热更后认领孤儿 AI 任务,进度不丢。
  const { orphan, cancelOrphan } = useOrphanRun(aiTask === null);
  const effectiveAiRunning = aiRunning || orphan != null;
  // 「开写」形态分岔:暂存选中的选题,渲染形态/目标选择条。
  const [pendingTopic, setPendingTopic] = useState<MediaTopic | null>(null);
  // 单页创作流:选完形态就地展开嵌入台(零跳页)。刷新后从 localStorage 恢复。
  const [activeDraft, setActiveDraftRaw] = useState<ActiveDraft | null>(loadActiveDraft);
  const setActiveDraft = (d: ActiveDraft | null) => {
    setActiveDraftRaw(d);
    try {
      if (d) window.localStorage.setItem(DRAFT_KEY, JSON.stringify(d));
      else window.localStorage.removeItem(DRAFT_KEY);
    } catch { /* best-effort */ }
  };

  const pickSource = (id: string) => {
    setSource(id);
    window.localStorage.setItem(SOURCES_KEY, id);
  };

  const refreshTopics = useCallback(async () => {
    setTopics((await fetchStudioTopics(TOPIC_POOL)) ?? []);
  }, []);
  useEffect(() => {
    void refreshTopics();
  }, [refreshTopics]);

  // AI 任务运行中每 3 秒轮询候选——agent 中途写回的选题实时上屏(与各台同款节奏)。
  useEffect(() => {
    if (!effectiveAiRunning) return;
    const timer = window.setInterval(() => {
      void refreshTopics();
    }, 3000);
    return () => window.clearInterval(timer);
  }, [effectiveAiRunning, refreshTopics]);

  const aiFind = useCallback(
    async (note: string, picked?: Array<{ title: string; url?: string; account?: string; readNum?: number | null }>) => {
      const created = await createStudioAiTask(TOPIC_POOL, {
        kind: 'topics',
        input: { ...(note ? { note } : {}), ...(picked && picked.length > 0 ? { picked } : {}) },
      });
      if ('error' in created) {
        studioToast.err(created.error);
        return;
      }
      aiSeqRef.current += 1;
      setAiTask({ ...created, seq: aiSeqRef.current });
    },
    [],
  );

  const refreshAfterAiTask = useCallback(
    (outcome: StudioAiOutcome) => {
      void refreshTopics();
      if (outcome === 'done') studioToast.ok('AI 选题完成——候选已更新,点「去写作」开做。');
    },
    [refreshTopics],
  );

  /** 图文形态:在 note 池建稿 → 就地展开嵌入图文台(零跳页)。 */
  async function writeAsNote(topic: MediaTopic) {
    const noteTopic = await createStudioTopic('note', { title: topic.title, ...(topic.angle ? { angle: topic.angle } : {}), ...(topic.url ? { url: topic.url } : {}) });
    const created = await createStudioArticle('note', {
      ...(noteTopic ? { fromTopicId: noteTopic.id } : {}),
      title: topic.title,
      topic: topic.title,
    });
    if (!created) {
      studioToast.err('建稿失败——稍后再试');
      return;
    }
    setPendingTopic(null);
    setActiveDraft({ articleId: created.id, form: 'note', title: topic.title });
  }

  /** 视频形态:在 short-video 池建稿(归属所选平台)→ 就地展开嵌入视频台(零跳页)。 */
  async function writeAsVideo(topic: MediaTopic, target: (typeof VIDEO_TARGETS)[number]) {
    const created = await createStudioArticle(TOPIC_POOL, {
      fromTopicId: topic.id,
      title: topic.title,
      topic: topic.title,
      extra: { targetPlatform: target.label },
    });
    if (!created) {
      studioToast.err('建稿失败——稍后再试');
      return;
    }
    setPendingTopic(null);
    setTopics((list) => list.map((t) => (t.id === topic.id ? { ...t, status: 'used' } : t)));
    setActiveDraft({ articleId: created.id, form: 'video', svId: target.svId as SauPlatformId, title: topic.title });
  }

  const collectTargets = [source];
  // 形态分岔的视频目标:当前选题源平台置顶(逐平台工作流,源=目标最常见)。
  const srcAsSv = source === 'channels' ? 'tencent' : source;
  const videoTargets = VIDEO_TARGETS.filter((t) => t.licensed(license)).sort(
    (a, b) => Number(b.svId === srcAsSv) - Number(a.svId === srcAsSv),
  );
  const canNote = hasFeature(license, 'note.xiaohongshu');

  // 单页创作流:有进行中的稿 → 收起找题区,就地展开嵌入台(零跳页)。
  if (activeDraft) {
    const draftPlatLabel =
      activeDraft.form === 'note'
        ? '小红书图文'
        : `${VIDEO_TARGETS.find((t) => t.svId === activeDraft.svId)?.label ?? '抖音'}视频`;
    return (
      <div className={c('root')}>
        <StudioToastHost />
        <div className={c('head')}>
          <h1 className={c('title')}>创作</h1>
        </div>
        {/* 「正在做」条:位置感钉死——标题+形态+回找题。 */}
        <div className={c('card')} style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span style={{ fontWeight: 700, fontSize: 13.5 }}>
            正在做:《{activeDraft.title.slice(0, 30) || '未命名'}》· {draftPlatLabel}
          </span>
          <span className={c('cardHint')}>下面完成 文案/脚本→素材→发布;发布步可一稿多发</span>
          <span style={{ marginLeft: 'auto' }}>
            <button type="button" className={c('btn')} onClick={() => setActiveDraft(null)}>
              ← 回选题(稿已自动保存)
            </button>
          </span>
        </div>
        {activeDraft.form === 'note' ? (
          <NoteStudioView key={activeDraft.articleId} entryMode="embedded" articleId={activeDraft.articleId} />
        ) : (
          <ShortVideoStudioView
            key={activeDraft.articleId}
            entryMode="embedded"
            articleId={activeDraft.articleId}
            platform={activeDraft.svId ?? 'douyin'}
          />
        )}
      </div>
    );
  }

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>创作</h1>
        <span className={c('cardHint')}>选平台找灵感 → 选形态开写 → 完成后发布步可一稿多发到其他平台</span>
      </div>

      {/* 选题平台【单选】:卡片化(2026-07-18 用户反馈原 chip 裸排太乱)。
          与下方卡片同宽同风格;小红书时右侧带 图文/视频 二选 chip。 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          选题平台
          <span className={c('cardHint')}>选一个平台找灵感——采集/AI 选题都只针对它(逐平台选题)</span>
        </div>
        <div className={c('row')} style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          {allowedSources.map((s) => (
            <button
              key={s.id}
              type="button"
              className={`${c('articleSwitchBtn')}${s.id === source ? ` ${c('articleSwitchBtnActive')}` : ''}`}
              aria-pressed={s.id === source}
              onClick={() => pickSource(s.id)}
            >
              {s.label}
            </button>
          ))}
          {source === 'xiaohongshu' ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 'auto' }}>
              <span className={c('cardHint')}>内容形态</span>
              {(['image', 'video'] as const).map((tpe) => (
                <button
                  key={tpe}
                  type="button"
                  className={`${c('articleSwitchBtn')}${xhsType === tpe ? ` ${c('articleSwitchBtnActive')}` : ''}`}
                  aria-pressed={xhsType === tpe}
                  onClick={() => setXhsType(tpe)}
                >
                  {tpe === 'image' ? '图文' : '视频'}
                </button>
              ))}
            </span>
          ) : null}
        </div>
      </div>

      <TopicsTab
        platform={TOPIC_POOL}
        browserCollect
        collectPlatforms={collectTargets}
        xhsContentType={xhsType}
        topics={topics}
        onAdd={async (draft) => {
          const created = await createStudioTopic(TOPIC_POOL, draft);
          if (created) setTopics((list) => [created, ...list]);
        }}
        onDelete={async (id) => {
          if (await deleteStudioTopic(TOPIC_POOL, id)) setTopics((list) => list.filter((t) => t.id !== id));
        }}
        onWrite={(topic) => setPendingTopic((cur) => (cur?.id === topic.id ? null : topic))}
        onAiFind={(note, picked) => void aiFind(note, picked)}
        aiBusy={effectiveAiRunning}
        /* 行内展开(2026-07-18 用户反馈"去写作弹在顶上看不见"):形态选择就在被点
           的那一行正下方,视线零移动。再点一次「去写作」收起。 */
        expandedTopicId={pendingTopic?.id ?? null}
        renderTopicExpansion={(topic) => (
          <div className={c('row')} style={{ gap: 8, flexWrap: 'wrap', alignItems: 'center', padding: '4px 0' }}>
            <span style={{ fontWeight: 600, fontSize: 12.5 }}>这条做成:</span>
            {canNote ? (
              <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void writeAsNote(topic)}>
                🖼 图文笔记(小红书)
              </button>
            ) : null}
            {videoTargets.map((t) => (
              <button key={t.nav} type="button" className={c('btn')} onClick={() => void writeAsVideo(topic, t)}>
                🎬 视频 · {t.label}
              </button>
            ))}
            <button type="button" className={c('btn')} onClick={() => setPendingTopic(null)}>
              取消
            </button>
          </div>
        )}
      />

      {/* AI 任务面板(与各平台台同款):实时流式输出/工具步骤/可中止——
          用户反馈"看不到智能体在干嘛"的答案就是它。 */}
      <StudioAiPanel
        ref={aiPanelRef}
        task={aiTask}
        onFinished={refreshAfterAiTask}
        onDismiss={() => setAiTask(null)}
        onRunningChange={setAiRunning}
      />
      {/* 孤儿任务(页面刷新前启动的)提示:候选仍会自动更新,可中止。 */}
      {orphan != null && aiTask === null ? (
        <div className={c('card')}>
          <div className={c('cardHint')}>
            ⏳ 有一个 AI 任务仍在后台运行(页面刷新前启动)——候选会自动更新;
            <button type="button" className={c('btn')} style={{ marginLeft: 8 }} onClick={() => void cancelOrphan()}>
              中止它
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
