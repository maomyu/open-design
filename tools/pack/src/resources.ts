import { existsSync, readFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

function resolveToolsPackRoot(startDir: string): string {
  const maxDepth = 6;
  let current = startDir;

  for (let depth = 0; depth < maxDepth; depth += 1) {
    try {
      const raw = readFileSync(join(current, "package.json"), "utf8");
      const parsed = JSON.parse(raw) as { name?: unknown };
      if (parsed.name === "@open-design/tools-pack") {
        return current;
      }
    } catch {
      // Keep walking until we find the tools-pack package root.
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  throw new Error(`tools-pack: unable to resolve package root from ${startDir}`);
}

export const toolsPackRoot = resolveToolsPackRoot(dirname(fileURLToPath(import.meta.url)));
export const resourcesRoot = join(toolsPackRoot, "resources");

export const macResources = {
  entitlements: join(resourcesRoot, "mac", "entitlements.mac.plist"),
  entitlementsInherit: join(resourcesRoot, "mac", "entitlements.mac.inherit.plist"),
  icon: join(resourcesRoot, "mac", "icon.icns"),
  iconPng: join(resourcesRoot, "mac", "icon.png"),
  notarizeHook: join(resourcesRoot, "mac", "notarize.cjs"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const winResources = {
  icon: join(resourcesRoot, "win", "icon.ico"),
  sevenZipDll: join(resourcesRoot, "win", "7zip", "7z.dll"),
  sevenZipExe: join(resourcesRoot, "win", "7zip", "7z.exe"),
  webStandaloneAfterPackHook: join(resourcesRoot, "web-standalone-after-pack.cjs"),
} as const;

export const linuxResources = {
  icon: join(resourcesRoot, "linux", "icon.png"),
  desktopTemplate: join(resourcesRoot, "linux", "open-design.desktop.template"),
} as const;

const BUNDLED_RESOURCE_TREES = [
  { from: "skills", to: "skills" },
  // After the skills/design-templates split (specs/current/skills-and-design-templates.md)
  // the rendering catalogue lives under its own root and the daemon
  // resolves it via DESIGN_TEMPLATES_DIR. Bundle it like any other
  // first-class resource so packaged builds carry the full template set.
  { from: "design-templates", to: "design-templates" },
  { from: "design-systems", to: "design-systems" },
  { from: "craft", to: "craft" },
  { from: join("plugins", "_official"), to: join("plugins", "_official") },
  { from: join("plugins", "registry"), to: join("plugins", "registry") },
  { from: join("assets", "frames"), to: "frames" },
  { from: join("assets", "community-pets"), to: "community-pets" },
  { from: "prompt-templates", to: "prompt-templates" },
] as const;

export async function copyBundledResourceTrees({
  workspaceRoot,
  resourceRoot,
}: {
  workspaceRoot: string;
  resourceRoot: string;
}): Promise<void> {
  for (const entry of BUNDLED_RESOURCE_TREES) {
    await cp(join(workspaceRoot, entry.from), join(resourceRoot, entry.to), {
      recursive: true,
    });
  }
  await copyBakuanEngine({ workspaceRoot, resourceRoot });
}

// Short-video 创作台整条管线（真抓爆款评分/视频下载/ASR 转写）都靠 bakuan-engine
// 的 Python 脚本。dev 用仓库根的 .venv 就能跑，但打包安装后仓库不在，安装包必须
// 自带「引擎源码 + 可重定位 Python 运行时 + 离线 wheels」，首启动时 daemon 在可写
// 数据目录里 provision 出 .venv。这里负责把这三样 stage 进资源树。
const BAKUAN_ENGINE_EXCLUDE_TOP = new Set([
  ".venv", // 578MB 且不可重定位——安装后由 daemon 用 bundled python 重新 provision
  "data", // 运行期 SQLite/Chroma 落库，写到可写数据目录，不进包
  "output",
  "__pycache__",
  ".pytest_cache",
]);

// dotenv 模板可以进包(给交付后的配置文档用),真实 .env 永不出仓库。
const DOTENV_TEMPLATE = /^\.env\.(example|sample|template)$/;

// 引擎 config/settings.py 是 load_dotenv() 的——bakuan-engine/.env 是 API key 的
// 常驻处。一旦打进安装包,key 就随 dmg 发到客户机器上(2026-07-23 用户明确要求:
// 打包不得携带 API key)。所有 dotenv 文件(任意层级)一律不进包,模板除外。
export function shouldBundleEnginePath(engineSrc: string, src: string): boolean {
  const rel = relative(engineSrc, src);
  if (rel === "") return true; // 引擎根目录本身
  const top = rel.split(sep)[0];
  if (BAKUAN_ENGINE_EXCLUDE_TOP.has(top)) return false;
  const base = src.split(sep).pop() ?? "";
  if (base === ".env" || (base.startsWith(".env.") && !DOTENV_TEMPLATE.test(base))) return false;
  if (src.endsWith(".pyc") || src.endsWith(".sqlite") || src.endsWith(".json.bak")) return false;
  if (rel.split(sep).includes("__pycache__")) return false;
  return true;
}

export async function copyBakuanEngine({
  workspaceRoot,
  resourceRoot,
}: {
  workspaceRoot: string;
  resourceRoot: string;
}): Promise<void> {
  const vendorDir = join(resourcesRoot, "..", "vendor");
  const engineSrc = join(workspaceRoot, "bakuan-engine");
  // Python 运行时与 ffmpeg 走 **opaque tar.gz**（不是散落的 Mach-O + 符号链接树）：
  // mac 打包收尾会对整包跑 `codesign --deep --strict`，而 python-build-standalone 的
  // 符号链接/未签名 .so 会让 deep 校验直接失败。压成归档后 codesign 看不进去、校验通过，
  // 首启动 provision 再解到可写数据目录（不受 app 签名封印约束）。
  const pythonRuntimeTar = join(vendorDir, "python-runtime.tar.gz");
  const ffmpegTar = join(vendorDir, "ffmpeg.tar.gz");
  const wheelsSrc = join(vendorDir, "wheels");
  const runtimeReqSrc = join(vendorDir, "requirements-runtime.txt");

  // 引擎缺失（例如上游 open-design 无此私有目录）时安静跳过，不破坏通用打包。
  if (!existsSync(engineSrc)) {
    console.warn("[tools-pack] bakuan-engine 源码缺失，短视频管线不会随安装包发布");
    return;
  }
  if (!existsSync(pythonRuntimeTar) || !existsSync(wheelsSrc)) {
    console.warn(
      "[tools-pack] 缺少 tools/pack/vendor/{python-runtime.tar.gz,wheels}——" +
        "先跑 vendor 准备脚本，否则安装包里的引擎无法 provision",
    );
    return;
  }

  await cp(engineSrc, join(resourceRoot, "bakuan-engine"), {
    recursive: true,
    filter: (src) => shouldBundleEnginePath(engineSrc, src),
  });
  await cp(pythonRuntimeTar, join(resourceRoot, "python-runtime.tar.gz"));
  await cp(wheelsSrc, join(resourceRoot, "wheels"), { recursive: true });
  if (existsSync(runtimeReqSrc)) {
    await cp(runtimeReqSrc, join(resourceRoot, "bakuan-engine", "requirements-runtime.txt"));
  }
  // 自带静态 ffmpeg/ffprobe：ASR 抽音频、yt-dlp 合流都要，装到用户机器上未必有。
  if (existsSync(ffmpegTar)) {
    await cp(ffmpegTar, join(resourceRoot, "ffmpeg.tar.gz"));
  } else {
    console.warn("[tools-pack] 缺少 tools/pack/vendor/ffmpeg.tar.gz——安装包内 ASR 抽音频会失败");
  }
}
