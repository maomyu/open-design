// 「制作视频」素材车间(2026-07-19 按用户拍板重构:按真实创作流程三步走 + 成片库)。
// ① 准备口播音频(AI 生成[音色设计整合]/上传现成音频)→ ② 上传原始视频 → ③ 出片
// (千问 videoretalk 默认:真人可用、约 1 分钟、原片只改口型;火山 Seedance 生成式备选)
// → 成片库(持久:daemon 落盘任务与成片,切页/重启不丢;内嵌播放/下载/删除)。
// 素材选择 localStorage 暂存,切页回来还在。
import { useCallback, useEffect, useRef, useState } from 'react';
import { studioToast } from './StudioFeedback';
import { StudioToastHost } from './StudioFeedback';
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

  // ---- ① 口播音频:AI 生成(音色设计) / 上传 ----
  const [audioTab, setAudioTab] = useState<'ai' | 'upload'>('ai');
  const [vdProvider, setVdProvider] = useState<'qwen' | 'volc'>('qwen');
  const [vdPrompt, setVdPrompt] = useState('');
  const [vdText, setVdText] = useState('');
  const [vdVoice, setVdVoice] = useState('');
  const [vdBusy, setVdBusy] = useState(false);
  const [vdResult, setVdResult] = useState<{ provider: string; audioUrl: string; speakerId?: string; voice?: string; prompt?: string } | null>(null);

  async function runVoiceDesign() {
    if (!vdText.trim()) { studioToast.err('先写口播文案'); return; }
    if (vdProvider === 'volc' && !vdPrompt.trim()) { studioToast.err('火山通道需要音色描述(voice_design 靠它出声线)'); return; }
    setVdBusy(true); setVdResult(null);
    try {
      const resp = await fetch('/api/media-studio/voice-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: vdProvider, ...(vdProvider === 'volc' ? { prompt: vdPrompt.trim() } : {}), text: vdText.trim(), ...(vdVoice.trim() ? { voice: vdVoice.trim() } : {}) }),
      });
      const d = (await resp.json().catch(() => ({}))) as { audioUrl?: string; provider?: string; speakerId?: string; voice?: string; prompt?: string; error?: string };
      if (!resp.ok || !d.audioUrl) { studioToast.err(d.error || `生成失败(${resp.status})`); return; }
      setVdResult({ provider: d.provider || vdProvider, audioUrl: d.audioUrl, ...(d.speakerId ? { speakerId: d.speakerId } : {}), ...(d.voice ? { voice: d.voice } : {}), ...(d.prompt ? { prompt: d.prompt } : {}) });
      // 生成即设为当前口播音频(用户拍板:生成的音频直接作为口播用)。
      setAudioUrl(d.audioUrl);
      const voiceLabel = QWEN_VOICES.find((v) => v.id === (d.voice || 'Ethan'))?.label.split(' ')[0] ?? d.voice ?? '';
      setAudioName(`AI 生成 · ${voiceLabel}${vdText.trim().slice(0, 10)}…`);
      studioToast.ok('口播音频已生成并选用——试听满意后传原始视频出片');
    } finally {
      setVdBusy(false);
    }
  }

  // ---- 成片库(持久,daemon 落盘) ----
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

  // running 任务轮询(查询端点会把终态落盘),每 6s 刷一轮。
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

  // ---- ③ 出片 ----
  const [lipProvider, setLipProvider] = useState<'qwen' | 'volc'>('qwen');
  async function startLipsync() {
    if (!videoUrl) { studioToast.info('先在②上传原始视频'); return; }
    if (!audioUrl) { studioToast.info('先在①准备口播音频(AI 生成或上传)'); return; }
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
      studioToast.ok(lipProvider === 'qwen' ? '已提交——千问通道通常 1 分钟内出片,完成后出现在下方成片库' : '已提交——Seedance 通常 4-6 分钟,完成后出现在下方成片库');
      void refreshJobs();
    } finally {
      setBusy(null);
    }
  }

  const runningJob = jobs.find((j) => j.status === 'running');

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>制作视频</h1>
        <span className={c('cardHint')}>数字人口播三步走:① 口播音频 → ② 原始视频 → ③ 出片;成片沉淀在下方成片库</span>
      </div>

      {/* ① 口播音频 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          ① 口播音频
          <span className={c('cardHint')}>AI 生成(写文案选声音)或上传现成音频;成片时长跟着音频走</span>
        </div>
        <div className={c('row')} style={{ gap: 8, marginBottom: 8 }}>
          {([['ai', '🎙 AI 生成'], ['upload', '⬆ 上传音频']] as const).map(([id, label]) => (
            <button key={id} type="button" className={`${c('btn')} ${audioTab === id ? c('btnPrimary') : ''}`} onClick={() => setAudioTab(id)}>
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
        {audioTab === 'ai' ? (
          <>
            <div className={c('row')} style={{ gap: 8, marginBottom: 8 }}>
              {([['qwen', '千问 · 即设即听'], ['volc', '火山 · 音色位(出 speaker_id)']] as const).map(([id, label]) => (
                <button key={id} type="button" className={`${c('btn')} ${vdProvider === id ? c('btnPrimary') : ''}`} onClick={() => setVdProvider(id)}>
                  {label}
                </button>
              ))}
            </div>
            <textarea
              className={c('textarea')}
              style={{ marginBottom: 8, minHeight: 64 }}
              placeholder="口播文案——生成的音频自动成为当前口播音频;先短句试音色,满意后粘完整文案重新生成"
              value={vdText}
              onChange={(e) => setVdText(e.target.value)}
            />
            {vdProvider === 'volc' ? (
              <>
                <input
                  className={c('input')}
                  style={{ marginBottom: 8 }}
                  placeholder="音色描述(必填)——例:年轻女性,声音温柔有亲和力,语速中等偏慢"
                  value={vdPrompt}
                  onChange={(e) => setVdPrompt(e.target.value)}
                />
                <input
                  className={c('input')}
                  style={{ marginBottom: 8 }}
                  placeholder="已购音色位 speaker_id(S_ 开头)——火山语音控制台购买"
                  value={vdVoice}
                  onChange={(e) => setVdVoice(e.target.value)}
                />
              </>
            ) : (
              <select
                className={c('select')}
                style={{ marginBottom: 8 }}
                title="基底音色(实测全部可用)"
                value={vdVoice}
                onChange={(e) => setVdVoice(e.target.value)}
              >
                {QWEN_VOICES.map((v) => (
                  <option key={v.id} value={v.id === 'Ethan' ? '' : v.id}>{v.label}</option>
                ))}
              </select>
            )}
            <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
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
                        body: JSON.stringify({ name: (vdPrompt.trim() || vdResult.voice || 'Ethan').slice(0, 12), provider: vdResult.provider, ...(vdResult.voice ? { voice: vdResult.voice } : {}), ...(vdResult.prompt ? { prompt: vdResult.prompt } : {}), ...(vdResult.speakerId ? { speakerId: vdResult.speakerId } : {}) }),
                      });
                      if (resp.ok) studioToast.ok('已存为音色预设');
                      else studioToast.err('保存失败');
                    })();
                  }}
                >
                  💾 保存音色
                </button>
              ) : null}
              {vdResult?.speakerId ? <span className={c('cardHint')}>音色位:{vdResult.speakerId}</span> : null}
            </div>
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

      {/* ② 原始视频 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          ② 原始视频
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

      {/* ③ 出片 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          ③ 出片
          <span className={c('cardHint')}>千问:真人素材直接可用,约 1 分钟,原片只改口型(推荐);火山 Seedance:生成式重绘(真人需控制台授权登记)</span>
        </div>
        <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
          {([['qwen', '千问 · 真人可用·快(推荐)'], ['volc', '火山 Seedance · 生成式']] as const).map(([id, label]) => (
            <button key={id} type="button" className={`${c('btn')} ${lipProvider === id ? c('btnPrimary') : ''}`} onClick={() => setLipProvider(id)}>
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
          {runningJob ? <span className={c('cardHint')}>有任务生成中…完成后自动出现在成片库</span> : null}
        </div>
      </div>

      {/* 成片库 */}
      <div className={c('card')}>
        <div className={c('cardLabel')}>
          成片库({jobs.length})
          <span className={c('cardHint')}>所有成片留存在本机——切页/重启都不丢;点视频直接播,可下载/删除</span>
        </div>
        {jobs.length === 0 ? (
          <div className={c('cardHint')}>还没有成片——完成上面三步,成片会自动出现在这里。</div>
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
    </div>
  );
}
