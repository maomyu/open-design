import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';

// A plugin can declare `od.configEnvFile` — the path to an existing `.env` the
// user already filled (e.g. the workbench's MY-wechat-shared/.env). The daemon
// reads it so the plugin-config panel reflects those keys as "configured" AND
// injects them into the plugin's runs (scripts read os.environ; many don't
// auto-source .env). Stored per-plugin `pluginConfig` overrides these.

const ENV_KEY = /^[A-Z][A-Z0-9_]*$/;

// Expand a declared path: `~` → home, `${OD_WORKBENCH_DIR}` / `$OD_WORKBENCH_DIR`
// → the unified workbench root (default ~/.open-design/workbenches). Only an
// absolute path (after expansion) is accepted.
function resolveEnvFilePath(declared: string): string | null {
  let p = declared.trim();
  if (!p) return null;
  const wbRoot = process.env.OD_WORKBENCH_DIR && process.env.OD_WORKBENCH_DIR.trim()
    ? process.env.OD_WORKBENCH_DIR.trim()
    : path.join(os.homedir(), '.open-design', 'workbenches');
  p = p.replace(/\$\{OD_WORKBENCH_DIR\}/g, wbRoot).replace(/\$OD_WORKBENCH_DIR\b/g, wbRoot);
  if (p === '~') p = os.homedir();
  else if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  return path.isAbsolute(p) ? p : null;
}

// Read KEY=VALUE pairs from a plugin's declared `.env`. Env-var-shaped keys
// only; strips surrounding quotes and `#` comments; empty values dropped.
// Returns {} when no file is declared or it can't be read.
export function readPluginConfigEnvFile(manifest: unknown): Record<string, string> {
  const declared = (manifest as { od?: { configEnvFile?: unknown } } | undefined)?.od?.configEnvFile;
  if (typeof declared !== 'string') return {};
  const abs = resolveEnvFilePath(declared);
  if (!abs) return {};
  let text: string;
  try {
    text = readFileSync(abs, 'utf8');
  } catch {
    return {};
  }
  const out: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith('#')) continue;
    const eq = s.indexOf('=');
    if (eq <= 0) continue;
    const key = s.slice(0, eq).trim();
    if (!ENV_KEY.test(key)) continue;
    let val = s.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (val) out[key] = val;
  }
  return out;
}
