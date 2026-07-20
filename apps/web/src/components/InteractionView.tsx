// 互动运营（W8 的 UI 侧）：自动评论回复——维护关键词匹配规则 + 对一条笔记预览命中/一键真发。
// 与 od studio auto-reply / rules 同源同端点(UI/CLI 双轨)。读评论→匹配→拟人回复,受风控台账门控。
// 平台:小红书(W3/W4)+ 百度知道(W14,问题页回答下的评论);知乎/微博的评论执行适配在 W9/W10。
import { useCallback, useEffect, useState } from 'react';
import type { InteractionRule, AutoReplyResponse, RuleMatchMode, InteractionAction } from '@open-design/contracts';
import { Icon } from './Icon';
import { hasFeature, useLicense } from '../state/license';
import { fetchPlatformAccounts } from '../providers/daemon';
import {
  fetchInteractionRules,
  addInteractionRule,
  updateInteractionRuleReq,
  removeInteractionRule,
  runAutoReply,
  fetchMyNotes,
  fetchStudioTopics,
  topicOriginPlatform,
} from '../providers/media-studio';
import { studioToast, StudioToastHost } from './media-studio/StudioFeedback';
import { MonitorBoard } from './media-studio/MonitorBoard';
import styles from './media-studio/MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 互动支持的平台(注入器已接入的);按授权过滤后展示。 */
type InteractionFeature = 'note.xiaohongshu' | 'article.baidu-zhidao' | 'article.zhihu' | 'article.weibo';
const INTERACTION_PLATFORMS: Array<{ id: string; label: string; noteNoun: string; licensed: (has: (f: InteractionFeature) => boolean) => boolean }> = [
  { id: 'xiaohongshu', label: '小红书', noteNoun: '笔记', licensed: (has) => has('note.xiaohongshu') },
  { id: 'baidu-zhidao', label: '百度知道', noteNoun: '问题', licensed: (has) => has('article.baidu-zhidao') },
  { id: 'zhihu', label: '知乎', noteNoun: '回答', licensed: (has) => has('article.zhihu') },
  { id: 'weibo', label: '微博', noteNoun: '帖子', licensed: (has) => has('article.weibo') },
];

