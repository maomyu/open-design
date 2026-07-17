import { BrowserWindow, app, ipcMain, session, webContents } from "electron";
import { promises as fs } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

/**
 * Embedded multi-profile browser for the media studios' safe-publish flow.
 *
 * Each 平台×账号 pair maps to a persistent Chromium session partition
 * (`persist:od-browser-<platform>-<account>`), so login state (cookies,
 * localStorage) survives restarts and never leaks across accounts. Windows
 * are plain sandboxed BrowserWindows with NO preload and NO node access —
 * they render third-party creator consoles (小红书/公众号/抖音…), which must
 * stay fully untrusted.
 */

const EMBEDDED_BROWSER_IPC_CHANNEL = "od:browser:open-profile";
const PARTITION_PREFIX = "persist:od-browser-";

/**
 * 必须在 app ready 之前调用。关掉网络服务沙箱——签名安装包里 Chromium 网络服务在沙箱下
 * 对 relocated 会话目录的磁盘写有时受限,这是打包 Electron 的常规防御性开关。
 *
 * 实测提醒:安装包日志里的 `Unable to create cache` / `wrong file structure on disk` 这类
 * 报错,本开关【并不能消除】——它们源于旧构建残留在会话目录里的、结构不兼容的磁盘 cache
 * (跟沙箱无关),但都是【非致命】的(Chromium 退回内存 cache,功能不受影响)。登录态能否
 * 跨重启/重编译保持,靠的是 cookie 保险库(export/import,不依赖 Chromium 自身磁盘持久化),
 * 与这些 cache 报错无关。此开关留作低风险防御;第三方页面本就跑在无 node/沙箱 webview 里,
 * 网络栈进程隔离度降低对本 app 风险很低。
 */
export function applyEmbeddedBrowserNetworkSwitches(electronApp: Electron.App): void {
  if (electronApp.isReady()) return; // ready 后再 append 无效
  electronApp.commandLine.appendSwitch("disable-features", "NetworkServiceSandbox");
}

type EmbeddedBrowserOpenResult = { ok: true } | { ok: false; reason: string };

const windowsByProfile = new Map<string, BrowserWindow>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
}

// ───────────────────────── cookie 保险库 ─────────────────────────
// 2026-07-14 用户报"重新编译安装包后已登录的短视频账号失效"。实测根因:签名安装包里
// Chromium 网络服务在 relocated 会话目录建不起磁盘 cookie store(desktop 日志成片
// `Unable to create cache` / `Failed to create directory`),cookie 只活在内存,一退出就没,
// 每次启动都要重登(用户以为是"重编译导致失效")。dev 复现不出,死磕让 Chromium 自己落盘
// 性价比低。这里绕开:把【内置浏览器自己那份分区 cookie】抢救到 daemon 数据目录旁的可靠
// JSON(重编译/重装不清),启动时回灌回同一分区。不是另开浏览器,操作的就是内置浏览器的
// 登录态。
//
// 【多账号隔离铁律】每个 平台×账号 是独立分区(persist:od-browser-<平台>-<账号>);保险库
// 一分区一文件、文件名锚定完整分区串,导出/回灌都只针对该分区,绝不跨账号合并——否则不同
// 账号的登录态会串。
const cookieVaultPartitions = new Set<string>();
// 本次运行已回灌过的分区:回灌只做一次,避免"用户本次会话里重新登录后 webview 再次附加"
// 时又拿【旧】保险库覆盖掉刚登录的新 cookie(旧盖新 → 又变未登录)。

function cookieVaultDir(): string {
  // userData 在 packaged 下=namespaceRoot/user-data(install 不清,仅 cleanup 清),够持久;
  // 放在 session/ 之外的独立子目录,不受那套坏掉的 session cache 影响。
  return path.join(app.getPath("userData"), "browser-cookie-vault");
}

function cookieVaultFileFor(partition: string): string {
  // 文件名 1:1 锚定完整分区串(含平台+账号),保证账号间隔离,永不合并。
  const safe = partition.replace(/[^a-zA-Z0-9_.-]/g, "_");
  return path.join(cookieVaultDir(), `${safe}.json`);
}

