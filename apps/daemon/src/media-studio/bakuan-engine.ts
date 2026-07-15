/**
 * bakuan-engine 运行时解析 + 首启动 provision。
 *
 * 短视频创作台整条管线（真抓爆款评分 / 视频下载 / ASR 转写 / 建数据中心）都靠
 * bakuan-engine 的 Python 脚本。两种运行形态：
 *
 *   - **dev**（仓库内跑，resourceRoot=null）：直接用仓库根 `bakuan-engine/.venv`，
 *     和历史行为完全一致，零改动。
 *   - **packaged**（安装包，resourceRoot=资源根）：仓库不在，安装包自带
 *     `bakuan-engine` 源码 + 可重定位 `python-runtime` + 离线 `wheels`。首次用到引擎时
 *     在可写数据目录 `<dataDir>/bakuan-engine` 里 provision 出 `.venv`
 *     （复制源码 → bundled python 建 venv → `pip install --no-index` 离线装 wheels），
 *     之后与 dev 走同一套脚本调用。
 *
 * provision 幂等：只在 `.venv/bin/python` 缺失时跑一次，用单例 Promise 防并发重复。
 */
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface EngineHandle {
  /** 脚本运行的 cwd（源码 + .venv + .env + data 都在这里）。 */
  engineDir: string;
  /** `.venv/bin/python` 绝对路径。 */
  python: string;
  /** `.venv/bin/yt-dlp` 绝对路径（provision 时随 yt-dlp wheel 生成 console script）。 */
  ytdlp: string;
  /**
   * 传给引擎子进程的环境：在 process.env 基础上把 venv/bin 和（packaged 时）自带的
   * 静态 ffmpeg 目录塞进 PATH 前面。ASR 抽音频、yt-dlp 合流都要 ffmpeg，安装后
   * 用户机器上未必有，所以走自带的。
   */
  env: NodeJS.ProcessEnv;
}

export interface EngineContext {
  projectRoot: string;
  dataDir: string;
  /** 打包资源根（`DAEMON_RESOURCE_ROOT`）；dev 下为 null。 */
  resourceRoot: string | null;
}

/** packaged 下解压出来的 python/ffmpeg 落地根（可写、不受 app 签名封印）。 */
function runtimeRootFor(ctx: EngineContext): string {
  return path.join(ctx.dataDir, 'engine-runtime');
}

function handleFor(ctx: EngineContext, engineDir: string): EngineHandle {
  const venvBin = path.join(engineDir, '.venv', 'bin');
  // packaged 自带静态 ffmpeg（首启动从 tar 解到 engine-runtime）；dev 依赖系统 PATH。
  const ffmpegDir = ctx.resourceRoot ? path.join(runtimeRootFor(ctx), 'ffmpeg') : null;
  const pathParts = [venvBin, ffmpegDir, process.env.PATH].filter(Boolean) as string[];
  return {
    engineDir,
    python: path.join(venvBin, 'python'),
    ytdlp: path.join(venvBin, 'yt-dlp'),
    env: { ...process.env, PATH: pathParts.join(path.delimiter) },
  };
}

/** 引擎源码 + venv 的落地目录：dev 用仓库，packaged 用可写数据目录。 */
export function engineDirFor(ctx: EngineContext): string {
  return ctx.resourceRoot
    ? path.join(ctx.dataDir, 'bakuan-engine')
    : path.join(ctx.projectRoot, 'bakuan-engine');
}

let provisionPromise: Promise<void> | null = null;
let lastProvisionError: string | null = null;

/** 最近一次 provision 的错误（供状态端点/日志展示）。 */
export function bakuanEngineProvisionError(): string | null {
  return lastProvisionError;
}

/** provision 是否已完成（`.venv/bin/python` 存在）。 */
export function isBakuanEngineReady(ctx: EngineContext): boolean {
  return fs.existsSync(handleFor(ctx, engineDirFor(ctx)).python);
}

/** 把 opaque tar.gz 解到目标目录（幂等：目标标记文件已在则跳过）。 */
async function extractTarOnce(tarPath: string, destRoot: string, marker: string): Promise<void> {
  if (fs.existsSync(marker)) return;
  if (!fs.existsSync(tarPath)) {
    throw new Error(`安装包缺少运行时归档：${path.basename(tarPath)}`);
  }
  await fs.promises.mkdir(destRoot, { recursive: true });
  await execFileAsync('tar', ['xzf', tarPath, '-C', destRoot], { timeout: 180_000 });
}

