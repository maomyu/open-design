// 统一创作台(2026-07-18 用户拍板,路线B PR1):内容优先——平台差异拆进三个开关
// (选题=数据源多选、内容=形态分岔、分发=目标多选,PR3)。本 PR 交付:
//   ① 多源爆款雷达:5 平台数据源 checkbox,一次采集混合候选(来源在候选行 account 列);
//   ② 「开写」形态分岔:图文笔记→小红书图文台;视频→选目标平台跳对应台(建稿+记忆稿id)。
// 平台快捷入口保留并存(用户拍板),创作台不替代它们,先做"跨平台找灵感"的增量价值。
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

function loadSources(allowed: string[]): Set<string> {
  try {
    const raw = window.localStorage.getItem(SOURCES_KEY);
    if (raw) {
      const arr = (JSON.parse(raw) as unknown[]).filter((s): s is string => typeof s === 'string' && allowed.includes(s));
      if (arr.length > 0) return new Set(arr);
    }
  } catch { /* fall through */ }
  // 默认勾小红书(演示优先);没授权小红书则勾第一个可用源。
  return new Set(allowed.includes('xiaohongshu') ? ['xiaohongshu'] : allowed.slice(0, 1));
}

export function StudioCreateView({ onNavigate }: { onNavigate: (view: string) => void }): JSX.Element {
  const license = useLicense();
  const allowedSources = useMemo(() => SOURCE_DEFS.filter((s) => s.licensed(license)), [license]);
  const [sources, setSources] = useState<Set<string>>(() => loadSources(allowedSources.map((s) => s.id)));
  const [xhsType, setXhsType] = useState<'image' | 'video'>('image');
  const [topics, setTopics] = useState<MediaTopic[]>([]);
  const [aiBusy, setAiBusy] = useState(false);
  // 「开写」形态分岔:暂存选中的选题,渲染形态/目标选择条。
  const [pendingTopic, setPendingTopic] = useState<MediaTopic | null>(null);

  const toggleSource = (id: string) => {
    setSources((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      if (next.size === 0) next.add(id); // 至少留一个源
      window.localStorage.setItem(SOURCES_KEY, JSON.stringify([...next]));
      return next;
    });
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

  const collectTargets = [...sources];
  const videoTargets = VIDEO_TARGETS.filter((t) => t.licensed(license));
  const canNote = hasFeature(license, 'note.xiaohongshu');

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>创作</h1>
        <span className={c('cardHint')}>跨平台找灵感 → 选形态开写 → 到对应平台完成与发布(分发一稿多发即将上线)</span>
      </div>

      {/* 数据源多选:平台在这里=「从哪找灵感」,不是「发到哪」。 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          选题数据源
          <span className={c('cardHint')}>勾选要采集的平台,可多选——一次真抓爆款同时看多个平台谁在爆(候选带来源)</span>
        </div>
        <div className={c('row')} style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          {allowedSources.map((s) => (
            <label key={s.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 5, cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={sources.has(s.id)} onChange={() => toggleSource(s.id)} />
              {s.label}
            </label>
          ))}
          {sources.has('xiaohongshu') ? (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, marginLeft: 8, fontSize: 12.5 }}>
              <span className={c('cardHint')}>小红书内容:</span>
              <label style={{ cursor: 'pointer' }}>
                <input type="radio" name="xhs-type" checked={xhsType === 'image'} onChange={() => setXhsType('image')} /> 图文
              </label>
              <label style={{ cursor: 'pointer' }}>
                <input type="radio" name="xhs-type" checked={xhsType === 'video'} onChange={() => setXhsType('video')} /> 视频
              </label>
            </span>
          ) : null}
        </div>
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
