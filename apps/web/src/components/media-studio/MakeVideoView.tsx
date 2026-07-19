// 「制作视频」素材车间(2026-07-19 二次重构:对齐创作页的分步骤导航)。
// 步骤条 1 口播音频 → 2 原始视频 → 3 出片(+独立「成片库」tab,同创作页「笔记」位)。
// 每步完成态打勾,步内就绪显示 NextStepBar 引导;出片提交后自动跳成片库看进度。
// 口播音频仅千问 TTS(2026-07-19 用户拍板);出片默认千问 videoretalk(真人可用/快),
// 火山 Seedance 生成式备选。任务与成片 daemon 落盘持久,素材选择 localStorage 暂存。
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioToast } from './StudioFeedback';
import { NextStepBar, StudioToastHost } from './StudioFeedback';
import { Icon } from '../Icon';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 千问 TTS 基底音色(2026-07-19 逐个实测有效)。 */
const QWEN_VOICES: Array<{ id: string; label: string }> = [
  { id: 'Ethan', label: 'Ethan 晨煦 · 男声阳光(默认)' },
  { id: 'Cherry', label: 'Cherry 芊悦 · 女声亲切' },
  { id: 'Serena', label: 'Serena 苏瑶 · 女声温柔' },
  { id: 'Chelsie', label: 'Chelsie 千雪 · 女声清甜' },
  { id: 'Katerina', label: 'Katerina 卡捷琳娜 · 女声御姐' },
  { id: 'Elias', label: 'Elias 墨讲师 · 男声讲解' },
  { id: 'Ryan', label: 'Ryan 甜茶 · 男声活力' },
  { id: 'Nofish', label: 'Nofish 不吃鱼 · 男声特色' },
  { id: 'Jennifer', label: 'Jennifer · 女声英文' },
  { id: 'Marcus', label: 'Marcus · 男声英文' },
  { id: 'Roy', label: 'Roy · 男声' },
  { id: 'Peter', label: 'Peter 李彼得 · 天津话' },
  { id: 'Dylan', label: 'Dylan 晓东 · 北京话' },
  { id: 'Jada', label: 'Jada 阿珍 · 上海话' },
  { id: 'Sunny', label: 'Sunny 晴儿 · 四川话' },
  { id: 'Li', label: 'Li 老李 · 南京话' },
  { id: 'Eric', label: 'Eric · 四川风味' },
  { id: 'Rocky', label: 'Rocky · 男声特色' },
  { id: 'Kiki', label: 'Kiki · 女声特色' },
];

const STASH_KEY = 'open-design:make-video:stash';

type MakeTab = 'audio' | 'video' | 'render' | 'library';

interface LipJob {
  id: string;
  provider: 'qwen' | 'volc';
  status: 'running' | 'done' | 'error';
  localUrl?: string;
  error?: string;
  createdAt: number;
  audioName?: string;
  videoName?: string;
}

async function uploadMakeFile(file: File): Promise<{ url?: string; error?: string }> {
  try {
    const resp = await fetch('/api/media-studio/make-video/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', 'x-file-name': encodeURIComponent(file.name) },
      body: file,
    });
    const d = (await resp.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!resp.ok) return { error: d.error ?? `上传失败(${resp.status})` };
    return d;
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

