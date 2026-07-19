// 「制作视频」一级入口(2026-07-17 用户拍板:横切素材车间,产出给各平台用)。
// 首个功能:数字人口型替换——上传原始视频 + 新音频(上传或 TTS 文案),调火山
// 智能视觉「视频改口型」把视频里人物口型替换成匹配新音频。
// 接口:daemon POST /api/media-studio/make-video/lipsync(提交)+ GET .../lipsync/:id
// (轮询)。火山侧要开通「智能视觉·视频改口型」并配 AK/SK,未配时 daemon 返回
// 明确指引,这里原样展示(不装死)。
import { useEffect, useRef, useState } from 'react';
import { studioToast } from './StudioFeedback';
import { StudioToastHost } from './StudioFeedback';
import styles from './MediaStudio.module.css';

/** 免 article 的素材上传(制作视频专用桶)。 */
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

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

/** 千问 TTS 基底音色(2026-07-19 逐个实测有效)。描述指令(音色描述)在此基础上塑形。 */
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

type LipsyncJob = { id: string; status: 'running' | 'done' | 'error'; resultUrl?: string; error?: string };

async function submitLipsync(videoUrl: string, audioUrl: string, provider: 'qwen' | 'volc'): Promise<{ id: string } | { error: string }> {
  try {
    const resp = await fetch('/api/media-studio/make-video/lipsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl, audioUrl, provider }),
    });
    const d = (await resp.json().catch(() => ({}))) as { id?: string; error?: string | { message?: string } };
    if (!resp.ok) {
      const msg = typeof d.error === 'string' ? d.error : d.error?.message;
      return { error: msg || `提交失败(${resp.status})` };
    }
    return { id: d.id ?? '' };
  } catch {
    return { error: '连不上本地服务(daemon)' };
  }
}

async function queryLipsync(id: string): Promise<LipsyncJob | null> {
  try {
    const resp = await fetch(`/api/media-studio/make-video/lipsync/${encodeURIComponent(id)}`);
    if (!resp.ok) return null;
    return (await resp.json()) as LipsyncJob;
  } catch {
    return null;
  }
}

