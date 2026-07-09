/**
 * 内置多 Profile 浏览器 — 按「平台 × 账号」隔离的 Chrome user-data-dir。
 *
 * 为什么：自动化发布（sau/Playwright）在小红书等平台有风控风险；最稳的发布
 * 方式是用户在**自己长期使用的真实浏览器档案**里手动存草稿/发布（零自动化
 * 指纹、登录态持久）。创作台为每个 平台×账号 维护一份独立 Chrome 档案，
 * 一键打开直达该平台的发布页——多账号永不串号。
 *
 * 档案目录：<RUNTIME_DATA_DIR>/browser-profiles/<platform>-<account>/
 */
import { spawn } from 'node:child_process';
import { access, mkdir, readdir, stat } from 'node:fs/promises';
import path from 'node:path';

/** 各平台创作者发布页直达地址（打开即到发布界面，少一步找入口）。 */
export const PLATFORM_PUBLISH_URLS: Record<string, { label: string; url: string }> = {
  xiaohongshu: { label: '小红书 · 发布笔记', url: 'https://creator.xiaohongshu.com/publish/publish?source=official' },
  douyin: { label: '抖音 · 创作者中心', url: 'https://creator.douyin.com/creator-micro/content/upload' },
  kuaishou: { label: '快手 · 创作者中心', url: 'https://cp.kuaishou.com/article/publish/video' },
  bilibili: { label: 'B站 · 投稿', url: 'https://member.bilibili.com/platform/upload/video/frame' },
  tencent: { label: '视频号 · 发表动态', url: 'https://channels.weixin.qq.com/platform/post/create' },
  'wechat-mp': { label: '公众号后台', url: 'https://mp.weixin.qq.com' },
};

const CHROME_CANDIDATES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
];

export class BrowserError extends Error {}

async function findChrome(): Promise<string> {
  for (const candidate of CHROME_CANDIDATES) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      /* next */
    }
  }
  throw new BrowserError('没找到 Chrome/Chromium/Edge——安装其中一个后专属浏览器才能用');
}

// 中文等非 ASCII 段清洗有损(「君文教育」「测试账号」旧实现都变 '____'),
// 多个中文账号会共用同一个 Chrome 档案目录。有损时附加 FNV-1a 哈希,
// 不同账号绝不同目录;纯 ASCII 段保持旧值,既有档案不失效。
function sanitize(part: string): string {
  const trimmed = part.trim();
  const cleaned = trimmed.replace(/[^\w.-]/g, '_').slice(0, 40);
  if (/^[\w.-]*$/.test(trimmed)) return cleaned || 'default';
  let h = 0x811c9dc5;
  for (const ch of trimmed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const base = cleaned.replace(/_+$/g, '').replace(/^_+/g, '');
  return `${base ? `${base}_` : ''}u${h.toString(16)}`;
}

export function profileDirFor(root: string, platform: string, account: string): string {
  return path.resolve(root, 'browser-profiles', `${sanitize(platform)}-${sanitize(account)}`);
}

/** 打开（或复用）该 平台×账号 的专属浏览器窗口，直达指定/默认发布页。 */
export async function openProfileBrowser(opts: {
  root: string;
  platform: string;
  account: string;
  url?: string;
}): Promise<{ profileDir: string; url: string }> {
  const chrome = await findChrome();
  const profileDir = profileDirFor(opts.root, opts.platform, opts.account);
  await mkdir(profileDir, { recursive: true });
  const url = opts.url?.trim() || PLATFORM_PUBLISH_URLS[opts.platform]?.url || 'about:blank';
  const child = spawn(
    chrome,
    [
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      // 档案窗口带标识，任务栏一眼分清是哪个账号。
      `--window-name=${opts.platform}-${opts.account}`,
      url,
    ],
    { detached: true, stdio: 'ignore' },
  );
  child.unref();
  return { profileDir, url };
}

/** 已有的浏览器档案列表（平台/账号/最近使用时间）。 */
export async function listProfiles(root: string): Promise<Array<{ id: string; platform: string; account: string; lastUsedAt: number }>> {
  const dir = path.resolve(root, 'browser-profiles');
  let entries: string[] = [];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  const out: Array<{ id: string; platform: string; account: string; lastUsedAt: number }> = [];
  for (const entry of entries) {
    const sep = entry.indexOf('-');
    if (sep <= 0) continue;
    try {
      const info = await stat(path.join(dir, entry));
      out.push({
        id: entry,
        platform: entry.slice(0, sep),
        account: entry.slice(sep + 1),
        lastUsedAt: info.mtimeMs,
      });
    } catch {
      /* skip */
    }
  }
  return out.sort((a, b) => b.lastUsedAt - a.lastUsedAt);
}

/** 在访达里展示一个目录（图集拖拽用）。 */
export function revealInFinder(dir: string): void {
  const child = spawn('open', [dir], { detached: true, stdio: 'ignore' });
  child.unref();
}
