/**
 * 火山（豆包）TTS 配音 — deterministic runner around the workbench script
 * `MY-voice-clone/scripts/volc_tts.py`（WebSocket 双向流式协议留在 Python，
 * daemon 只负责用工作台 .venv 起进程并收 wav）。
 *
 * Keys come from the shared studio key resolver（VOLC_TTS_API_KEY 等，
 * 插件配置优先、工作台 .env 兜底）。
 */
import { spawn } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MEDIA_WORKBENCH = path.join(
  process.env.OD_WORKBENCH_DIR || path.join(os.homedir(), '.open-design', 'workbenches'),
  '多媒体自动发布',
);
const TTS_SCRIPT = path.join(MEDIA_WORKBENCH, '.claude', 'skills', 'MY-voice-clone', 'scripts', 'volc_tts.py');
const VENV_PY = path.join(MEDIA_WORKBENCH, '.venv', 'bin', 'python3');

/** 项目默认复刻音色（解说1号）。可被请求里的 voice 覆盖。 */
export const DEFAULT_TTS_VOICE = 'S_M46v4EJ42';

export class TtsError extends Error {}

export interface TtsInput {
  text: string;
  voice?: string;
  outFile: string;
  /** Studio key env（含 VOLC_TTS_*）merged over process.env. */
  env: Record<string, string>;
}

export async function synthesizeVoice(input: TtsInput): Promise<string> {
  try {
    await access(TTS_SCRIPT);
    await access(VENV_PY);
  } catch {
    throw new TtsError(`没找到配音脚本或工作台 venv（${TTS_SCRIPT}）——确认「多媒体自动发布」工作台完整`);
  }
  const text = input.text.trim();
  if (!text) throw new TtsError('配音文本为空');
  // 长文本经临时文件传（避免 argv 长度/引号问题）。
  const textFile = path.join(os.tmpdir(), `studio-tts-${Date.now()}.md`);
  await writeFile(textFile, text, 'utf8');

  const args = [
    TTS_SCRIPT, 'synthesize',
    '--voice', input.voice?.trim() || DEFAULT_TTS_VOICE,
    '--text-file', textFile,
    '--output', input.outFile,
  ];
  return new Promise((resolve, reject) => {
    const child = spawn(VENV_PY, args, {
      cwd: MEDIA_WORKBENCH,
      env: { ...process.env, ...input.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new TtsError('配音合成超时（180s）'));
    }, 180_000);
    child.stdout.on('data', (c) => { out += String(c); });
    child.stderr.on('data', (c) => { out += String(c); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new TtsError(`配音脚本启动失败: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(input.outFile);
      else reject(new TtsError(`配音失败（exit ${code}）: ${out.trim().slice(-400) || '无输出'}（检查 VOLC_TTS_API_KEY）`));
    });
  });
}

/** 口播稿 markdown → 可朗读纯文本：剥标注/标题符号/图片/链接。 */
export function scriptToSpeech(md: string): string {
  return md
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[->*]\s+/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\n{2,}/g, '\n')
    .trim();
}