export function MakeVideoView(): JSX.Element {
  const [videoUrl, setVideoUrl] = useState('');
  const [videoName, setVideoName] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [audioName, setAudioName] = useState('');
  const [busy, setBusy] = useState<'video' | 'audio' | 'submit' | null>(null);
  const [job, setJob] = useState<LipsyncJob | null>(null);
  // 音色设计(2026-07-19 用户拍板):描述→设计→试听。qwen=千问指令音色(即设即听);
  // volc=火山 voice_design(出可复用 speaker_id,需语音Key+已购音色位)。
  const [vdProvider, setVdProvider] = useState<'qwen' | 'volc'>('qwen');
  const [vdPrompt, setVdPrompt] = useState('');
  const [vdText, setVdText] = useState('大家好,今天给大家带来一款超实用的好物,用过的都说回不去了。');
  const [vdVoice, setVdVoice] = useState('');
  const [vdBusy, setVdBusy] = useState(false);
  const [vdResult, setVdResult] = useState<{ provider: string; audioUrl: string; speakerId?: string; voice?: string; prompt?: string } | null>(null);
  // 口型替换通道(2026-07-19 实测):千问 videoretalk=真人素材直接可用+30-45s 出片+
  // 原片只改口型(默认);火山 Seedance=生成式重绘(虚拟形象/延展场景,真人需授权登记)。
  const [lipProvider, setLipProvider] = useState<'qwen' | 'volc'>('qwen');

  async function runVoiceDesign() {
    if (!vdPrompt.trim()) { studioToast.err('先写音色描述(如:年轻女性,声音温柔,语速中等)'); return; }
    setVdBusy(true); setVdResult(null);
    try {
      const resp = await fetch('/api/media-studio/voice-design', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: vdProvider, prompt: vdPrompt.trim(), text: vdText.trim(), ...(vdVoice.trim() ? { voice: vdVoice.trim() } : {}) }),
      });
      const d = (await resp.json().catch(() => ({}))) as { audioUrl?: string; provider?: string; speakerId?: string; voice?: string; prompt?: string; error?: string };
      if (!resp.ok || !d.audioUrl) { studioToast.err(d.error || `音色设计失败(${resp.status})`); return; }
      setVdResult({ provider: d.provider || vdProvider, audioUrl: d.audioUrl, ...(d.speakerId ? { speakerId: d.speakerId } : {}), ...(d.voice ? { voice: d.voice } : {}), ...(d.prompt ? { prompt: d.prompt } : {}) });
      studioToast.ok('音色已生成——点下方播放试听');
    } finally {
      setVdBusy(false);
    }
  }
  const videoInputRef = useRef<HTMLInputElement | null>(null);
  const audioInputRef = useRef<HTMLInputElement | null>(null);
  const pollRef = useRef<number | null>(null);

  // 任务轮询:running 时每 5s 查一次,终态停。
  useEffect(() => {
    if (!job || job.status !== 'running') return;
    pollRef.current = window.setInterval(() => {
      void queryLipsync(job.id).then((j) => {
        if (!j) return;
        setJob(j);
        if (j.status === 'done') studioToast.ok('口型替换完成!下面可预览/下载成片。');
        if (j.status === 'error') studioToast.err(`口型替换失败:${j.error ?? '未知错误'}`);
      });
    }, 5000);
    return () => {
      if (pollRef.current != null) window.clearInterval(pollRef.current);
    };
  }, [job?.id, job?.status]);

  async function pickVideo(file: File) {
    setBusy('video');
    const r = await uploadMakeFile(file);
    setBusy(null);
    if (r.error || !r.url) {
      studioToast.err(r.error ?? '上传失败');
      return;
    }
    setVideoUrl(r.url);
    setVideoName(file.name);
  }

  async function pickAudio(file: File) {
    setBusy('audio');
    const r = await uploadMakeFile(file);
    setBusy(null);
    if (r.error || !r.url) {
      studioToast.err(r.error ?? '上传失败');
      return;
    }
    setAudioUrl(r.url);
    setAudioName(file.name);
  }

  async function submit() {
    if (!videoUrl) {
      studioToast.info('先上传原始视频');
      return;
    }
    if (!audioUrl) {
      studioToast.info('再上传要替换的新音频(口播)');
      return;
    }
    setBusy('submit');
    const r = await submitLipsync(videoUrl, audioUrl, lipProvider);
    setBusy(null);
    if ('error' in r) {
      studioToast.err(r.error);
      return;
    }
    setJob({ id: r.id, status: 'running' });
    studioToast.ok(lipProvider === 'qwen' ? '已提交口型替换任务,处理中…(千问通道通常 1 分钟内出片)' : '已提交口型替换任务,处理中…(Seedance 通常 4-6 分钟)');
  }

  return (
    <div className={c('root')}>
      <StudioToastHost />
      <div className={c('head')}>
        <h1 className={c('title')}>制作视频</h1>
        <span className={c('cardHint')}>素材车间——做好的成片到各平台入口发布</span>
      </div>

      <div className={c('card')}>
        <div className={c('cardLabel')}>
          音色设计
          <span className={c('cardHint')}>用一句话描述你想要的声音,AI 设计音色并生成试听——满意后配音/口播都用这个声音</span>
        </div>
        <div className={c('row')} style={{ gap: 8, marginBottom: 8 }}>
          {([['qwen', '千问 · 即设即听'], ['volc', '火山 · 音色位(出 speaker_id)']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`${c('btn')} ${vdProvider === id ? c('btnPrimary') : ''}`}
              onClick={() => setVdProvider(id)}
            >
              {label}
            </button>
          ))}
        </div>
        <input
          className={c('input')}
          style={{ marginBottom: 8 }}
          placeholder="音色描述,例:年轻女性,声音温柔有亲和力,语速中等偏慢,像闺蜜聊天"
          value={vdPrompt}
          onChange={(e) => setVdPrompt(e.target.value)}
        />
        <textarea
          className={c('textarea')}
          style={{ marginBottom: 8, minHeight: 64 }}
          placeholder="口播文案——生成的音频可直接「用作口播音频」去做口型替换;先短句试听音色,满意后粘完整文案重新生成"
          value={vdText}
          onChange={(e) => setVdText(e.target.value)}
        />
        {vdProvider === 'volc' ? (
          <input
            className={c('input')}
            style={{ marginBottom: 8 }}
            placeholder="已购音色位 speaker_id(S_ 开头)——火山语音控制台购买"
            value={vdVoice}
            onChange={(e) => setVdVoice(e.target.value)}
          />
        ) : (
          <select
            className={c('select')}
            style={{ marginBottom: 8 }}
            title="基底音色(实测全部可用)——音色描述在此基础上塑形"
            value={vdVoice}
            onChange={(e) => setVdVoice(e.target.value)}
          >
            {QWEN_VOICES.map((v) => (
              <option key={v.id} value={v.id === 'Ethan' ? '' : v.id}>
                {v.label}
              </option>
            ))}
          </select>
        )}
        <div className={c('row')} style={{ gap: 8, alignItems: 'center' }}>
          <button type="button" className={`${c('btn')} ${c('btnPrimary')}`} disabled={vdBusy} onClick={() => void runVoiceDesign()}>
            {vdBusy ? '设计中…' : '🎙 设计并试听'}
          </button>
          {vdResult ? (
            <>
              <audio controls src={vdResult.audioUrl} style={{ height: 32 }} />
              <button
                type="button"
                className={c('btn')}
                title="存为音色预设——各平台「配音」步即可选用这个声音"
                onClick={() => {
                  void (async () => {
                    const resp = await fetch('/api/media-studio/voice-presets', {
                      method: 'POST',
                      headers: { 'Content-Type': 'application/json' },
                      body: JSON.stringify({ name: vdPrompt.trim().slice(0, 12), provider: vdResult.provider, ...(vdResult.voice ? { voice: vdResult.voice } : {}), ...(vdResult.prompt ? { prompt: vdResult.prompt } : {}), ...(vdResult.speakerId ? { speakerId: vdResult.speakerId } : {}) }),
                    });
                    if (resp.ok) studioToast.ok('已存为音色预设——去平台「配音」步选用');
                    else studioToast.err('保存失败');
                  })();
                }}
              >
                💾 保存音色
              </button>
              <button
                type="button"
                className={c('btn')}
                title="把这条生成的音频直接填进下方「口型替换」的新口播音频——一条龙出片"
                onClick={() => {
                  setAudioUrl(vdResult.audioUrl);
                  setAudioName('音色设计生成的口播音频');
                  studioToast.ok('已填入下方口型替换的②新口播音频——传原始视频后点「开始口型替换」');
                }}
              >
                🎬 用作口播音频
              </button>
              {vdResult.speakerId ? <span className={c('cardHint')}>音色位:{vdResult.speakerId}</span> : null}
            </>
          ) : null}
        </div>
      </div>

      <div className={c('card')}>
        <div className={c('cardLabel')}>
          数字人 · 口型替换
          <span className={c('cardHint')}>原始视频 + 新口播音频 → AI 把视频里的口型替换成匹配新音频。千问通道:真人素材直接可用,约 1 分钟出片,原片只改口型(推荐);火山 Seedance:生成式重绘(真人需控制台授权登记)</span>
        </div>
        <div className={c('row')} style={{ gap: 8, marginBottom: 8 }}>
          {([['qwen', '千问 · 真人可用·快(推荐)'], ['volc', '火山 Seedance · 生成式']] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              className={`${c('btn')} ${lipProvider === id ? c('btnPrimary') : ''}`}
              onClick={() => setLipProvider(id)}
            >
              {label}
            </button>
          ))}
        </div>

        <div className={c('row')} style={{ gap: 12, flexWrap: 'wrap' }}>
          <input
            ref={videoInputRef}
            type="file"
            accept="video/mp4,video/quicktime"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickVideo(f);
              e.currentTarget.value = '';
            }}
          />
          <button type="button" className={c('btn')} disabled={busy === 'video'} onClick={() => videoInputRef.current?.click()}>
            {busy === 'video' ? '上传中…' : videoName ? `✓ ${videoName.slice(0, 24)}(换)` : '① 上传原始视频'}
          </button>

          <input
            ref={audioInputRef}
            type="file"
            accept="audio/mpeg,audio/wav,audio/mp4,audio/x-m4a"
            style={{ display: 'none' }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void pickAudio(f);
              e.currentTarget.value = '';
            }}
          />
          <button type="button" className={c('btn')} disabled={busy === 'audio'} onClick={() => audioInputRef.current?.click()}>
            {busy === 'audio' ? '上传中…' : audioName ? `✓ ${audioName.slice(0, 24)}(换)` : '② 上传新口播音频'}
          </button>

          <button
            type="button"
            className={`${c('btn')} ${c('btnPrimary')}`}
            disabled={busy != null || (job?.status === 'running')}
            onClick={() => void submit()}
          >
            {job?.status === 'running' ? '处理中…' : busy === 'submit' ? '提交中…' : '③ 开始口型替换'}
          </button>
        </div>

        <div className={c('cardHint')} style={{ marginTop: 6 }}>
          提示:新音频可以先在任一平台入口的「配音」步用文案合成(火山 TTS),下载后传到这里。
          原视频要有清晰正面人脸,口型区域不被遮挡。
        </div>

        {job?.status === 'running' ? (
          <div className={c('cardHint')} style={{ marginTop: 10 }}>⏳ 任务处理中(每 5 秒自动查询)…任务号 {job.id}</div>
        ) : null}
        {job?.status === 'error' ? (
          <div className={c('cardHint')} style={{ marginTop: 10, color: '#b0342c' }}>❌ {job.error}</div>
        ) : null}
        {job?.status === 'done' && job.resultUrl ? (
          <div style={{ marginTop: 12 }}>
            <video src={job.resultUrl} controls playsInline style={{ maxWidth: 480, width: '100%', borderRadius: 10, background: '#000' }} />
            <div className={c('row')} style={{ marginTop: 8 }}>
              <a className={c('btn')} href={job.resultUrl} download>
                下载成片
              </a>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