/** 从 Electron cookie 反推一个可用于 cookies.set 的 URL(set 必须给 url)。 */
function cookieUrl(c: Electron.Cookie): string | null {
  if (!c.domain) return null;
  const host = c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
  if (!host) return null;
  const scheme = c.secure ? "https" : "http";
  return `${scheme}://${host}${c.path || "/"}`;
}

// 同一分区导出的串行化链。interval(每 5s)与 did-navigate 可能并发触发同分区导出,
// 而 fs.writeFile 不是原子的——并发写会互相截断,退出时 fire-and-forget 的写更会被
// 进程退出腰斩成【0 字节】文件(2026-07-14 实测 vault 出现 0 字节 douyin 档案,导致
// 回灌拿到空 = 登录态照丢)。用 in-flight Promise 链把同分区的写排成队。
const exportChains = new Map<string, Promise<void>>();

/** 导出某分区当前全量 cookie 到保险库(读内存 store,磁盘持久化坏掉也拿得到)。
 *  只在拿到 cookie 时写;写入【原子】(temp→rename),同分区【串行】,绝不产生 0 字节/半截档案。 */
async function exportPartitionCookies(partition: string): Promise<void> {
  const prev = exportChains.get(partition) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(() => doExportPartitionCookies(partition));
  exportChains.set(partition, next);
  try {
    await next;
  } finally {
    if (exportChains.get(partition) === next) exportChains.delete(partition);
  }
}

async function doExportPartitionCookies(partition: string): Promise<void> {
  try {
    const cookies = await session.fromPartition(partition).cookies.get({});
    if (cookies.length === 0) return; // 空结果不覆盖已有好档案
    await fs.mkdir(cookieVaultDir(), { recursive: true });
    const file = cookieVaultFileFor(partition);
    const tmp = `${file}.${process.pid}.tmp`;
    // 原子写:先写临时文件,再 rename 到正式名。进程中途被杀最多留个 .tmp,正式档案要么
    // 是上一次的完整内容、要么是这次的完整内容,绝不会是 0 字节或半截。
    await fs.writeFile(tmp, JSON.stringify({ partition, savedAt: Date.now(), cookies }), "utf8");
    await fs.rename(tmp, file);
  } catch {
    /* best-effort:保险库写失败不影响使用 */
  }
}

/** 把保险库里该分区的 cookie 回灌进同一分区。返回成功注入条数。 */
async function importPartitionCookies(partition: string): Promise<number> {
  let cookies: Electron.Cookie[] = [];
  try {
    const raw = await fs.readFile(cookieVaultFileFor(partition), "utf8");
    const data = JSON.parse(raw) as { cookies?: Electron.Cookie[] };
    cookies = Array.isArray(data.cookies) ? data.cookies : [];
  } catch {
    return 0; // 没有保险库=首次登录,正常
  }
  const s = session.fromPartition(partition);
  let n = 0;
  for (const c of cookies) {
    const url = cookieUrl(c);
    if (!url) continue;
    try {
      await s.cookies.set({
        url,
        name: c.name,
        value: c.value,
        domain: c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        ...(typeof c.expirationDate === "number" ? { expirationDate: c.expirationDate } : {}),
        ...(c.sameSite ? { sameSite: c.sameSite } : {}),
      });
      n++;
    } catch {
      /* 单条坏 cookie 跳过 */
    }
  }
  return n;
}

const restoredPartitionsThisRun = new Set<string>();

/** 登记一个活跃分区并回灌它的保险库(webview 附加/独立窗打开时调用)。回灌每分区每次运行
 *  只做一次:防止本次会话里刚登录后又被旧保险库覆盖(旧盖新)。 */
async function trackAndRestorePartition(partition: string): Promise<void> {
  if (!partition.startsWith(PARTITION_PREFIX)) return;
  cookieVaultPartitions.add(partition);
  if (restoredPartitionsThisRun.has(partition)) return;
  restoredPartitionsThisRun.add(partition);
  await importPartitionCookies(partition);
}

/**
 * 启动时:扫描保险库目录,把每个已保存分区的 cookie 预回灌回对应分区,让内置浏览器
 * 一开就是已登录态(webview 加载前就注入好)。仅桌面主进程、app ready 后调用。
 */
