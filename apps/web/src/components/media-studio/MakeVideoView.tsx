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

type LipsyncJob = { id: string; status: 'running' | 'done' | 'error'; resultUrl?: string; error?: string };

async function submitLipsync(videoUrl: string, audioUrl: string): Promise<{ id: string } | { error: string }> {
  try {
    const resp = await fetch('/api/media-studio/make-video/lipsync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ videoUrl, audioUrl }),
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
    const r = await submitLipsync(videoUrl, audioUrl);
    setBusy(null);
    if ('error' in r) {
      studioToast.err(r.error);
      return;
    }
    setJob({ id: r.id, status: 'running' });
    studioToast.ok('已提交口型替换任务,处理中…(通常 1-5 分钟,取决于视频时长)');
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
          数字人 · 口型替换
          <span className={c('cardHint')}>上传你拍好的原始视频 + 新口播音频,AI 把视频里的口型替换成匹配新音频(火山·视频改口型)</span>
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