export function InteractionView(): JSX.Element {
  const license = useLicense();
  const platforms = INTERACTION_PLATFORMS.filter((p) => p.licensed((f) => hasFeature(license, f)));
  const [platform, setPlatform] = useState<string>(() => platforms[0]?.id ?? 'xiaohongshu');
  const PLATFORM = platforms.some((p) => p.id === platform) ? platform : (platforms[0]?.id ?? 'xiaohongshu');
  const platformDef = INTERACTION_PLATFORMS.find((p) => p.id === PLATFORM) ?? INTERACTION_PLATFORMS[0]!;
  const noteNoun = platformDef.noteNoun; // 笔记(小红书) / 问题(百度知道)
  const [accounts, setAccounts] = useState<Array<{ id: string; name: string }>>([]);
  const [account, setAccount] = useState<string>('');
  const [rules, setRules] = useState<InteractionRule[]>([]);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState<'' | 'preview' | 'live'>('');
  const [result, setResult] = useState<AutoReplyResponse | null>(null);

  // 笔记/问题选择器(免手动贴链接):来源下拉「我的笔记 / 采集池」+ 点选即填 note。
  // 「我的笔记」抓取仅小红书有(主页笔记);百度知道只有「采集池」(检索到的问题)。
  const [noteSource, setNoteSource] = useState<'mine' | 'pool'>('mine');
  const effectiveNoteSource = PLATFORM === 'xiaohongshu' ? noteSource : 'pool';
  const [noteOptions, setNoteOptions] = useState<Array<{ title: string; url: string; meta?: string }>>([]);
  const [notesBusy, setNotesBusy] = useState(false);

  const loadNotes = useCallback(async (src: 'mine' | 'pool') => {
    setNotesBusy(true);
    setNoteOptions([]);
    if (src === 'mine' && PLATFORM === 'xiaohongshu') {
      const r = await fetchMyNotes(PLATFORM, account || null);
      setNotesBusy(false);
      if ('error' in r) { studioToast.err(r.error); return; }
      if (r.needsLogin) { studioToast.err('未登录:去「账号」页扫码登录小红书后重试'); return; }
      setNoteOptions(r.notes.map((n) => ({ title: n.title, url: n.url, ...(n.likeText ? { meta: `♡ ${n.likeText}` } : {}) })));
      if (r.notes.length === 0) studioToast.err('没抓到已发笔记(可能主页还没笔记,或需在浏览器里滚动加载)');
    } else {
      // 采集池:选题里带链接的本平台内容(小红书=爆款笔记;百度知道=问题;知乎/微博=文章台选题)。
      // 各平台选题池 key:小红书爆款在 short-video 池;文章类平台各用自己的 platform 池。
      const pool = PLATFORM === 'xiaohongshu' ? 'short-video' : PLATFORM;
      const topics = (await fetchStudioTopics(pool)) ?? [];
      setNotesBusy(false);
      const opts = topics
        .filter((t) => t.url && topicOriginPlatform(t.url) === PLATFORM)
        .map((t) => ({ title: t.title, url: t.url, ...(t.heat ? { meta: t.heat } : {}) }));
      setNoteOptions(opts);
      if (opts.length === 0) {
        const hint = PLATFORM === 'baidu-zhidao'
          ? '采集池里暂无百度知道问题——先去「文章→百度知道→选题」搜相关问题'
          : PLATFORM === 'xiaohongshu'
          ? '采集池里暂无小红书笔记——先去创作台采集爆款'
          : `采集池里暂无${platformDef.label}内容——先去「文章→${platformDef.label}→选题」找热点;也可在下面手动粘贴链接`;
        studioToast.err(hint);
      }
    }
  }, [account, PLATFORM, platformDef.label]);

  // 新增规则表单。
  const [rName, setRName] = useState('');
  const [rKw, setRKw] = useState('');
  const [rReply, setRReply] = useState('');
  const [rMode, setRMode] = useState<RuleMatchMode>('contains');
  const [rAction, setRAction] = useState<InteractionAction>('reply');
  const [rPriority, setRPriority] = useState('0');

  const refreshRules = useCallback(async () => {
    setRules(await fetchInteractionRules(PLATFORM, account || null));
  }, [account]);

  // 切平台重拉账号(各平台账号独立);顺带清掉上个平台的选中笔记/结果。
  useEffect(() => {
    void fetchPlatformAccounts().then((resp) => {
      const plat = resp?.platforms.find((p) => p.id === PLATFORM);
      const list = (plat?.accounts ?? []).map((a) => ({ id: a.id, name: a.name }));
      setAccounts(list);
      setAccount(list[0]?.name ?? '');
    });
    setNote(''); setNoteOptions([]); setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [PLATFORM]);

  useEffect(() => { void refreshRules(); }, [refreshRules]);

  async function preview(): Promise<void> {
    if (!note.trim()) { studioToast.err(`先填一条${noteNoun}链接`); return; }
    setBusy('preview'); setResult(null);
    const r = await runAutoReply({ platform: PLATFORM, account: account || null, noteRef: note.trim(), dryRun: true });
    setBusy('');
    if ('error' in r) { studioToast.err(r.error); return; }
    setResult(r);
    if (r.needsLogin) studioToast.err(`未登录:去「账号」页登录${platformDef.label}后重试`);
    else studioToast.ok(`读到 ${r.read} 条评论,命中 ${r.matched.length} 条规则(预览,未外发)`);
  }

  async function runLive(): Promise<void> {
    if (!note.trim()) { studioToast.err(`先填一条${noteNoun}链接`); return; }
    const n = result?.matched.length ?? 0;
    const ok = window.confirm(
      `将真的在「${account || '默认账号'}」下,对这条${noteNoun}里命中规则的评论发出回复(最多 3 条,逐条过风控)。\n` +
      `${n ? `当前预览命中 ${n} 条。` : ''}这是外发公开评论,确定继续?`,
    );
    if (!ok) return;
    setBusy('live'); setResult(null);
    const r = await runAutoReply({ platform: PLATFORM, account: account || null, noteRef: note.trim(), dryRun: false, maxReplies: 3 });
    setBusy('');
    if ('error' in r) { studioToast.err(r.error); return; }
    setResult(r);
    if (r.needsLogin) { studioToast.err(`未登录:去「账号」页登录${platformDef.label}后重试`); return; }
    const sent = r.dispatched.filter((d) => d.jobId).length;
    const blocked = r.dispatched.filter((d) => d.blocked).length;
    studioToast.ok(`已派发 ${sent} 条回复${blocked ? `;${blocked} 条被风控拦` : ''}(在下方浏览器标签看拟人回复)`);
  }

  async function addRule(): Promise<void> {
    const keywords = rKw.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
    if (!rName.trim() || !keywords.length || !rReply.trim()) { studioToast.err('规则名/关键词/回复文案都要填'); return; }
    const r = await addInteractionRule({
      platform: PLATFORM, accountId: account || null, name: rName.trim(), keywords,
      replyTemplate: rReply, matchMode: rMode, action: rAction, priority: Number(rPriority) || 0,
    });
    if ('error' in r) { studioToast.err(r.error); return; }
    setRName(''); setRKw(''); setRReply('');
    studioToast.ok('规则已加');
    void refreshRules();
  }

  async function toggleRule(rule: InteractionRule): Promise<void> {
    await updateInteractionRuleReq(rule.id, { enabled: !rule.enabled });
    void refreshRules();
  }
  async function delRule(id: string): Promise<void> {
    if (!window.confirm('删除这条规则?')) return;
    await removeInteractionRule(id);
    void refreshRules();
  }

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>互动运营 · 自动评论回复</h1>
        <span className={c('cardHint')}>
          维护关键词规则 → 对一条{noteNoun}读评论、命中规则的拟人回复。受风控台账门控(单账号单日上限/冷却/静默时段)。
          支持小红书 / 百度知道;知乎/微博陆续接入。
        </span>
        <div className={c('row')} style={{ marginTop: 8, flexWrap: 'wrap', gap: 8 }}>
          {platforms.length > 1 ? (
            <>
              <span className={c('cardHint')}>平台:</span>
              {platforms.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  className={`${c('chip')}${p.id === PLATFORM ? ` ${c('chipBlue')}` : ''}`}
                  style={{ cursor: 'pointer', border: 'none' }}
                  aria-pressed={p.id === PLATFORM}
                  onClick={() => setPlatform(p.id)}
                >
                  {p.label}
                </button>
              ))}
            </>
          ) : null}
          <span className={c('cardHint')}>账号:</span>
          <select className={c('select')} value={account} onChange={(e) => setAccount(e.target.value)}>
            {accounts.length === 0 ? <option value="">(去「账号」页登录{platformDef.label})</option> : null}
            {accounts.map((a) => <option key={a.id} value={a.name}>{a.name}</option>)}
          </select>
        </div>
      </div>

      {/* ── 状态监控面板(W7):多账号健康看板,置顶一眼看清各号能不能发、发了多少 ── */}
      <MonitorBoard />

      {/* ── 自动回复:对一条笔记预览/真发 ── */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          🤖 自动回复一条{noteNoun}
          <span className={c('cardHint')}>下拉选来源 → 点一条{noteNoun}(免手动复制链接)→ 先「预览」看命中,再「真发」逐条拟人回复。</span>
        </div>
        {/* 笔记/问题选择器:来源切换 + 点选即填,不用手动贴链接。百度知道只有「采集池」(检索到的问题)。 */}
        <div className={c('row')} style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className={c('cardHint')}>选{noteNoun}:</span>
          <select
            className={c('select')}
            value={effectiveNoteSource}
            disabled={PLATFORM !== 'xiaohongshu'}
            onChange={(e) => { const s = e.target.value as 'mine' | 'pool'; setNoteSource(s); void loadNotes(s); }}
          >
            {PLATFORM === 'xiaohongshu' ? <option value="mine">我的笔记(回复自己评论)</option> : null}
            <option value="pool">{PLATFORM === 'baidu-zhidao' ? '采集池(检索到的问题)' : '采集池(去别人爆款下引流)'}</option>
          </select>
          <button type="button" className={c('btn')} disabled={notesBusy} onClick={() => void loadNotes(effectiveNoteSource)}>
            <Icon name={notesBusy ? 'spinner' : 'refresh'} size={12} /> {notesBusy ? '抓取中…' : '拉取/刷新'}
          </button>
        </div>
        {noteOptions.length > 0 ? (
          <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--od-border, #e5ded4)', borderRadius: 8, padding: 4, marginTop: 6 }}>
            {noteOptions.map((o) => (
              <button
                key={o.url}
                type="button"
                className={c('btn')}
                style={{ display: 'flex', width: '100%', textAlign: 'left', justifyContent: 'space-between', gap: 8, marginBottom: 2, background: note === o.url ? 'rgba(232,88,46,0.12)' : undefined }}
                onClick={() => setNote(o.url)}
                title={o.url}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{note === o.url ? '✓ ' : ''}{o.title || '(无标题)'}</span>
                {o.meta ? <span className={c('cardHint')} style={{ flex: '0 0 auto' }}>{o.meta}</span> : null}
              </button>
            ))}
          </div>
        ) : (
          <div className={c('cardHint')} style={{ marginTop: 6 }}>点「拉取/刷新」加载{effectiveNoteSource === 'mine' ? '你的已发笔记' : PLATFORM === 'baidu-zhidao' ? '采集池里的问题' : '采集池笔记'};也可在下面手动粘贴链接。</div>
        )}
        <div className={c('row')} style={{ marginTop: 6 }}>
          <input
            className={`${c('input')} ${c('grow')}`}
            value={note}
            placeholder={PLATFORM === 'baidu-zhidao' ? '或手动粘贴百度知道问题链接(zhidao.baidu.com/question/…)' : '或手动粘贴小红书笔记链接(带 xsec_token 的完整链接最稳)'}
            onChange={(e) => setNote(e.target.value)}
          />
          <button type="button" className={c('btn')} disabled={busy !== ''} onClick={() => void preview()}>
            {busy === 'preview' ? '读评论中…' : '预览命中'}
          </button>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={busy !== ''} onClick={() => void runLive()}>
            {busy === 'live' ? '发送中…' : '真发'}
          </button>
        </div>
        {result ? (
          result.needsLogin ? (
            <div className={c('cardHint')} style={{ color: '#b0342c', marginTop: 6 }}>未登录:去「账号」页登录{platformDef.label}后重试。</div>
          ) : (
            <div style={{ marginTop: 8 }}>
              <div className={c('cardHint')}>读到 {result.read} 条评论,命中 {result.matched.length} 条规则{result.dispatched.length ? `;已派发 ${result.dispatched.filter((d) => d.jobId).length} 条` : '(预览,未外发)'}</div>
              {result.matched.map((m, i) => {
                const d = result.dispatched.find((x) => x.commentId === m.commentId);
                const tag = d ? (d.jobId ? '已发' : `拦:${d.blocked}`) : '预览';
                return (
                  <div key={m.commentId + i} className={c('cardHint')} style={{ marginTop: 4 }}>
                    <b>[{tag}]</b> @{m.author}「{m.commentText.slice(0, 24)}」→ [{m.ruleName}] {m.reply}
                  </div>
                );
              })}
              {result.matched.length === 0 ? <div className={c('cardHint')} style={{ marginTop: 4 }}>没有评论命中规则——去下面加/调规则,或换条评论多的{noteNoun}。</div> : null}
            </div>
          )
        ) : null}
      </div>

      {/* ── 匹配规则维护 ── */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          🎯 匹配规则
          <span className={c('cardHint')}>评论命中关键词就按模板回复。占位符 {'{author}'}=评论者、{'{keyword}'}=命中的词。优先级高者先匹配。</span>
        </div>
        {rules.length === 0 ? <div className={c('cardHint')}>(还没有规则,下面加一条)</div> : null}
        {rules.map((r) => (
          <div key={r.id} className={c('row')} style={{ alignItems: 'center', gap: 8, padding: '4px 0', flexWrap: 'wrap' }}>
            <button type="button" className={c('btn')} title={r.enabled ? '点击停用' : '点击启用'} onClick={() => void toggleRule(r)}>
              {r.enabled ? '● 启用' : '○ 停用'}
            </button>
            <span style={{ fontSize: 13 }}><b>P{r.priority}</b> {r.name} · {r.matchMode}(<span style={{ opacity: 0.75 }}>{r.keywords.join(' / ')}</span>) → {r.replyTemplate} · {r.action}</span>
            <button type="button" className={c('btn')} onClick={() => void delRule(r.id)}><Icon name="close" size={12} /> 删</button>
          </div>
        ))}
        {/* 新增规则 */}
        <div style={{ marginTop: 10, paddingTop: 10, borderTop: '1px dashed var(--od-border, #e5ded4)' }}>
          <div className={c('row')} style={{ flexWrap: 'wrap', gap: 8 }}>
            <input className={c('input')} style={{ width: 130 }} value={rName} placeholder="规则名" onChange={(e) => setRName(e.target.value)} />
            <input className={`${c('input')} ${c('grow')}`} value={rKw} placeholder="关键词(逗号分隔),例:价格,多少钱,链接" onChange={(e) => setRKw(e.target.value)} />
            <select className={c('select')} value={rMode} onChange={(e) => setRMode(e.target.value as RuleMatchMode)}>
              <option value="contains">含关键词</option>
              <option value="exact">完全等于</option>
              <option value="regex">正则</option>
            </select>
          </div>
          <div className={c('row')} style={{ flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
            <input className={`${c('input')} ${c('grow')}`} value={rReply} placeholder="回复文案,可含 {author}/{keyword},例:@{author} 私信你啦～" onChange={(e) => setRReply(e.target.value)} />
            <select className={c('select')} value={rAction} onChange={(e) => setRAction(e.target.value as InteractionAction)}>
              <option value="reply">一级评论</option>
              <option value="sub-reply">楼中楼</option>
            </select>
            <input className={c('input')} style={{ width: 70 }} value={rPriority} placeholder="优先级" onChange={(e) => setRPriority(e.target.value.replace(/[^\d-]/g, ''))} />
            <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} onClick={() => void addRule()}>加规则</button>
          </div>
        </div>
      </div>
    </div>
  );
}