export async function restoreEmbeddedBrowserCookies(): Promise<void> {
  let files: string[] = [];
  try {
    files = await fs.readdir(cookieVaultDir());
  } catch {
    return; // 没有保险库目录=还没存过,正常
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    try {
      const raw = await fs.readFile(path.join(cookieVaultDir(), f), "utf8");
      const data = JSON.parse(raw) as { partition?: string };
      const partition = typeof data.partition === "string" ? data.partition : "";
      if (partition.startsWith(PARTITION_PREFIX) && !restoredPartitionsThisRun.has(partition)) {
        cookieVaultPartitions.add(partition);
        restoredPartitionsThisRun.add(partition);
        await importPartitionCookies(partition);
      }
    } catch {
      /* 坏档案跳过 */
    }
  }
}

/** 退出前把所有活跃分区的 cookie 落一遍保险库。返回 Promise 供退出流程 await——
 *  必须等写完再退,否则 fire-and-forget 会被进程退出腰斩(见 doExportPartitionCookies)。
 *  调用方应给它套超时,别让保险库写卡住退出。 */
export async function flushEmbeddedBrowserCookieVault(): Promise<void> {
  await Promise.all([...cookieVaultPartitions].map((p) => exportPartitionCookies(p).catch(() => undefined)));
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// 必须与 apps/web/src/runtime/browser-panes.ts 的 sanitizeProfileSegment
// 逐字节一致:应用内标签(渲染层拼 partition)与独立窗(这里拼)要落同一分区。
// 中文等非 ASCII 账号名清洗是「有损」的(全变 '-' 再剥掉=空),旧实现让所有
// 中文账号都兜底到 'main' 共用一个登录态(2026-07-09 用户报"不同账号一直
// 复用第一次登录的号")。有损时附加 FNV-1a 哈希,不同账号名绝不同段;
// 纯 ASCII 名保持旧值,既有档案不失效。
function sanitizeProfileSegment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (trimmed.length === 0 || trimmed.length > 200) return null;
  const lowered = trimmed.toLowerCase();
  const cleaned = lowered
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  if (/^[a-z0-9_-]+$/.test(lowered)) return cleaned || null;
  let h = 0x811c9dc5;
  for (const ch of trimmed) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${cleaned ? `${cleaned}-` : ""}u${h.toString(16)}`;
}

// Creator consoles fingerprint the UA; the default one carries
// `Electron/<v>` and the app-name token, which risk-control systems can
// flag as automation. Strip both so the embedded session presents the
// same Chrome UA as the bundled Chromium version.
function cleanUserAgent(): string {
  return app.userAgentFallback
    .split(" ")
    .filter((token) => !/^(Electron|open-design|OpenDesign|social-auto|social-auto)\//i.test(token))
    .join(" ");
}

type ParsedOpenRequest = {
  partition: string;
  profileKey: string;
  title: string;
  url: string;
};

function parseOpenRequest(raw: unknown): ParsedOpenRequest | { reason: string } {
  if (!isRecord(raw)) return { reason: "invalid embedded browser request" };
  const platform = sanitizeProfileSegment(raw.platform);
  const account = sanitizeProfileSegment(raw.account) ?? "main";
  if (platform == null) return { reason: "invalid platform for embedded browser profile" };
  const url = typeof raw.url === "string" ? raw.url : "";
  if (!isHttpUrl(url)) return { reason: "embedded browser only opens http(s) URLs" };
  const profileKey = `${platform}-${account}`;
  const title =
    typeof raw.title === "string" && raw.title.trim().length > 0
      ? raw.title.trim().slice(0, 80)
      : profileKey;
  return { partition: `${PARTITION_PREFIX}${profileKey}`, profileKey, title, url };
}

export function openEmbeddedBrowserProfile(raw: unknown): EmbeddedBrowserOpenResult {
  const parsed = parseOpenRequest(raw);
  if (!("url" in parsed)) return { ok: false, reason: parsed.reason };
  const { partition, profileKey, title, url } = parsed;

  const existing = windowsByProfile.get(profileKey);
  if (existing != null && !existing.isDestroyed()) {
    if (existing.isMinimized()) existing.restore();
    existing.show();
    existing.focus();
    void existing.webContents.loadURL(url);
    return { ok: true };
  }

  // Session-level UA covers the window AND any login popups it spawns.
  session.fromPartition(partition).setUserAgent(cleanUserAgent());
  // 独立窗打开前先回灌该分区保险库,让窗口一开就是已登录态(与应用内标签同一分区,
  // 登录态互通)。异步不阻塞:cookie 注入通常快于页面首帧。
  void trackAndRestorePartition(partition);

  const window = new BrowserWindow({
    width: 1240,
    height: 900,
    minWidth: 720,
    minHeight: 520,
    show: true,
    title,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      partition,
      sandbox: true,
    },
  });

  // Keep the profile identity visible instead of the page's own <title>,
  // so multiple account windows stay tell-apart-able.
  window.on("page-title-updated", (event) => {
    event.preventDefault();
  });

  // Login flows (扫码/OAuth) open child windows; allow them inside the
  // same partition, deny everything non-http.
  window.webContents.setWindowOpenHandler(({ url: childUrl }) => {
    if (!isHttpUrl(childUrl)) return { action: "deny" };
    return {
      action: "allow",
      overrideBrowserWindowOptions: {
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          partition,
          sandbox: true,
        },
      },
    };
  });

  window.on("closed", () => {
    if (windowsByProfile.get(profileKey) === window) windowsByProfile.delete(profileKey);
  });

  windowsByProfile.set(profileKey, window);
  void window.webContents.loadURL(url);
  return { ok: true };
}

export function registerEmbeddedBrowserBridge(): void {
  // removeHandler first so dev hot-reload re-registration does not throw.
  ipcMain.removeHandler(EMBEDDED_BROWSER_IPC_CHANNEL);
  ipcMain.handle(EMBEDDED_BROWSER_IPC_CHANNEL, (_event, request: unknown) =>
    openEmbeddedBrowserProfile(request),
  );
}

const EXPORT_COOKIES_IPC_CHANNEL = "od:browser:export-cookies";

/**
 * 导出某个 平台×账号 登录分区的全部 cookie 到本机 Netscape cookie 文件。
 *
 * 为什么需要:抖音/小红书等平台的视频下载接口现在硬性要求真实会话 cookie
 * (含 httpOnly 的 ttwid/msToken——页面 JS 的 document.cookie 读不到,只有主
 * 进程 session.cookies.get 能拿全)。用户已在内置浏览器里登录了这些平台,
 * 把该分区的 cookie 落成标准 Netscape 文件后,daemon 侧的 yt-dlp 加
 * `--cookies <file>` 就能像登录用户一样直接下原视频(给"提取文案仿写"用)。
 *
 * 安全边界:只导出 od-browser 持久分区(用户自己的登录态)、只写到本机临时
 * 目录、文件仅供本地下载器读取,不外传。
 */
export function registerEmbeddedBrowserCookieBridge(): void {
  ipcMain.removeHandler(EXPORT_COOKIES_IPC_CHANNEL);
  ipcMain.handle(EXPORT_COOKIES_IPC_CHANNEL, async (_event, raw: unknown) => {
    if (!isRecord(raw)) return { ok: false, reason: "invalid export-cookies request" };
    const platform = sanitizeProfileSegment(raw.platform);
    const account = sanitizeProfileSegment(raw.account) ?? "main";
    if (platform == null) return { ok: false, reason: "invalid platform for cookie export" };
    const profileKey = `${platform}-${account}`;
    const partition = `${PARTITION_PREFIX}${profileKey}`;
    try {
      const cookies = await session.fromPartition(partition).cookies.get({});
      if (cookies.length === 0) {
        return { ok: false, reason: "该平台还没有登录态(先在内置浏览器登录一次再试)" };
      }
      // Netscape cookie 文件格式(yt-dlp / curl 通用):
      // domain \t includeSubdomains \t path \t secure \t expiry \t name \t value
      const lines = ["# Netscape HTTP Cookie File", "# generated by social-auto embedded browser", ""];
      for (const c of cookies) {
        const domain = c.domain ?? "";
        if (!domain) continue;
        const includeSub = domain.startsWith(".") ? "TRUE" : "FALSE";
        const secure = c.secure ? "TRUE" : "FALSE";
        // session cookie 无 expirationDate → 给一个远期时间,避免 yt-dlp 判定过期。
        const expiry = c.expirationDate ? Math.floor(c.expirationDate) : 2147483647;
        lines.push(
          [domain, includeSub, c.path || "/", secure, String(expiry), c.name, c.value].join("\t"),
        );
      }
      // 目录名带产品身份:本机多客户包并行,cookies 导出绝不能跨客户共享目录。
      const dir = path.join(os.tmpdir(), "social-auto-cookies");
      await fs.mkdir(dir, { recursive: true });
      const cookieFile = path.join(dir, `${profileKey}.txt`);
      await fs.writeFile(cookieFile, lines.join("\n"), "utf8");
      return { ok: true, cookieFile, count: cookies.length };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    }
  });
}

const SET_FILE_INPUT_IPC_CHANNEL = "od:browser:set-file-input";

/**
 * 「一键存草稿」的文件注入通道(2026-07-09 用户拍板:自动把稿件填进平台
 * 发布页,免手动上传)。页面 JS 无法设置 <input type=file>(浏览器安全模型),
 * 唯一正道是 CDP DOM.setFileInputFiles(Playwright 同款)。安全边界:
 *  - 只服务 <webview> 类型的 webContents(will-attach-webview 已保证所有
 *    webview 都锁在 od-browser 分区,即应用内后台面板);
 *  - 文件路径必须是绝对路径(daemon 资产目录/用户成片路径)。
 */
export function registerWebviewFileInputBridge(): void {
  ipcMain.removeHandler(SET_FILE_INPUT_IPC_CHANNEL);
  ipcMain.handle(SET_FILE_INPUT_IPC_CHANNEL, async (_event, raw: unknown) => {
    if (!isRecord(raw)) return { ok: false, reason: "invalid set-file-input request" };
    const webContentsId = typeof raw.webContentsId === "number" ? raw.webContentsId : -1;
    const selector = typeof raw.selector === "string" && raw.selector.trim() ? raw.selector.trim() : "input[type=file]";
    const files = Array.isArray(raw.files)
      ? raw.files.filter((f): f is string => typeof f === "string" && f.startsWith("/"))
      : [];
    if (webContentsId < 0 || files.length === 0) {
      return { ok: false, reason: "缺少 webview id 或文件绝对路径" };
    }
    const target = webContents.fromId(webContentsId);
    if (!target || target.isDestroyed()) return { ok: false, reason: "后台面板不在了——重新打开再试" };
    if (target.getType() !== "webview") return { ok: false, reason: "只允许注入应用内后台面板" };
    const dbg = target.debugger;
    const wasAttached = dbg.isAttached();
    // CDP 命令在页面 busy 时可能长挂,超时竞速防止渲染层 invoke 永远 pending。
    const send = async <T>(method: string, params?: Record<string, unknown>): Promise<T> =>
      (await Promise.race([
        dbg.sendCommand(method, params),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${method} 超时`)), 10_000)),
      ])) as T;
    try {
      if (!wasAttached) dbg.attach("1.3");
      // depth:-1 + pierce:true 把 iframe/shadow DOM 全展开进 CDP 的 DOM agent,否则跨框架搜不到。
      const doc = await send<{ root: { nodeId: number } }>("DOM.getDocument", { depth: -1, pierce: true });
      let nodeId = (await send<{ nodeId: number }>("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      })).nodeId;
      // 主框架没找到 → 跨 iframe 全文搜(视频号发表页的视频输入在同源 iframe 里;其它平台不受影响)。
      if (!nodeId) {
        const search = await send<{ searchId: string; resultCount: number }>("DOM.performSearch", { query: selector });
        if (search.resultCount > 0) {
          const res = await send<{ nodeIds: number[] }>("DOM.getSearchResults", {
            searchId: search.searchId, fromIndex: 0, toIndex: search.resultCount,
          });
          nodeId = res.nodeIds[0] ?? 0;
        }
        await send("DOM.discardSearchResults", { searchId: search.searchId }).catch(() => {});
      }
      if (!nodeId) return { ok: false, reason: `页面里没找到文件选择框（${selector}）` };
      await send("DOM.setFileInputFiles", { files, nodeId });
      return { ok: true };
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) };
    } finally {
      if (!wasAttached && dbg.isAttached()) {
        try {
          dbg.detach();
        } catch {
          /* already gone */
        }
      }
    }
  });
}

