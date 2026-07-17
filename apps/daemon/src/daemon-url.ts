import { readdir } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import {
  OPEN_DESIGN_SIDECAR_CONTRACT,
  SIDECAR_ENV,
  SIDECAR_MESSAGES,
  type DaemonStatusSnapshot,
} from "@open-design/sidecar-proto";
import { requestJsonIpc, resolveAppIpcPath } from "@open-design/sidecar";

export const DEFAULT_DAEMON_URL = "http://127.0.0.1:7456";

export interface ResolveDaemonUrlOptions {
  /** Value passed via `--daemon-url`. Empty string is treated as unset. */
  flagUrl?: string | null;
  /** Defaults to `process.env`; injected for tests. */
  env?: NodeJS.ProcessEnv;
  /** IPC discovery timeout. Short by default so an absent daemon does not stall CLI startup. */
  timeoutMs?: number;
}

/**
 * Resolve the daemon HTTP base URL for `od` client commands.
 *
 * Spawn order: explicit `--daemon-url` flag, `OD_DAEMON_URL` env, a STATUS
 * roundtrip to the concrete sidecar IPC endpoint supplied by the lifecycle
 * owner in `OD_SIDECAR_IPC_PATH`, then a scan of the well-known IPC base for
 * any live daemon socket (zero-config discovery for plain customer shells —
 * an npm-installed `od`/`multimedia` finds the packaged desktop app's daemon
 * without any env vars). Falls back to the legacy default port last.
 */
export async function resolveDaemonUrl(
  options: ResolveDaemonUrlOptions = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const flagUrl = options.flagUrl ?? null;
  if (flagUrl != null && flagUrl.length > 0) return flagUrl;
  const envUrl = env.OD_DAEMON_URL;
  if (envUrl != null && envUrl.length > 0) return envUrl;
  const discovered = await discoverDaemonUrlFromIpc(env, options.timeoutMs ?? 800);
  if (discovered != null) return discovered;
  const scanned = await discoverDaemonUrlByScan(env, options.timeoutMs ?? 800);
  if (scanned != null) return scanned;
  return DEFAULT_DAEMON_URL;
}

async function discoverDaemonUrlFromIpc(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  const socketPath = env[SIDECAR_ENV.IPC_PATH];
  if (socketPath == null || socketPath.length === 0) return null;
  return await probeDaemonSocket(socketPath, timeoutMs);
}

async function probeDaemonSocket(socketPath: string, timeoutMs: number): Promise<string | null> {
  try {
    const status = await requestJsonIpc<DaemonStatusSnapshot>(
      socketPath,
      { type: SIDECAR_MESSAGES.STATUS },
      { timeoutMs },
    );
    return status?.url ?? null;
  } catch {
    return null;
  }
}

/**
 * Enumerate candidate daemon IPC endpoints across all namespaces under the
 * well-known IPC base (POSIX: `<ipcBase>/<namespace>/daemon.sock`; Windows:
 * `\\.\pipe\<prefix>-<namespace>-daemon`, enumerated via the pipe
 * filesystem). `default` (local dev) sorts first so a dev daemon wins over a
 * concurrently running packaged app on contributor machines; customer
 * machines only ever have the packaged namespace.
 */
export async function listDaemonIpcCandidates(
  env: NodeJS.ProcessEnv = process.env,
): Promise<string[]> {
  const contract = OPEN_DESIGN_SIDECAR_CONTRACT;
  if (process.platform === "win32") {
    const prefix = `${contract.defaults.windowsPipePrefix}-`;
    try {
      const names = await readdir("\\\\.\\pipe\\");
      return names
        .filter((name) => name.startsWith(prefix) && name.endsWith("-daemon"))
        .sort()
        .map((name) => `\\\\.\\pipe\\${name}`);
    } catch {
      return [];
    }
  }
  const base = resolvePath(env[SIDECAR_ENV.IPC_BASE] ?? contract.defaults.ipcBase);
  try {
    const entries = await readdir(base, { withFileTypes: true });
    const namespaces = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    namespaces.sort((a, b) =>
      a === contract.defaults.namespace ? -1 : b === contract.defaults.namespace ? 1 : a.localeCompare(b),
    );
    return namespaces.map((namespace) =>
      resolveAppIpcPath({ app: "daemon", contract, env, namespace }),
    );
  } catch {
    return [];
  }
}

async function discoverDaemonUrlByScan(
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  // Serial probe with a short per-socket budget: candidate counts are tiny
  // (one per namespace) and dead sockets reject fast on connect.
  const perSocketTimeout = Math.min(timeoutMs, 500);
  for (const socketPath of await listDaemonIpcCandidates(env)) {
    const url = await probeDaemonSocket(socketPath, perSocketTimeout);
    if (url != null) return url;
  }
  return null;
}