async function provision(ctx: EngineContext, engineDir: string): Promise<void> {
  const resourceRoot = ctx.resourceRoot;
  if (!resourceRoot) return; // dev：不 provision，直接用仓库 .venv
  const bundledEngine = path.join(resourceRoot, 'bakuan-engine');
  const wheels = path.join(resourceRoot, 'wheels');
  const runtimeRoot = runtimeRootFor(ctx);
  const bundledPython = path.join(runtimeRoot, 'python-runtime', 'bin', 'python3');
  if (!fs.existsSync(wheels) || !fs.existsSync(bundledEngine)) {
    throw new Error(
      '安装包缺少内置 Python 引擎（wheels / bakuan-engine 未随包发布）——请用带 vendor 的构建重新打包',
    );
  }

  // 1) 解压 python 运行时 + ffmpeg 到可写目录（app 内是 opaque tar，绕开 codesign deep 校验）。
  await extractTarOnce(path.join(resourceRoot, 'python-runtime.tar.gz'), runtimeRoot, bundledPython);
  await extractTarOnce(
    path.join(resourceRoot, 'ffmpeg.tar.gz'),
    runtimeRoot,
    path.join(runtimeRoot, 'ffmpeg', 'ffmpeg'),
  );

  // 2) 源码复制到可写目录（含 .env）。venv 若残留（上次 provision 中断）先清掉。
  await fs.promises.mkdir(path.dirname(engineDir), { recursive: true });
  await fs.promises.cp(bundledEngine, engineDir, { recursive: true });
  await writeEngineSourceStamp(resourceRoot, engineDir); // 记录本次源码版本,供后续更新检测
  const venvDir = path.join(engineDir, '.venv');
  await fs.promises.rm(venvDir, { force: true, recursive: true });

  // 3) 用解压出的可重定位 python 建 venv。
  await execFileAsync(bundledPython, ['-m', 'venv', venvDir], { cwd: engineDir, timeout: 180_000 });

  // 4) 离线装依赖（wheels 已按目标 ABI 预下载，无需联网/编译）。
  const pip = path.join(venvDir, 'bin', 'pip');
  const runtimeReq = path.join(engineDir, 'requirements-runtime.txt');
  const req = fs.existsSync(runtimeReq) ? runtimeReq : path.join(engineDir, 'requirements.txt');
  await execFileAsync(
    pip,
    ['install', '--no-index', '--no-cache-dir', '--find-links', wheels, '-r', req],
    { cwd: engineDir, timeout: 600_000 },
  );
}

/** 打包源码版本戳：取捆绑引擎源码树(src/scripts/config)里【最新文件】的 mtime 作版本标记。
 *  任何引擎文件重打包(mtime 变)都会更新此戳,据此判断【已 provision 的可写副本】是否落后于
 *  安装包里的新代码。(原先只看 pipeline.py,导致仅改 tikhub_client / resolve_video_url 等兄弟
 *  文件时 resync 不触发、改动到不了老用户;现扫全树取最大 mtime,任一引擎文件改动都会触发。) */
function bundledEngineSourceStamp(resourceRoot: string): string {
  const root = path.join(resourceRoot, 'bakuan-engine');
  const SKIP = new Set(['__pycache__', '.venv', 'data', 'node_modules', '.git', 'downloads']);
  let maxMtime = 0;
  const walk = (dir: string, depth: number): void => {
    if (depth > 6) return;
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (SKIP.has(e.name) || e.name.startsWith('.od-engine')) continue;
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p, depth + 1); continue; }
      try { const m = fs.statSync(p).mtimeMs; if (m > maxMtime) maxMtime = m; } catch { /* 跳过取不到的文件 */ }
    }
  };
  // 仅扫源码目录,避开 .venv / data / __pycache__ 等运行时产物(其 mtime 会漂移、与代码版本无关)。
  for (const sub of ['src', 'scripts', 'config']) walk(path.join(root, sub), 0);
  return maxMtime ? String(maxMtime) : '';
}

async function writeEngineSourceStamp(resourceRoot: string, engineDir: string): Promise<void> {
  const stamp = bundledEngineSourceStamp(resourceRoot);
  if (stamp) await fs.promises.writeFile(path.join(engineDir, '.od-engine-src-stamp'), stamp, 'utf8').catch(() => {});
}