/**
 * 应用内后台标签页（2026-07-09 用户拍板:后台在主窗口内打开,不再弹独立窗）
 * 的 <webview> 安全闸。渲染层 BrowserPanesHost 用 <webview partition=
 * "persist:od-browser-<platform>-<account>"> 内嵌第三方创作者后台,与独立窗
 * 共享同一分区 —— 登录态互通。这里锁死三件事:
 *  1. 只允许 od-browser 分区的 webview 附加(其余一律拒绝);
 *  2. 附加参数强制无 preload / 无 node / 沙箱(第三方页面完全不可信);
 *  3. 会话 UA 去掉 Electron/应用名标记(与独立窗同一套反指纹策略),
 *     登录弹窗(扫码/OAuth)允许但仅限 http(s),继承同一会话。
 */
// will-attach → did-attach 的分区桥:will-attach 能读 params.partition 但拿不到
// webContents;did-attach 有 webContents 但读不到分区。二者对每个 webview 成对、按序
// 触发,用 FIFO 队列把分区串从前者传给后者。
const pendingWebviewPartitions: string[] = [];

export function hardenWebviewEmbeddedBrowser(window: BrowserWindow): void {
  window.webContents.on("will-attach-webview", (event, webPreferences, params) => {
    const partition = typeof params.partition === "string" ? params.partition : "";
    if (!partition.startsWith(PARTITION_PREFIX)) {
      event.preventDefault();
      return;
    }
    delete webPreferences.preload;
    webPreferences.nodeIntegration = false;
    webPreferences.contextIsolation = true;
    webPreferences.sandbox = true;
    pendingWebviewPartitions.push(partition);
    // 附加前先回灌该分区保险库,让 webview 首帧就带上已登录 cookie(避免登录墙)。
    // 异步不阻塞:webview 首个 http 请求要等页面开始加载,cookie 注入通常抢在前面;
    // 即使偶尔慢一拍,采集端也有"登录墙停前台等你登录"兜底。
    void trackAndRestorePartition(partition);
  });
  window.webContents.on("did-attach-webview", (_event, contents) => {
    // will-attach 已保证走到这里的只有 od-browser 分区。
    // session UA 管网络请求;webContents UA 管 JS 可见的 navigator.userAgent。两个都要清成干净
    // Chrome——微信视频号登录页会读 navigator.userAgent 检测内置浏览器(带 Electron/social-auto 就
    // 拒绝渲染登录二维码、只给"浏览器不支持"占位图),只清 session 不够。
    contents.session.setUserAgent(cleanUserAgent());
    contents.setUserAgent(cleanUserAgent());
    contents.setWindowOpenHandler(({ url: childUrl }) => {
      if (!isHttpUrl(childUrl)) return { action: "deny" };
      // 子窗不指定 partition 时继承 opener 会话——登录弹窗落同一档案。
      return { action: "allow" };
    });
    const partitionOf = pendingWebviewPartitions.shift();
    // 登录态持久化(2026-07-14 用户报"每次点登录都要重新登"、"重编译后账号失效"):
    // 仅靠 Chromium 自己 flushStore 在签名安装包里不生效(网络服务磁盘 store 建不起来)。
    // 改为在【导航后 + 定时 + 销毁前】把该分区 cookie 导出到保险库(读内存 store,磁盘坏也
    // 拿得到),启动时回灌。flushStore 保留作锦上添花(磁盘可用时也写一份)。
    const persist = () => {
      void contents.session.cookies.flushStore().catch(() => {});
      if (partitionOf) void exportPartitionCookies(partitionOf);
    };
    contents.on("did-navigate", persist);
    contents.on("did-frame-navigate", persist);
    const timer = setInterval(persist, 5000);
    contents.once("destroyed", () => {
      clearInterval(timer);
      if (partitionOf) void exportPartitionCookies(partitionOf);
    });
    contents.once("did-stop-loading", persist);
  });
}
