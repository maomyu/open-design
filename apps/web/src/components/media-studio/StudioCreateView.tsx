// 统一创作台(2026-07-18 用户拍板路线B;同日修正:选题平台【单选】+平台导航入口移除)。
// 唯一创作动线:选平台找灵感(chip 单选,逐平台选题) → 「去写作」形态分岔(图文→小红书
// 图文台;视频→目标平台建稿跳对应台,源平台置顶) → 各台完成后发布步「一稿多发」。
// 平台 view/路由保留(跳转到达+标签栏可回),导航不再显示平台入口(与创作重复)。
import { useCallback, useEffect, useMemo, useState } from 'react';
import type { MediaTopic } from '@open-design/contracts';
import { TopicsTab } from './TopicsTab';
import {
  createStudioAiTask,
  createStudioArticle,
  createStudioTopic,
  deleteStudioTopic,
  fetchStudioTopics,
} from '../../providers/media-studio';
import { studioToast, StudioToastHost } from './StudioFeedback';
import { hasFeature, hasShortVideoPlatform, useLicense, type LicenseInfo } from '../../state/license';
import styles from './MediaStudio.module.css';

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
  const [aiBusy, setAiBusy] = useState(false);
  // 「开写」形态分岔:暂存选中的选题,渲染形态/目标选择条。
  const [pendingTopic, setPendingTopic] = useState<MediaTopic | null>(null);

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

  // 薄版「AI 帮我选题」:挂短视频池的 AI 选题任务,完成靠轮询刷新候选列表。
  const aiFind = useCallback(
    async (note: string, picked?: Array<{ title: string; url?: string; account?: string; readNum?: number | null }>) => {
      setAiBusy(true);
      const created = await createStudioAiTask(TOPIC_POOL, {
        kind: 'topics',
        input: { ...(note ? { note } : {}), ...(picked && picked.length > 0 ? { picked } : {}) },
      });
      if ('error' in created) {
        setAiBusy(false);
        studioToast.err(created.error);
        return;
      }
      studioToast.ok('AI 选题任务已启动——候选会陆续出现在下方(约 1-2 分钟)。');
      // 轮询 2 分钟:每 5s 刷一次候选;到点自动收尾。
      let ticks = 0;
      const timer = window.setInterval(() => {
        ticks += 1;
        void refreshTopics();
        if (ticks >= 24) {
          window.clearInterval(timer);
          setAiBusy(false);
        }
      }, 5000);
    },
    [refreshTopics],
  );

  /** 图文形态:在 note 池建稿(复制选题引用)→ 记住稿 → 跳小红书入口(图文形态)。 */
  async function writeAsNote(topic: MediaTopic) {
    // note 池复制一条候选(fromTopicId 标记 used 需同池;跨池用标题引用即可)。
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
    window.localStorage.setItem('open-design:studio:last-note', created.id);
    window.localStorage.setItem('open-design:studio:xiaohongshu-form', 'note');
    setPendingTopic(null);
    onNavigate('studio-xiaohongshu');
  }

  /** 视频形态:在 short-video 池建稿(归属所选平台)→ 记住稿 → 跳对应平台台。 */
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
    window.localStorage.setItem(`open-design:studio:last-video-article:${target.svId}`, created.id);
    if (target.svId === 'xiaohongshu') window.localStorage.setItem('open-design:studio:xiaohongshu-form', 'video');
    setPendingTopic(null);
    setTopics((list) => list.map((t) => (t.id === topic.id ? { ...t, status: 'used' } : t)));
    onNavigate(target.nav);
  }

  const collectTargets = [source];
  // 形态分岔的视频目标:当前选题源平台置顶(逐平台工作流,源=目标最常见)。
  const srcAsSv = source === 'channels' ? 'tencent' : source;
  const videoTargets = VIDEO_TARGETS.filter((t) => t.licensed(license)).sort(
    (a, b) => Number(b.svId === srcAsSv) - Number(a.svId === srcAsSv),
  );
  const canNote = hasFeature(license, 'note.xiaohongshu');

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>创作</h1>
        <span className={c('cardHint')}>选平台找灵感 → 选形态开写 → 完成后发布步可一稿多发到其他平台</span>
      </div>

      {/* 选题平台【单选 chip】(2026-07-18 用户拍板:逐个平台选题):与小红书形态
          切换同款交互,切平台即切采集目标,无多余勾选操作。 */}
      <div className={c('articleSwitch')}>
        <span className={c('articleSwitchLabel')}>选题平台</span>
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
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 10, fontSize: 12.5 }}>
            <label style={{ cursor: 'pointer' }}>
              <input type="radio" name="xhs-type" checked={xhsType === 'image'} onChange={() => setXhsType('image')} /> 图文
            </label>
            <label style={{ cursor: 'pointer' }}>
              <input type="radio" name="xhs-type" checked={xhsType === 'video'} onChange={() => setXhsType('video')} /> 视频
            </label>
          </span>
        ) : null}
      </div>

      {/* 形态分岔条:点了候选「开写」后出现。 */}
      {pendingTopic ? (
        <div className={c('card')} style={{ borderColor: '#e8582e' }}>
          <div className={c('cardLabel')}>
            「{pendingTopic.title.slice(0, 24)}」做成什么?
            <span className={c('cardHint')}>图文只能发小红书;视频可发各视频平台(选一个主平台开写,PR3 分发支持一稿多发)</span>
          </div>
          <div className={c('row')} style={{ gap: 8, flexWrap: 'wrap' }}>
            {canNote ? (
              <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void writeAsNote(pendingTopic)}>
                🖼 图文笔记(小红书)
              </button>
            ) : null}
            {videoTargets.map((t) => (
              <button key={t.nav} type="button" className={c('btn')} onClick={() => void writeAsVideo(pendingTopic, t)}>
                🎬 视频 · {t.label}
              </button>
            ))}
            <button type="button" className={c('btn')} onClick={() => setPendingTopic(null)}>
              取消
            </button>
          </div>
        </div>
      ) : null}

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
        onWrite={(topic) => setPendingTopic(topic)}
        onAiFind={(note, picked) => void aiFind(note, picked)}
        aiBusy={aiBusy}
      />
    </div>
  );
}
