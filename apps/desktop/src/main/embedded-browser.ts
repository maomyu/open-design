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

type EmbeddedBrowserOpenResult = { ok: true } | { ok: false; reason: string };

const windowsByProfile = new Map<string, BrowserWindow>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value != null && !Array.isArray(value);
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
    .filter((token) => !/^(Electron|open-design|OpenDesign|爆创)\//i.test(token))
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
      const lines = ["# Netscape HTTP Cookie File", "# generated by 爆创 embedded browser", ""];
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
      const dir = path.join(os.tmpdir(), "baochuang-cookies");
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
      const doc = await send<{ root: { nodeId: number } }>("DOM.getDocument");
      const found = await send<{ nodeId: number }>("DOM.querySelector", {
        nodeId: doc.root.nodeId,
        selector,
      });
      if (!found.nodeId) return { ok: false, reason: `页面里没找到文件选择框（${selector}）` };
      await send("DOM.setFileInputFiles", { files, nodeId: found.nodeId });
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
  });
  window.webContents.on("did-attach-webview", (_event, contents) => {
    // will-attach 已保证走到这里的只有 od-browser 分区。
    contents.session.setUserAgent(cleanUserAgent());
    contents.setWindowOpenHandler(({ url: childUrl }) => {
      if (!isHttpUrl(childUrl)) return { action: "deny" };
      // 子窗不指定 partition 时继承 opener 会话——登录弹窗落同一档案。
      return { action: "allow" };
    });
  });
}