/**
 * 引擎升级同步：app 更新/重装后,安装包里捆绑的引擎源码是新的,但【首启动 provision 出的可写
 * 副本】是一次性的、不会自动更新——否则引擎侧改动(如 TikHub 采集逻辑)永远到不了老用户。这里
 * 比对源码版本戳,落后就把 src/scripts/config/.env/requirements 从捆绑源码重新同步过来(保留
 * .venv 和 data)。纯 .py 改动无需重建 venv;若 requirements 变了则删 venv 触发下次重装依赖。
 */
async function resyncEngineSourceIfStale(ctx: EngineContext, engineDir: string): Promise<void> {
  const resourceRoot = ctx.resourceRoot;
  if (!resourceRoot) return;
  const want = bundledEngineSourceStamp(resourceRoot);
  if (!want) return;
  let have = '';
  try { have = await fs.promises.readFile(path.join(engineDir, '.od-engine-src-stamp'), 'utf8'); } catch { /* 无戳=旧版本 */ }
  if (have.trim() === want) return; // 已是最新

  const bundledEngine = path.join(resourceRoot, 'bakuan-engine');
  // requirements 变了没?变了要重装依赖(删 venv → 下次 ensure 触发完整 provision)。
  let reqChanged = false;
  for (const f of ['requirements-runtime.txt', 'requirements.txt']) {
    try {
      const a = await fs.promises.readFile(path.join(bundledEngine, f), 'utf8');
      const b = await fs.promises.readFile(path.join(engineDir, f), 'utf8').catch(() => '');
      if (a !== b) reqChanged = true;
    } catch { /* 缺文件忽略 */ }
  }
  // 重新同步代码目录(保留 .venv / data)。
  for (const sub of ['src', 'scripts', 'config']) {
    const from = path.join(bundledEngine, sub);
    if (fs.existsSync(from)) {
      await fs.promises.rm(path.join(engineDir, sub), { recursive: true, force: true });
      await fs.promises.cp(from, path.join(engineDir, sub), { recursive: true });
    }
  }
  for (const f of ['.env', 'requirements.txt', 'requirements-runtime.txt', 'Makefile']) {
    const from = path.join(bundledEngine, f);
    if (fs.existsSync(from)) await fs.promises.cp(from, path.join(engineDir, f)).catch(() => {});
  }
  if (reqChanged) {
    // 依赖清单变化:删 venv,让下次 ensure 走完整 provision 重装依赖。
    await fs.promises.rm(path.join(engineDir, '.venv'), { recursive: true, force: true }).catch(() => {});
  }
  await writeEngineSourceStamp(resourceRoot, engineDir);
}

/** 确保 packaged 引擎已 provision（幂等、防并发）；dev 直接返回。 */
export function ensureBakuanEngineProvisioned(ctx: EngineContext): Promise<void> {
  if (!ctx.resourceRoot) return Promise.resolve();
  const engineDir = engineDirFor(ctx);
  if (fs.existsSync(handleFor(ctx, engineDir).python)) {
    // 已 provision:检查源码是否落后于安装包里的新代码,落后则同步(引擎升级随 app 更新到达)。
    return resyncEngineSourceIfStale(ctx, engineDir).catch((err) => {
      console.warn('[bakuan-engine] 源码同步失败(用旧代码继续):', err instanceof Error ? err.message : String(err));
    });
  }
  if (!provisionPromise) {
    lastProvisionError = null;
    provisionPromise = provision(ctx, engineDir).catch((err) => {
      provisionPromise = null; // 允许下次重试
      lastProvisionError = err instanceof Error ? err.message : String(err);
      throw err;
    });
  }
  return provisionPromise;
}

/**
 * 解析出可直接用的引擎句柄。packaged 下会在此等待/触发首启动 provision，
 * 所以调用方 `await` 它即可，无需关心 dev/packaged 差异。
 */
export async function resolveBakuanEngine(ctx: EngineContext): Promise<EngineHandle> {
  await ensureBakuanEngineProvisioned(ctx);
  return handleFor(ctx, engineDirFor(ctx));
}

/** 启动时后台预热 provision，让用户第一步操作前引擎大概率已就绪。失败只记日志、不阻断。 */
export function warmBakuanEngine(ctx: EngineContext, log?: (msg: string) => void): void {
  if (!ctx.resourceRoot) return;
  if (isBakuanEngineReady(ctx)) return;
  log?.('[bakuan-engine] 首次启动，正在后台准备内置 Python 引擎（约 1 分钟）…');
  ensureBakuanEngineProvisioned(ctx)
    .then(() => log?.('[bakuan-engine] 内置 Python 引擎已就绪'))
    .catch((err) => log?.(`[bakuan-engine] 引擎准备失败：${err instanceof Error ? err.message : String(err)}`));
}