export function MakeVideoView(): JSX.Element {
  const [tab, setTab] = useState<MakeTab>('audio');

  // ---- 素材(localStorage 暂存,切页不丢) ----
  const [videoUrl, setVideoUrl] = useState('');
  const [videoName, setVideoName] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioName, setAudioName] = useState('');
  const [busy, setBusy] = useState<'video' | 'audio' | 'submit' | null>(null);
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    try {
      const raw = window.localStorage.getItem(STASH_KEY);
      if (raw) {
        const s = JSON.parse(raw) as { videoUrl?: string; videoName?: string; audioUrl?: string; audioName?: string };
        if (s.videoUrl) { setVideoUrl(s.videoUrl); setVideoName(s.videoName ?? ''); }
        if (s.audioUrl) { setAudioUrl(s.audioUrl); setAudioName(s.audioName ?? ''); }
      }
    } catch { /* ignore */ }
  }, []);
  useEffect(() => {
    try {
      window.localStorage.setItem(STASH_KEY, JSON.stringify({ videoUrl, videoName, audioUrl, audioName }));
    } catch { /* ignore */ }
  }, [videoUrl, videoName, audioUrl, audioName]);

  // ---- 1 口播音频(仅千问) ----
  const [audioSrcTab, setAudioSrcTab] = useState<'ai' | 'upload'>('ai');
  const [vdText, setVdText] = useState('');
  const [vdVoice, setVdVoice] = useState('');
  const [vdBusy, setVdBusy] = useState(false);
  const [vdResult, setVdResult] = useState<{ audioUrl: string; voice?: string } | null>(null);
  // 复刻音色(2026-07-19 用户拍板):上传自己的声音→cosyvoice 复刻→存预设长期复用。
  const [clonedVoices, setClonedVoices] = useState<Array<{ id: string; name: string; voice: string }>>([]);
  const [cloneOpen, setCloneOpen] = useState(false);
  const [cloneName, setCloneName] = useState('');
  const [cloneBusy, setCloneBusy] = useState(false);
  const cloneFileRef = useRef<HTMLInputElement | null>(null);
  const refreshClonedVoices = useCallback(async () => {
    try {
      const r = await fetch('/api/media-studio/voice-presets');
      if (!r.ok) return;
      const d = (await r.json()) as { presets?: Array<{ id: string; name: string; provider: string; voice?: string }> };
      setClonedVoices((d.presets ?? [])
        .filter((p) => p.provider === 'qwen' && (p.voice ?? '').startsWith('cosyvoice-'))
        .map((p) => ({ id: p.id, name: p.name, voice: p.voice! })));
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refreshClonedVoices(); }, [refreshClonedVoices]);

  async function runVoiceClone(file: File) {
    setCloneBusy(true);
    try {
      const up = await uploadMakeFile(file);
      if (!up.url) { studioToast.err(up.error || '样本上传失败'); return; }
      const resp = await fetch('/api/media-studio/voice-clone', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audioUrl: up.url, name: cloneName.trim() || file.name.replace(/\.\w+$/, '') }),
      });
      const d = (await resp.json().catch(() => ({}))) as { voiceId?: string; error?: string };
      if (!resp.ok || !d.voiceId) { studioToast.err(d.error || `复刻失败(${resp.status})`); return; }
      await refreshClonedVoices();
      setVdVoice(d.voiceId);
      setCloneOpen(false);
      studioToast.ok('音色复刻成功——已选中,写文案生成口播试听');
    } finally {
      setCloneBusy(false);
    }
  }

  async function runVoiceDesign() {
    if (!vdText.trim()) { studioToast.err('先写口播文案'); return; }
    setVdBusy(true); setVdResult(null);
    try {
      const resp = await fetch('/api/media-studio/voice-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: 'qwen', text: vdText.trim(), ...(vdVoice.trim() ? { voice: vdVoice.trim() } : {}) }),
      });
      const d = (await resp.json().catch(() => ({}))) as { audioUrl?: string; voice?: string; error?: string };
      if (!resp.ok || !d.audioUrl) { studioToast.err(d.error || `生成失败(${resp.status})`); return; }
      setVdResult({ audioUrl: d.audioUrl, ...(d.voice ? { voice: d.voice } : {}) });
      setAudioUrl(d.audioUrl);
      const voiceLabel = QWEN_VOICES.find((v) => v.id === (d.voice || 'Ethan'))?.label.split(' ')[0] ?? d.voice ?? '';
      setAudioName(`AI 生成 · ${voiceLabel} ${vdText.trim().slice(0, 10)}…`);
      studioToast.ok('口播音频已生成并选用');
    } finally {
      setVdBusy(false);
    }
  }

  // ---- 成片库(daemon 落盘持久) ----
  const [jobs, setJobs] = useState<LipJob[]>([]);
  const refreshJobs = useCallback(async () => {
    try {
      const r = await fetch('/api/media-studio/make-video/jobs');
      if (!r.ok) return;
      const d = (await r.json()) as { jobs?: LipJob[] };
      setJobs(d.jobs ?? []);
    } catch { /* ignore */ }
  }, []);
  useEffect(() => { void refreshJobs(); }, [refreshJobs]);
  useEffect(() => {
    if (!jobs.some((j) => j.status === 'running')) return;
    const t = window.setInterval(() => {
      void (async () => {
        for (const j of jobs.filter((x) => x.status === 'running')) {
          try { await fetch(`/api/media-studio/make-video/lipsync/${encodeURIComponent(j.id)}`); } catch { /* ignore */ }
        }
        void refreshJobs();
      })();
    }, 6000);
    return () => window.clearInterval(t);
  }, [jobs, refreshJobs]);

  // ---- 3 出片 ----
  const [lipProvider, setLipProvider] = useState<'qwen' | 'volc'>('qwen');
  async function startLipsync() {
    if (!audioUrl) { studioToast.info('先完成「1 口播音频」'); setTab('audio'); return; }
    if (!videoUrl) { studioToast.info('先完成「2 原始视频」'); setTab('video'); return; }
    setBusy('submit');
    try {
      const resp = await fetch('/api/media-studio/make-video/lipsync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ videoUrl, audioUrl, provider: lipProvider, audioName, videoName }),
      });
      const d = (await resp.json().catch(() => ({}))) as { id?: string; error?: string | { message?: string } };
      if (!resp.ok) {
        const msg = typeof d.error === 'string' ? d.error : d.error?.message;
        studioToast.err(msg || `提交失败(${resp.status})`);
        return;
      }
      studioToast.ok('已提交——去成片库看进度,完成自动出现');
      void refreshJobs();
      setTab('library');
    } finally {
      setBusy(null);
    }
  }

  const stepDone: Record<Exclude<MakeTab, 'library'>, boolean> = {
    audio: Boolean(audioUrl),
    video: Boolean(videoUrl),
    render: jobs.some((j) => j.status === 'done'),
  };
  const TABS: Array<{ id: Exclude<MakeTab, 'library'>; label: string; step: string }> = [
    { id: 'audio', label: '口播音频', step: '1' },
    { id: 'video', label: '原始视频', step: '2' },
    { id: 'render', label: '出片', step: '3' },
  ];
  const runningCount = jobs.filter((j) => j.status === 'running').length;

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>制作视频</h1>
        <span className={c('cardHint')}>数字人口播:写文案出声音 → 传原片 → 出片;成片沉淀在成片库</span>
      </div>

      <div className={c('tabs')} role="tablist" aria-label="制作视频步骤导航">
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
          aria-selected={tab === 'library'}
          className={`${c('tab')}${tab === 'library' ? ` ${c('tabActive')}` : ''}`}
          onClick={() => setTab('library')}
        >
          成片库{jobs.length ? `(${jobs.length})` : ''}
          {runningCount ? <span className={c('cardHint')}> ⏳{runningCount}</span> : null}
        </button>
      </div>

      {/* 1 口播音频 */}
      {tab === 'audio' ? (
        <>
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              口播音频
              <span className={c('cardHint')}>AI 生成(写文案选声音,千问)或上传现成音频;成片时长跟着音频走</span>
            </div>
            <div className={c('row')} style={{ gap: 8, marginBottom: 10, alignItems: 'center' }}>
              {([['ai', '🎙 AI 生成'], ['upload', '⬆ 上传音频']] as const).map(([id, label]) => (
                <button
                  key={id}
                  type="button"
                  className={`${c('articleSwitchBtn')}${audioSrcTab === id ? ` ${c('articleSwitchBtnActive')}` : ''}`}
                  aria-pressed={audioSrcTab === id}
                  onClick={() => setAudioSrcTab(id)}
                >
                  {label}
                </button>
              ))}
              {audioUrl ? (
                <span className={c('cardHint')} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                  当前:✓ {audioName || '已选音频'}
                  {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
                  <audio controls src={audioUrl} style={{ height: 28 }} />
                  <button type="button" className={c('btn')} style={{ padding: '2px 6px', fontSize: 11 }} onClick={() => { setAudioUrl(''); setAudioName(''); }}>✕</button>
                </span>
              ) : null}
            </div>
            {audioSrcTab === 'ai' ? (
              <>
                <textarea
                  className={c('textarea')}
                  style={{ marginBottom: 8, minHeight: 72 }}
                  placeholder="口播文案——生成的音频自动成为当前口播音频;先短句试音色,满意后粘完整文案重新生成"
                  value={vdText}
                  onChange={(e) => setVdText(e.target.value)}
                />
                <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
                  <select
                    className={c('select')}
                    title="音色:🎤我的复刻音色 + 千问内置(逐个实测可用)"
                    value={vdVoice}
                    onChange={(e) => setVdVoice(e.target.value)}
                  >
                    {clonedVoices.map((v) => (
                      <option key={v.id} value={v.voice}>🎤 {v.name}(我的复刻)</option>
                    ))}
                    {QWEN_VOICES.map((v) => (
                      <option key={v.id} value={v.id === 'Ethan' ? '' : v.id}>{v.label}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className={c('btn')}
                    title="上传一段自己的声音(10 秒以上清晰人声),复刻出专属音色,长期复用"
                    onClick={() => setCloneOpen((v) => !v)}
                  >
                    ➕ 复刻我的声音
                  </button>
                  <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={vdBusy} onClick={() => void runVoiceDesign()}>
                    {vdBusy ? '生成中…' : '🎙 生成口播音频'}
                  </button>
                  {vdResult ? (
                    <button
                      type="button"
                      className={c('btn')}
                      title="存为音色预设——各平台「配音」步也能选用这个声音"
                      onClick={() => {
                        void (async () => {
                          const resp = await fetch('/api/media-studio/voice-presets', {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ name: (vdResult.voice || 'Ethan').slice(0, 12), provider: 'qwen', voice: vdResult.voice || 'Ethan' }),
                          });
                          if (resp.ok) studioToast.ok('已存为音色预设');
                          else studioToast.err('保存失败');
                        })();
                      }}
                    >
                      💾 保存音色
                    </button>
                  ) : null}
                </div>
                {cloneOpen ? (
                  <div className={c('card')} style={{ marginTop: 8, borderColor: '#e8582e' }}>
                    <div className={c('cardLabel')}>
                      复刻我的声音
                      <span className={c('cardHint')}>上传一段自己的录音(10 秒以上、清晰无杂音,正常语速说话),约半分钟出专属音色;复刻后长期保存在音色列表</span>
                    </div>
                    <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
                      <input
                        className={c('input')}
                        style={{ maxWidth: 220 }}
                        placeholder="音色名字(如:我的声音)"
                        value={cloneName}
                        onChange={(e) => setCloneName(e.target.value)}
                      />
                      <input
                        ref={cloneFileRef}
                        type="file"
                        accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
                        style={{ display: 'none' }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = '';
                          if (f) void runVoiceClone(f);
                        }}
                      />
                      <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={cloneBusy} onClick={() => cloneFileRef.current?.click()}>
                        {cloneBusy ? '复刻中…(约半分钟)' : '⬆ 选择录音并开始复刻'}
                      </button>
                    </div>
                  </div>
                ) : null}
              </>
            ) : (
              <div className={c('row')} style={{ gap: 8 }}>
                <input
                  ref={audioInputRef}
                  type="file"
                  accept="audio/mpeg,audio/wav,audio/mp4,.mp3,.wav,.m4a"
                  style={{ display: 'none' }}
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = '';
                    if (!f) return;
                    void (async () => {
                      setBusy('audio');
                      const r = await uploadMakeFile(f);
                      setBusy(null);
                      if (r.url) { setAudioUrl(r.url); setAudioName(f.name); studioToast.ok('音频已上传'); }
                      else studioToast.err(r.error || '上传失败');
                    })();
                  }}
                />
                <button type="button" className={c('btn')} disabled={busy === 'audio'} onClick={() => audioInputRef.current?.click()}>
                  {busy === 'audio' ? '上传中…' : '⬆ 选择音频文件(mp3/wav/m4a)'}
                </button>
              </div>
            )}
          </div>
          {stepDone.audio ? (
            <NextStepBar hint="口播音频就绪,下一步上传你拍好的原始视频" label="去原始视频" onGo={() => setTab('video')} />
          ) : null}
        </>
      ) : null}

      {/* 2 原始视频 */}
      {tab === 'video' ? (
        <>
          <div className={c('card')}>
            <div className={c('cardLabel')}>
              原始视频
              <span className={c('cardHint')}>你拍好的口播原片——时长不限:自动裁到音频长度;音频更长则自动延展/分段</span>
            </div>
            <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
              <input
                ref={videoInputRef}
                type="file"
                accept="video/mp4,video/quicktime"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (!f) return;
                  void (async () => {
                    setBusy('video');
                    const r = await uploadMakeFile(f);
                    setBusy(null);
                    if (r.url) { setVideoUrl(r.url); setVideoName(f.name); studioToast.ok('视频已上传'); }
                    else studioToast.err(r.error || '上传失败');
                  })();
                }}
              />
              <button type="button" className={c('btn')} disabled={busy === 'video'} onClick={() => videoInputRef.current?.click()}>
                {busy === 'video' ? '上传中…' : '⬆ 选择视频文件(mp4/mov)'}
              </button>
              {videoUrl ? (
                <span className={c('cardHint')}>
                  当前:✓ {videoName || '已选视频'}
                  <button type="button" className={c('btn')} style={{ padding: '2px 6px', fontSize: 11, marginLeft: 6 }} onClick={() => { setVideoUrl(''); setVideoName(''); }}>✕</button>
                </span>
              ) : null}
            </div>
          </div>
          {stepDone.video ? (
            <NextStepBar hint="原始视频就绪,去出片" label="去出片" onGo={() => setTab('render')} />
          ) : null}
        </>
      ) : null}

      {/* 3 出片 */}
      {tab === 'render' ? (
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            出片
            <span className={c('cardHint')}>千问:真人素材直接可用,约 1 分钟,原片只改口型(推荐);火山 Seedance:生成式重绘(真人需控制台授权登记)</span>
          </div>
          <div className={c('cardHint')} style={{ marginBottom: 8 }}>
            素材:{audioUrl ? `✓ ${audioName || '音频已选'}` : '✗ 音频未选'} · {videoUrl ? `✓ ${videoName || '视频已选'}` : '✗ 视频未选'}
          </div>
          <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
            {([['qwen', '千问 · 真人可用·快(推荐)'], ['volc', '火山 Seedance · 生成式']] as const).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`${c('articleSwitchBtn')}${lipProvider === id ? ` ${c('articleSwitchBtnActive')}` : ''}`}
                aria-pressed={lipProvider === id}
                onClick={() => setLipProvider(id)}
              >
                {label}
              </button>
            ))}
            <button
              type="button"
              className={`${c('btn')} ${c('btnPrimary')}`}
              disabled={busy === 'submit'}
              onClick={() => void startLipsync()}
            >
              {busy === 'submit' ? '提交中…' : '🎬 开始出片'}
            </button>
          </div>
        </div>
      ) : null}

      {/* 成片库 */}
      {tab === 'library' ? (
        <div className={c('card')}>
          <div className={c('cardLabel')}>
            成片库({jobs.length})
            <span className={c('cardHint')}>所有成片留存在本机——切页/重启都不丢;点视频直接播,可下载/删除</span>
          </div>
          {jobs.length === 0 ? (
            <div className={c('cardHint')}>还没有成片——完成 1→2→3 三步,成片会自动出现在这里。</div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 12 }}>
              {jobs.map((j) => (
                <div key={j.id} style={{ border: '1px solid rgba(0,0,0,0.08)', borderRadius: 10, padding: 10 }}>
                  {j.status === 'done' && j.localUrl ? (
                    // eslint-disable-next-line jsx-a11y/media-has-caption
                    <video src={j.localUrl} controls playsInline style={{ width: '100%', borderRadius: 8, background: '#000' }} />
                  ) : j.status === 'running' ? (
                    <div className={c('cardHint')} style={{ padding: '24px 0', textAlign: 'center' }}>⏳ 生成中…({j.provider === 'qwen' ? '千问,约 1 分钟' : 'Seedance,约 4-6 分钟'})</div>
                  ) : (
                    <div className={c('cardHint')} style={{ padding: '12px 0', color: '#b0342c' }}>✕ 失败:{(j.error || '未知错误').slice(0, 80)}</div>
                  )}
                  <div className={c('cardHint')} style={{ marginTop: 6 }}>
                    {new Date(j.createdAt).toLocaleString()} · {j.provider === 'qwen' ? '千问' : '火山'}
                    {j.audioName ? ` · ${j.audioName.slice(0, 16)}` : ''}
                  </div>
                  <div className={c('row')} style={{ gap: 6, marginTop: 6 }}>
                    {j.status === 'done' && j.localUrl ? (
                      <a className={c('btn')} style={{ textDecoration: 'none' }} href={j.localUrl} download={`口播成片-${new Date(j.createdAt).toISOString().slice(0, 10)}.mp4`}>
                        ⬇ 下载
                      </a>
                    ) : null}
                    <button
                      type="button"
                      className={c('btn')}
                      onClick={() => {
                        void (async () => {
                          await fetch(`/api/media-studio/make-video/jobs/${encodeURIComponent(j.id)}`, { method: 'DELETE' });
                          void refreshJobs();
                        })();
                      }}
                    >
                      删除
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      ) : null}
    </div>
  );
}
