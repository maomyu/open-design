import { BrowserWindow, app, ipcMain, session } from "electron";

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

function sanitizeProfileSegment(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const segment = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (segment.length === 0 || segment.length > 64) return null;
  return segment;
}

// Creator consoles fingerprint the UA; the default one carries
// `Electron/<v>` and the app-name token, which risk-control systems can
// flag as automation. Strip both so the embedded session presents the
// same Chrome UA as the bundled Chromium version.
function cleanUserAgent(): string {
  return app.userAgentFallback
    .split(" ")
    .filter((token) => !/^(Electron|open-design|OpenDesign|WorkBuild)\//i.test(token))
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
