// 统一创作台(2026-07-18 用户拍板路线B;同日修正:选题平台【单选】+平台导航入口移除;
// 再修正:选题平台区卡片化+AI 任务接 StudioAiPanel 实时进度,用户反馈"看不到智能体在干嘛")。
// 唯一创作动线(2026-07-18 终版):顶部选好 平台+形态(=创作意图声明) → 候选点
// 「去创作」一键直达(不二次询问)→ 嵌入台就地展开(零跳页)→ 发布步「一稿多发」。
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
  importXhsNote,
  updateStudioArticle,
  fetchSourceMaterial,
  downloadVideoByUrl,
  topicOriginPlatform,
} from '../../providers/media-studio';
import { StudioAiPanel, type StudioAiOutcome, type StudioAiPanelHandle, type StudioAiTask } from './StudioAiPanel';
import { studioToast, StudioToastHost } from './StudioFeedback';
import { useOrphanRun, useAiRunElapsed, fmtRunElapsed } from './useOrphanRun';
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
// 选题/建稿的存储池:有短视频授权走 short-video 池;仅图文(如油炸总=小红书图文)走 note 池——
// 否则 short-video 池被 sv.* 授权拦截,「存为候选」403 存不进去(2026-07-20 实测:候选存不成功的根因)。
const SV_POOL_PLATFORMS = ['douyin', 'kuaishou', 'tencent', 'bilibili', 'xiaohongshu'] as const;
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
  const TOPIC_POOL = SV_POOL_PLATFORMS.some((p) => hasShortVideoPlatform(license, p)) ? 'short-video' : 'note';
  const allowedSources = useMemo(() => SOURCE_DEFS.filter((s) => s.licensed(license)), [license]);
  // 小红书是否含【视频形态】:未授权短视频(如油炸总合同=小红书图文)时只出图文,不给视频切换。
  const allowXhsVideo = hasShortVideoPlatform(license, 'xiaohongshu');
  // 数据源【单选】(2026-07-18 用户拍板:创作时逐个平台选题,不混采)。chip 切换,记忆上次。
  const [source, setSource] = useState<string>(() => loadSource(allowedSources.map((s) => s.id)));
  const [xhsType, setXhsType] = useState<'image' | 'video'>('image');
  // 未授权视频形态时锁死图文(防 localStorage/历史态残留成 video)。
  const effectiveXhsType = allowXhsVideo ? xhsType : 'image';
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
  // 计时基准取后台 run 真实开始时间,切走导航/刷新重挂载不归零(2026-07-21 用户反馈,与煜见对齐)。
  const aiElapsed = useAiRunElapsed(effectiveAiRunning, orphan?.startedAt);
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
        // sourcePlatform:选题给当前所选平台用——AI 引用链接只准站内链接,站外来源
        // (新闻/公众号)只写来源名不带 url(2026-07-18 用户拍板:小红书选题必须全来自小红书)。
        input: { ...(note ? { note } : {}), ...(picked && picked.length > 0 ? { picked } : {}), sourcePlatform: source },
      });
      if ('error' in created) {
        studioToast.err(created.error);
        return;
      }
      aiSeqRef.current += 1;
      setAiTask({ ...created, seq: aiSeqRef.current });
    },
    [source],
  );

  const refreshAfterAiTask = useCallback(
    (outcome: StudioAiOutcome) => {
      void refreshTopics();
      if (outcome === 'done') studioToast.ok('AI 选题完成——候选已更新,点「去创作」开做。');
    },
    [refreshTopics],
  );

  /** 图文形态:在 note 池建稿 → 原素材(原文案/原图)随稿带走 → 就地展开嵌入图文台。 */
  async function writeAsNote(topic: MediaTopic) {
    const noteTopic = await createStudioTopic('note', { title: topic.title, ...(topic.angle ? { angle: topic.angle } : {}), ...(topic.url ? { url: topic.url } : {}) });
    const created = await createStudioArticle('note', {
      ...(noteTopic ? { fromTopicId: noteTopic.id } : {}),
      title: topic.title,
      topic: topic.title,
      // 原素材上稿:原文参考卡展示 + AI 写笔记 prompt 自动带「原文参考·仿写不照抄」。
      extra: {
        targetPlatform: '小红书',
        ...(topic.url ? { sourceUrl: topic.url } : {}),
        ...(topic.sourceContent ? { sourceContent: topic.sourceContent } : {}),
      },
    });
    if (!created) {
      studioToast.err('建稿失败——稍后再试');
      return;
    }
    // 候选自带原图直链(真抓爆款采集时挂的)→ 直接下参考素材区;只有 url 的(AI选题)
    // 由 NoteStudioView 挂载时自动抓(2026-07-18 用户反馈根因:候选库里没原文案)。
    if ((topic.sourceImages?.length ?? 0) > 0) {
      studioToast.info('正在下载原图到参考素材区…');
      const r = await importXhsNote(created.id, topic.sourceContent || '', topic.sourceImages ?? []);
      if (!('error' in r) && r.imageUrls.length > 0) {
        await updateStudioArticle('note', created.id, { extra: { sourceImages: r.imageUrls } });
      }
    }
    // 流程(2026-07-18 用户拍板):去创作第一步=自动拉原素材(NoteStudioView 挂载时拉),
    // 拉完由用户主动点「AI 写笔记」才写正文——不自动跑仿写,写作主动权在用户。
    setActiveDraft({ articleId: created.id, form: 'note', title: topic.title });
  }

  /** 视频形态:在 short-video 池建稿(归属所选平台)→ 就地展开嵌入视频台(零跳页)。 */
  async function writeAsVideo(topic: MediaTopic, target: (typeof VIDEO_TARGETS)[number]) {
    const created = await createStudioArticle(TOPIC_POOL, {
      fromTopicId: topic.id,
      title: topic.title,
      topic: topic.title,
      // 原素材第一步到位(2026-07-18 用户拍板):候选自带的原文案立即种进「对照原爆款」
      // (sourceTranscript),不等后台下载;原视频仍后台异步下。
      extra: {
        targetPlatform: target.label,
        ...(topic.url ? { sourceUrl: topic.url } : {}),
        ...(topic.sourceContent ? { sourceTranscript: topic.sourceContent } : {}),
      },
    });
    if (!created) {
      studioToast.err('建稿失败——稍后再试');
      return;
    }
    setTopics((list) => list.map((t) => (t.id === topic.id ? { ...t, status: 'used' } : t)));
    setActiveDraft({ articleId: created.id, form: 'video', svId: target.svId as SauPlatformId, title: topic.title });
    // 原视频自动下载(2026-07-18 用户拍板):按链接取媒体直链→下原片→写 sourceVideoFile,
    // 脚本步「对照原爆款」直接内嵌原视频播放器。后台异步,不阻塞进创作区(大文件耗时)。
    if (topic.url) {
      studioToast.info('正在后台下载原视频…(大文件稍等,完成后脚本步可对照播放)');
      void (async () => {
        const src = await fetchSourceMaterial(topic.url);
        if ('error' in src || !src.mediaUrl) return;
        const dl = await downloadVideoByUrl(src.mediaUrl, src.referer || topic.url, topic.title);
        if ('error' in dl) return;
        await updateStudioArticle(TOPIC_POOL, created.id, {
          extra: { sourceVideoFile: dl.file, ...(src.text ? { sourceTranscript: src.text } : {}) },
        });
        studioToast.ok('原视频已下载,脚本步「对照原爆款」可播放对照');
      })();
    }
  }

  const collectTargets = [source];

  /** 一键直达:按顶部已选的 平台+形态 直接建稿进创作区(用户拍板:意图已声明,不二次询问)。 */
  async function startCreate(topic: MediaTopic) {
    if (source === 'xiaohongshu' && effectiveXhsType === 'image') {
      await writeAsNote(topic);
      return;
    }
    const svId = (source === 'channels' ? 'tencent' : source) as SauPlatformId;
    const target = VIDEO_TARGETS.find((t) => t.svId === svId) ?? VIDEO_TARGETS[0]!;
    await writeAsVideo(topic, target);
  }

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
            <button type="button" className={c('btn')} onClick={() => { setActiveDraft(null); void refreshTopics(); }}>
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
          {/* 内容形态切换仅在【授权了小红书视频】时出现;否则合同=图文,无需切换(锁图文)。 */}
          {source === 'xiaohongshu' && allowXhsVideo ? (
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
        xhsContentType={effectiveXhsType}
        /* 统一创作台(短视频/图文)一律不走 AI 转题——采集的爆款直接「存为候选」(2026-07-20 用户:
           无论哪个平台,爆款列表移除 AI 转题,只留存为候选)。隐藏顶部「AI 帮我选题」+ 每条爆款的
           AI 入口,只留「存为候选」(逐条 + 全部)。 */
        hideAiTopic
        /* 按当前所选源过滤候选(2026-07-18:小红书选题必须全部来自小红书):显示 本平台链接 + 无链接
           灵感题 + url 格式不规范(other)的;只藏【明确是别平台】的链接。加 other 是因为采集回来的
           爆款 url 有时不规范,被判 other 就看不到「存为候选」存进去的题(2026-07-20 用户报)。 */
        topics={topics.filter((t) => { const o = topicOriginPlatform(t.url); return o === 'any' || o === source || o === 'other'; })}
        onAdd={async (draft) => {
          const created = await createStudioTopic(TOPIC_POOL, draft);
          if (created) setTopics((list) => [created, ...list]);
        }}
        onDelete={async (id) => {
          if (await deleteStudioTopic(TOPIC_POOL, id)) setTopics((list) => list.filter((t) => t.id !== id));
        }}
        /* 一键直达(2026-07-18 用户拍板:顶部 平台+形态 已是创作意图声明,不再二次
           询问):点「去创作」直接按当前选择建稿进创作区,零弹窗。 */
        onWrite={(topic) => void startCreate(topic)}
        onAiFind={(note, picked) => void aiFind(note, picked)}
        aiBusy={effectiveAiRunning}
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
            ⏳ AI 任务仍在后台运行(切换页面/刷新都不影响,候选完成自动更新)· 已运行 {fmtRunElapsed(aiElapsed)};
            <button type="button" className={c('btn')} style={{ marginLeft: 8 }} onClick={() => void cancelOrphan()}>
              中止它
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
