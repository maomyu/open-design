/**
 * social-auto-upload（sau）runner — deterministic wrappers around the
 * workbench CLI so 短视频创作台's publish step is product code:
 *
 *   sau <platform> check --account <name>
 *   sau <platform> login --account <name> --headed   （扫码,用户本机弹窗）
 *   sau <platform> upload-video --account <name> --file ... --title ... [...]
 *
 * Uploading is a REAL outward publish（对外动作）: routes must only call
 * uploadVideo after an explicit human confirmation in the UI（合规铁律）.
 */
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export const SAU_PLATFORMS = ['douyin', 'xiaohongshu', 'kuaishou', 'bilibili', 'tencent'] as const;

const SAU_WORKBENCH = path.join(
  process.env.OD_WORKBENCH_DIR || path.join(os.homedir(), '.open-design', 'workbenches'),
  'social-auto-upload',
);
const SAU_BIN = path.join(SAU_WORKBENCH, '.venv', 'bin', 'sau');

export class SauError extends Error {}

export async function sauAvailable(): Promise<boolean> {
  try {
    await access(SAU_BIN);
    return true;
  } catch {
    return false;
  }
}

interface SauRunResult {
  code: number;
  stdout: string;
  stderr: string;
}

function runSau(args: string[], timeoutMs: number): Promise<SauRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(SAU_BIN, args, {
      cwd: SAU_WORKBENCH,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new SauError(`sau ${args.slice(0, 2).join(' ')} 超时（${Math.round(timeoutMs / 1000)}s）`));
    }, timeoutMs);
    child.stdout.on('data', (c) => { stdout += String(c); });
    child.stderr.on('data', (c) => { stderr += String(c); });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new SauError(`sau 启动失败: ${err.message}（工作台在 ${SAU_WORKBENCH}?）`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

const tail = (s: string, n = 400) => s.trim().slice(-n);

/** 登录态检查。exit 0 = 已登录；非 0 = 未登录/出错（detail 带原因）。 */
export async function sauCheck(platform: string, account: string): Promise<{ loggedIn: boolean; detail: string }> {
  if (!(await sauAvailable())) {
    throw new SauError(`没找到 sau CLI（${SAU_BIN}）——把 social-auto-upload 工作台装好再用发布`);
  }
  const result = await runSau([platform, 'check', '--account', account], 120_000);
  return {
    loggedIn: result.code === 0,
    detail: tail(result.stdout + '\n' + result.stderr) || (result.code === 0 ? '已登录' : '未登录'),
  };
}

/** 弹出有头浏览器扫码登录（在用户本机开窗口）。等到进程退出为止。 */
export async function sauLogin(platform: string, account: string): Promise<{ ok: boolean; detail: string }> {
  if (!(await sauAvailable())) throw new SauError(`没找到 sau CLI（${SAU_BIN}）`);
  const result = await runSau([platform, 'login', '--account', account, '--headed'], 300_000);
  return { ok: result.code === 0, detail: tail(result.stdout + '\n' + result.stderr) };
}

export interface SauUploadInput {
  platform: string;
  account: string;
  file: string;
  title: string;
  desc?: string;
  tags?: string;
  schedule?: string;
  thumbnail?: string;
}

export interface SauUploadNoteInput {
  platform: string;
  account: string;
  /** 图集本地绝对路径（1-18 张，顺序即展示顺序）. */
  images: string[];
  title: string;
  note: string;
  tags?: string;
  schedule?: string;
}

/** 真实发布一条图文笔记（对外发布——调用方必须已拿到人工确认）。
 *  sau 支持图文的平台：小红书/抖音/快手。 */
export async function sauUploadNote(input: SauUploadNoteInput): Promise<{ ok: boolean; detail: string }> {
  if (!(await sauAvailable())) throw new SauError(`没找到 sau CLI（${SAU_BIN}）`);
  const args = [
    input.platform, 'upload-note',
    '--account', input.account,
    '--images', ...input.images,
    '--title', input.title,
    '--note', input.note,
  ];
  if (input.tags) args.push('--tags', input.tags);
  if (input.schedule) args.push('--schedule', input.schedule);
  const result = await runSau(args, 600_000);
  return { ok: result.code === 0, detail: tail(result.stdout + '\n' + result.stderr, 600) };
}

/** 真实上传一条视频（对外发布——调用方必须已拿到人工确认）。 */
export async function sauUploadVideo(input: SauUploadInput): Promise<{ ok: boolean; detail: string }> {
  if (!(await sauAvailable())) throw new SauError(`没找到 sau CLI（${SAU_BIN}）`);
  const args = [
    input.platform, 'upload-video',
    '--account', input.account,
    '--file', input.file,
    '--title', input.title,
  ];
  if (input.desc) args.push('--desc', input.desc);
  if (input.tags) args.push('--tags', input.tags);
  if (input.schedule) args.push('--schedule', input.schedule);
  if (input.thumbnail) args.push('--thumbnail', input.thumbnail);
  const result = await runSau(args, 600_000);
  return { ok: result.code === 0, detail: tail(result.stdout + '\n' + result.stderr, 600) };
}
