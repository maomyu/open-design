// Daemon-backed app preferences (onboarding state, agent/skill/DS selection).
//
// The web frontend pushes preferences here via PUT /api/app-config; the
// daemon persists them to <dataDir>/app-config.json (where dataDir defaults
// to <projectRoot>/.od but follows OD_DATA_DIR when set, keeping test and
// multi-namespace runs isolated). This survives browser storage resets and
// origin changes so onboarding and agent selection don't reappear unexpectedly.
//
// `agentCliEnv` is intentionally limited by allowlist below. It may include
// proxy/auth overrides for local CLIs (for example ANTHROPIC_BASE_URL +
// ANTHROPIC_API_KEY for Claude Code, or OPENAI_BASE_URL + OPENAI_API_KEY for
// Codex). Those values are local-only and should not be logged or returned
// outside this machine.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import path from 'node:path';

import {
  readInstallationFile,
  resolveInstallationDir,
  writeInstallationFile,
  type InstallationFilePatch,
} from './installation.js';

// Plugin-system env knobs. See docs/plans/plugins-implementation.md F6 / F9.
// Phase 1 only reads them; the GC worker that enforces snapshot expiry lands
// in Phase 5. Centralized here to keep daemon modules from sprinkling magic
// numbers across the codebase.
export interface PluginEnvKnobs {
  // Hard ceiling on devloop iterations per stage (spec §10.2).
  maxDevloopIterations: number;
  // Days before an unreferenced applied_plugin_snapshots row expires. A
  // value of 0 means "keep forever" (operators can opt out of GC entirely).
  snapshotUnreferencedTtlDays: number;
  // Optional cap on how long even a referenced snapshot stays around once
  // its run/conversation/project is terminal. Default unset -> unlimited.
  snapshotRetentionDays: number | null;
  // GC worker tick interval. Phase 5 reads this; Phase 1 just exposes the
  // knob through `od config get` so operators can plan ahead.
  snapshotGcIntervalMs: number;
}

function intFromEnv(key: string, fallback: number): number {
  const raw = process.env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return fallback;
  return Math.floor(parsed);
}

function nullableIntFromEnv(key: string): number | null {
  const raw = process.env[key];
  if (typeof raw !== 'string' || raw.trim().length === 0) return null;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  return Math.floor(parsed);
}

export function readPluginEnvKnobs(): PluginEnvKnobs {
  return {
    maxDevloopIterations:        intFromEnv('OD_MAX_DEVLOOP_ITERATIONS', 10),
    snapshotUnreferencedTtlDays: intFromEnv('OD_SNAPSHOT_UNREFERENCED_TTL_DAYS', 30),
    snapshotRetentionDays:       nullableIntFromEnv('OD_SNAPSHOT_RETENTION_DAYS'),
    snapshotGcIntervalMs:        intFromEnv('OD_SNAPSHOT_GC_INTERVAL_MS', 6 * 60 * 60 * 1000),
  };
}

export interface AgentModelPrefs {
  model?: string;
  reasoning?: string;
}

export type AgentCliEnvPrefs = Record<string, Record<string, string>>;

export interface TelemetryPrefs {
  metrics?: boolean;
  content?: boolean;
  artifactManifest?: boolean;
}

export interface OrbitConfigPrefs {
  enabled: boolean;
  time: string;
  templateSkillId?: string | null;
}

export interface AppConfigPrefs {
  onboardingCompleted?: boolean;
  agentId?: string | null;
  agentModels?: Record<string, AgentModelPrefs>;
  agentCliEnv?: AgentCliEnvPrefs;
  skillId?: string | null;
  designSystemId?: string | null;
  disabledSkills?: string[];
  disabledDesignSystems?: string[];
  installationId?: string | null;
  telemetry?: TelemetryPrefs;
  privacyDecisionAt?: number | null;
  orbit?: OrbitConfigPrefs;
  customInstructions?: string | null;
  // 爆创·自媒体定制：客户自己的飞书多维表格「数据中心」地址。装机时由客户填自己的
  // base 链接,爆创用内置浏览器打开(客户在内置浏览器登录自己的飞书,登录态长期保持),
  // 数据/审核/复盘都在客户自己账户名下。空则「飞书数据中心」入口引导去填。
  feishuBitableUrl?: string | null;
  // Locally stored third-party service API keys (e.g. TIKHUB_API_KEY for
  // trending-topic scraping). Injected into spawned agent child processes
  // as environment variables, with lower precedence than the per-agent
  // `agentCliEnv` entries above. Like `agentCliEnv`, these values are
  // local-only secrets: never log them and never return them outside
  // this machine.
  thirdPartyApiKeys?: Record<string, string>;
  // Per-plugin config values: `{ [pluginId]: { [KEY]: value } }`. A plugin
  // declares the keys it needs via `od.config`; the operator fills values in
  // the plugin editor. The daemon injects a plugin's own map into THAT
  // plugin's runs only, at higher precedence than global thirdPartyApiKeys.
  // Same secret discipline: never log, never return off-machine.
  pluginConfig?: Record<string, Record<string, string>>;
  // LEGACY (pre-platform) per-plugin account profiles. Superseded by
  // `platformAccounts` — accounts belong to platforms, not plugins, so the
  // same 抖音号 serves every plugin targeting 抖音. Kept only so
  // `platformAccountsForPlatform` can merge old wechat-mp-publish rows in at
  // read time; new writes go to platformAccounts.
  pluginAccounts?: Record<string, PluginAccountRecord[]>;
  // PLATFORM-level account profiles: `{ [platformId]: PluginAccountRecord[] }`
  // keyed by MediaPlatformId (wechat-mp/douyin/…). Each account carries its own
  // writing persona and (api-credential platforms) its own credentials; for
  // sau-login platforms the account NAME doubles as the sau `--account` cookie
  // profile. Same secret discipline as pluginConfig: never log, never return
  // off-machine.
  platformAccounts?: Record<string, PluginAccountRecord[]>;
}

// One account profile for a plugin. `credentials` holds the plugin's declared
// per-account secret keys (e.g. WECHAT_APPID/SECRET). `style` is the writing
// persona injected into the run (persona text + optional reference samples).
export interface PluginAccountRecord {
  id: string;
  name: string;
  style?: { persona?: string; samples?: string[] };
  credentials?: Record<string, string>;
}

const ALLOWED_KEYS: ReadonlySet<keyof AppConfigPrefs> = new Set([
  'onboardingCompleted',
  'agentId',
  'agentModels',
  'agentCliEnv',
  'skillId',
  'designSystemId',
  'disabledSkills',
  'disabledDesignSystems',
  'installationId',
  'telemetry',
  'privacyDecisionAt',
  'orbit',
  'customInstructions',
  'feishuBitableUrl',
  'thirdPartyApiKeys',
  'pluginConfig',
  'pluginAccounts',
  'platformAccounts',
] as const);

function configFile(dataDir: string): string {
  return path.join(dataDir, 'app-config.json');
}

const AGENT_MODEL_KEYS: ReadonlySet<string> = new Set(['model', 'reasoning']);

const TELEMETRY_KEYS: ReadonlySet<string> = new Set([
  'metrics',
  'content',
  'artifactManifest',
]);

function validateTelemetry(raw: unknown): TelemetryPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, boolean> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (!TELEMETRY_KEYS.has(k)) continue;
    if (typeof v === 'boolean') result[k] = v;
  }
  return Object.keys(result).length > 0 ? (result as TelemetryPrefs) : undefined;
}

const AGENT_CLI_ENV_KEYS: ReadonlyMap<string, ReadonlySet<string>> = new Map([
  ['amr', new Set([
    'VELA_BIN',
    'VELA_LINK_URL',
    'VELA_RUNTIME_KEY',
    'VELA_OPENCODE_BIN',
    'OPEN_DESIGN_AMR_PROFILE',
    'OPENCODE_TEST_HOME',
  ])],
  ['aider', new Set(['AIDER_BIN'])],
  ['claude', new Set(['CLAUDE_CONFIG_DIR', 'CLAUDE_BIN', 'ANTHROPIC_BASE_URL', 'ANTHROPIC_API_KEY'])],
  ['codex', new Set(['CODEX_HOME', 'CODEX_BIN', 'OPENAI_BASE_URL', 'CODEX_API_KEY', 'OPENAI_API_KEY'])],
  ['copilot', new Set(['COPILOT_BIN'])],
  ['cursor-agent', new Set(['CURSOR_AGENT_BIN'])],
  ['deepseek', new Set(['DEEPSEEK_BIN'])],
  ['devin', new Set(['DEVIN_BIN'])],
  ['gemini', new Set(['GEMINI_BIN'])],
  ['hermes', new Set(['HERMES_BIN'])],
  ['kimi', new Set(['KIMI_BIN'])],
  ['kiro', new Set(['KIRO_BIN'])],
  ['kilo', new Set(['KILO_BIN'])],
  ['opencode', new Set(['OPENCODE_BIN'])],
  ['pi', new Set(['PI_BIN'])],
  ['qoder', new Set(['QODER_BIN'])],
  ['qwen', new Set(['QWEN_BIN'])],
  ['trae-cli', new Set(['TRAE_CLI_BIN'])],
  ['vibe', new Set(['VIBE_BIN'])],
]);

function isValidAgentModelEntry(v: unknown): v is AgentModelPrefs {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  const obj = v as Record<string, unknown>;
  for (const k of Object.keys(obj)) {
    if (!AGENT_MODEL_KEYS.has(k)) return false;
    if (obj[k] !== undefined && typeof obj[k] !== 'string') return false;
  }
  return true;
}

function validateAgentModels(
  raw: unknown,
): Record<string, AgentModelPrefs> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, AgentModelPrefs> = Object.create(null);
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (k === '__proto__' || k === 'constructor') continue;
    if (isValidAgentModelEntry(v)) {
      result[k] = v;
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export function validateAgentCliEnv(raw: unknown): AgentCliEnvPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: AgentCliEnvPrefs = Object.create(null);
  for (const [agentId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (agentId === '__proto__' || agentId === 'constructor') continue;
    const allowed = AGENT_CLI_ENV_KEYS.get(agentId);
    if (!allowed || typeof value !== 'object' || value === null || Array.isArray(value)) {
      continue;
    }
    const env: Record<string, string> = Object.create(null);
    for (const [envKey, envValue] of Object.entries(value as Record<string, unknown>)) {
      if (!allowed.has(envKey)) continue;
      if (typeof envValue !== 'string') continue;
      const trimmed = envValue.trim();
      if (!trimmed) continue;
      env[envKey] = trimmed;
    }
    if (Object.keys(env).length > 0) result[agentId] = env;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Env-var-shaped key names only: uppercase letters, digits, underscores,
// starting with a letter (e.g. TIKHUB_API_KEY). Anything else is dropped
// silently — these entries are spread into child process env, so a loose
// key shape would let arbitrary env names through.
const THIRD_PARTY_API_KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

export function validateThirdPartyApiKeys(
  raw: unknown,
): Record<string, string> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key === '__proto__' || key === 'constructor') continue;
    if (!THIRD_PARTY_API_KEY_NAME.test(key)) continue;
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (!trimmed) continue;
    result[key] = trimmed;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Per-plugin config: a map of pluginId -> { ENV_KEY: value }. Each inner map is
// validated with the same env-var key shape as thirdPartyApiKeys (the values
// get spread into a child process env at run time). Plugin ids are kept loose
// (any non-prototype string) but values must be strings; empty maps are
// dropped so a cleared plugin disappears entirely.
export function validatePluginConfig(
  raw: unknown,
): Record<string, Record<string, string>> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, Record<string, string>> = Object.create(null);
  for (const [pluginId, inner] of Object.entries(raw as Record<string, unknown>)) {
    if (pluginId === '__proto__' || pluginId === 'constructor') continue;
    if (typeof pluginId !== 'string' || !pluginId.trim()) continue;
    const validated = validateThirdPartyApiKeys(inner);
    if (validated) result[pluginId] = validated;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Env map to inject for a given plugin's run (validated on the way out).
export function pluginConfigEnvForPlugin(
  prefs: AppConfigPrefs,
  pluginId: string | null | undefined,
): Record<string, string> {
  if (!pluginId) return {};
  const all = validatePluginConfig(prefs.pluginConfig);
  return all?.[pluginId] ? { ...all[pluginId] } : {};
}

const ACCOUNT_ID = /^[a-z0-9][a-z0-9._-]*$/i;

// Validate the stored account map `{ [pluginId]: PluginAccountRecord[] }`,
// dropping malformed profiles. Credentials/persona/samples are coerced to safe
// shapes; unnamed or bad-id profiles are skipped.
export function validatePluginAccounts(
  raw: unknown,
): Record<string, PluginAccountRecord[]> | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const result: Record<string, PluginAccountRecord[]> = Object.create(null);
  for (const [pluginId, list] of Object.entries(raw as Record<string, unknown>)) {
    if (pluginId === '__proto__' || pluginId === 'constructor') continue;
    if (typeof pluginId !== 'string' || !pluginId.trim() || !Array.isArray(list)) continue;
    const accounts: PluginAccountRecord[] = [];
    const seen = new Set<string>();
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const o = item as Record<string, unknown>;
      const id = typeof o.id === 'string' ? o.id.trim() : '';
      const name = typeof o.name === 'string' ? o.name.trim() : '';
      if (!ACCOUNT_ID.test(id) || !name || seen.has(id)) continue;
      seen.add(id);
      const rec: PluginAccountRecord = { id, name };
      const style = o.style && typeof o.style === 'object' && !Array.isArray(o.style)
        ? (o.style as Record<string, unknown>)
        : null;
      if (style) {
        const persona = typeof style.persona === 'string' ? style.persona : undefined;
        const samples = Array.isArray(style.samples)
          ? style.samples.filter((s): s is string => typeof s === 'string' && s.trim().length > 0)
          : undefined;
        const s: { persona?: string; samples?: string[] } = {};
        if (persona && persona.trim()) s.persona = persona;
        if (samples && samples.length > 0) s.samples = samples;
        if (Object.keys(s).length > 0) rec.style = s;
      }
      const creds = validateThirdPartyApiKeys(o.credentials);
      if (creds) rec.credentials = creds;
      accounts.push(rec);
    }
    if (accounts.length > 0) result[pluginId] = accounts;
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

// Legacy plugin-id → platform mapping for the read-time migration below. Only
// wechat-mp-publish ever stored per-plugin accounts before the platform pivot.
const LEGACY_PLUGIN_PLATFORM: Record<string, string> = {
  'wechat-mp-publish': 'wechat-mp',
};

// The account profiles configured for a PLATFORM (validated, secrets included
// — callers decide what to expose vs inject). Read-time migration: legacy
// per-plugin rows (pluginAccounts) are merged in for their mapped platform so
// pre-pivot 公众号 accounts keep working without a data rewrite; platform rows
// win on id collision.
export function platformAccountsForPlatform(
  prefs: AppConfigPrefs,
  platformId: string | null | undefined,
): PluginAccountRecord[] {
  if (!platformId) return [];
  const platform = validatePluginAccounts(prefs.platformAccounts)?.[platformId] ?? [];
  const out = platform.map((a) => ({ ...a }));
  const seen = new Set(out.map((a) => a.id));
  const legacyPluginId = Object.entries(LEGACY_PLUGIN_PLATFORM)
    .find(([, p]) => p === platformId)?.[0];
  if (legacyPluginId) {
    const legacy = validatePluginAccounts(prefs.pluginAccounts)?.[legacyPluginId] ?? [];
    for (const a of legacy) {
      if (!seen.has(a.id)) out.push({ ...a });
    }
  }
  return out;
}

// Which PLATFORM a plugin's accounts belong to (`od.accounts.platform`).
// Null when the plugin declares no account support.
export function accountPlatformFromManifest(manifest: unknown): string | null {
  const od = (manifest as { od?: { accounts?: { platform?: unknown } } } | undefined)?.od;
  const platform = od?.accounts?.platform;
  return typeof platform === 'string' && platform.trim() ? platform.trim() : null;
}

// The credential keys a plugin declares as PER-ACCOUNT (`od.accounts.
// credentialKeys`). These keys obey the exclusive-injection rule below: their
// ONLY legitimate source is the chosen account profile — plugin-level config
// values and the workbench `.env` fallback are stripped for them.
export function accountCredentialKeysFromManifest(manifest: unknown): string[] {
  const raw = (manifest as { od?: { accounts?: { credentialKeys?: unknown } } } | undefined)
    ?.od?.accounts?.credentialKeys;
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k === 'string' && k.trim() && !out.includes(k)) out.push(k);
  }
  return out;
}

// Enforce the EXCLUSIVE source rule for per-account credential keys on a run's
// merged env: every declared credential key is first stripped (whatever
// plugin-level config or the workbench `.env` contributed), then ONLY the
// chosen account's values are laid back in. Returns a new object.
export function applyExclusiveCredentialRule(
  merged: Record<string, string>,
  credentialKeys: string[],
  accountEnv: Record<string, string>,
): Record<string, string> {
  if (credentialKeys.length === 0) return { ...merged };
  const out = { ...merged };
  for (const key of credentialKeys) delete out[key];
  return { ...out, ...accountEnv };
}

// Resolve the CHOSEN account's credentials for a run — the deterministic core
// of the multi-account safety invariant ("发错号物理不可能"). Semantics:
//   - `accountName` set → exact-name match. Zero or 2+ matches (legacy
//     duplicate-name data) → resolve NOTHING and log loudly; we never guess
//     which 公众号 to publish to.
//   - `accountName` empty → exactly one configured account uses it; otherwise
//     resolve nothing (the composer/apply gate should have forced a pick).
//   - Only keys present on the account are returned; a missing key is ABSENT,
//     never filled from plugin-level defaults — the publish script failing on
//     a missing env var is the intended loud failure.
// Secret values — never log.
export function resolvePlatformAccountCredentials(
  prefs: AppConfigPrefs,
  platformId: string | null | undefined,
  accountName: string | null | undefined,
  credentialKeys: string[],
): Record<string, string> {
  if (credentialKeys.length === 0) return {};
  const accounts = platformAccountsForPlatform(prefs, platformId);
  let chosen: PluginAccountRecord | null = null;
  const wanted = typeof accountName === 'string' ? accountName.trim() : '';
  if (wanted) {
    const matches = accounts.filter((a) => a.name === wanted);
    if (matches.length === 1) {
      chosen = matches[0]!;
    } else {
      console.warn(
        `[platform-accounts] account "${wanted}" on platform ${platformId} resolved to ${matches.length} profiles; refusing to inject credentials`,
      );
      return {};
    }
  } else if (accounts.length === 1) {
    chosen = accounts[0]!;
  } else {
    return {};
  }
  const out: Record<string, string> = {};
  for (const key of credentialKeys) {
    const value = chosen.credentials?.[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

function isValidOrbitTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  if (!match) return false;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  return hours >= 0 && hours <= 23 && minutes >= 0 && minutes <= 59;
}

function validateOrbit(raw: unknown): OrbitConfigPrefs | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const obj = raw as Record<string, unknown>;
  const enabled = typeof obj.enabled === 'boolean' ? obj.enabled : false;
  const time = typeof obj.time === 'string' && isValidOrbitTime(obj.time)
    ? obj.time
    : '08:00';
  const orbit: OrbitConfigPrefs = { enabled, time };

  if (Object.hasOwn(obj, 'templateSkillId')) {
    orbit.templateSkillId = typeof obj.templateSkillId === 'string' && obj.templateSkillId.trim()
      ? obj.templateSkillId.trim()
      : null;
  }

  return orbit;
}

export function agentCliEnvForAgent(
  prefs: AgentCliEnvPrefs | undefined,
  agentId: string,
): Record<string, string> {
  if (!prefs || typeof agentId !== 'string') return {};
  const env = prefs[agentId];
  if (!env || typeof env !== 'object' || Array.isArray(env)) return {};
  return { ...env };
}

// Compose the configured env map injected into a spawned agent child:
// global third-party service keys first (e.g. TIKHUB_API_KEY for the
// short-video trending scraper), then the per-agent `agentCliEnv` so an
// agent-scoped value wins on a name collision. The stored values are
// re-validated on the way out so a hand-edited app-config.json cannot
// smuggle non-env-shaped keys into the child process environment.
// Reminder: these are local-only secrets — never log them and never
// return them outside this machine.
export function configuredEnvForAgentSpawn(
  prefs: AppConfigPrefs,
  agentId: string,
): Record<string, string> {
  return {
    ...(validateThirdPartyApiKeys(prefs.thirdPartyApiKeys) ?? {}),
    ...agentCliEnvForAgent(prefs.agentCliEnv, agentId),
  };
}

function applyConfigValue(
  target: Record<string, unknown>,
  key: keyof AppConfigPrefs,
  value: unknown,
): void {
  if (key === 'feishuBitableUrl') {
    if (typeof value === 'string') {
      target[key] = value.slice(0, 2000);
    } else if (value === null) {
      target[key] = value;
    }
    return;
  }
  if (key === 'onboardingCompleted') {
    if (typeof value === 'boolean') target[key] = value;
    return;
  }
  if (key === 'agentId' || key === 'skillId' || key === 'designSystemId') {
    if (typeof value === 'string' || value === null) target[key] = value;
    return;
  }
  if (key === 'agentModels') {
    const validated = validateAgentModels(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'agentCliEnv') {
    const validated = validateAgentCliEnv(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'disabledSkills' || key === 'disabledDesignSystems') {
    if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      target[key] = value;
    } else {
      delete target[key];
    }
  }
  if (key === 'installationId') {
    if (typeof value === 'string' || value === null) target[key] = value;
    return;
  }
  if (key === 'telemetry') {
    const validated = validateTelemetry(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'privacyDecisionAt') {
    if (
      value === null ||
      (typeof value === 'number' && Number.isFinite(value) && value >= 0)
    ) {
      target[key] = value;
    } else {
      delete target[key];
    }
    return;
  }
  if (key === 'orbit') {
    const validated = validateOrbit(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
  }
  if (key === 'customInstructions') {
    if (typeof value === 'string') {
      target[key] = value.slice(0, 5000);
    } else if (value === null) {
      target[key] = value;
    }
    return;
  }
  if (key === 'thirdPartyApiKeys') {
    const validated = validateThirdPartyApiKeys(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      // `null` / `{}` / all-invalid payloads clear the stored map — same
      // deletion semantics as agentCliEnv above.
      delete target[key];
    }
    return;
  }
  if (key === 'pluginConfig') {
    const validated = validatePluginConfig(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
    return;
  }
  if (key === 'pluginAccounts' || key === 'platformAccounts') {
    const validated = validatePluginAccounts(value);
    if (validated !== undefined) {
      target[key] = validated;
    } else {
      delete target[key];
    }
    return;
  }
}

function filterAllowedKeys(obj: Record<string, unknown>): AppConfigPrefs {
  const result: Record<string, unknown> = Object.create(null);
  for (const key of Object.keys(obj)) {
    if (ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) {
      applyConfigValue(result, key as keyof AppConfigPrefs, obj[key]);
    }
  }
  return result as AppConfigPrefs;
}

// Fill in telemetry defaults when the saved config has no `telemetry`
// field at all (fresh install, pre-disclosure). `metrics` / `content`
// default to true so onboarding-funnel events emit from the first
// render — without these defaults the gate at
// `analytics.ts` (`if (cfg.telemetry?.metrics !== true) return`)
// dropped every event a user fired before the post-onboarding
// disclosure modal had a chance to set them. An EXPLICIT `false`
// the user previously saved is preserved (only `undefined` gets
// the new default), so opt-out users stay opted out across the
// 0.7.x → 0.8.0 upgrade.
function applyTelemetryDefaults(prefs: AppConfigPrefs): AppConfigPrefs {
  if (prefs.telemetry === undefined) {
    return {
      ...prefs,
      telemetry: { metrics: true, content: true, artifactManifest: false },
    };
  }
  return prefs;
}

export async function readAppConfig(dataDir: string): Promise<AppConfigPrefs> {
  const base = await readAppConfigFileOnly(dataDir);
  // Channel-root installation file is the new authoritative source for the
  // identity bits that must survive a namespace-scoped data-dir wipe. It
  // lives outside `<namespace>/data/` so a reinstall of the same channel
  // (which might churn the namespace token, or eventually clear per-
  // namespace data) keeps the same id.
  //
  // Migration: when this daemon is the first to boot with installation.json
  // support and finds an existing installationId in the legacy app-config
  // path, mirror it forward exactly once so PostHog continues to see the
  // same person across the 0.7.x → 0.8.0 upgrade. Without this mirror, the
  // user count would double when 0.8.0 ships.
  const installationDir = resolveInstallationDir(dataDir);
  const installation = await readInstallationFile(installationDir);
  if (typeof installation.installationId === 'string' && installation.installationId.length > 0) {
    return applyTelemetryDefaults({ ...base, installationId: installation.installationId });
  }
  if (typeof base.installationId === 'string' && base.installationId.length > 0) {
    // Best-effort migration. A write failure here doesn't break the read —
    // we still serve the legacy id. The next write through writeAppConfig
    // will retry the mirror.
    try {
      await writeInstallationFile(installationDir, { installationId: base.installationId });
    } catch {
      // swallow — observability beats correctness on this path
    }
  }
  return applyTelemetryDefaults(base);
}

async function readAppConfigFileOnly(dataDir: string): Promise<AppConfigPrefs> {
  try {
    const raw = await readFile(configFile(dataDir), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return filterAllowedKeys(parsed as Record<string, unknown>);
    }
    console.warn('[app-config] Invalid shape in config file, returning empty');
    return {};
  } catch (err: unknown) {
    const e = err as { code?: string; name?: string; message?: string };
    if (e.code === 'ENOENT') return {};
    if (e.name === 'SyntaxError') {
      console.error('[app-config] Corrupted JSON, returning empty:', e.message);
      return {};
    }
    throw err;
  }
}

// Serialize concurrent writes to the same dataDir so the read-modify-write
// cycle doesn't lose updates when two PUT requests overlap.
const writeLocks = new Map<string, Promise<unknown>>();

export async function writeAppConfig(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const prev = writeLocks.get(dataDir) ?? Promise.resolve();
  const task = prev.catch(() => {}).then(() => doWrite(dataDir, partial));
  writeLocks.set(dataDir, task);
  try {
    return await task;
  } finally {
    if (writeLocks.get(dataDir) === task) writeLocks.delete(dataDir);
  }
}

async function doWrite(
  dataDir: string,
  partial: Record<string, unknown>,
): Promise<AppConfigPrefs> {
  const existing = await readAppConfig(dataDir);
  const next: Record<string, unknown> = { ...existing };
  for (const key of Object.keys(partial)) {
    if (!ALLOWED_KEYS.has(key as keyof AppConfigPrefs)) continue;
    applyConfigValue(next, key as keyof AppConfigPrefs, partial[key]);
  }
  const file = configFile(dataDir);
  await mkdir(path.dirname(file), { recursive: true });
  const tmp = file + '.' + randomBytes(4).toString('hex') + '.tmp';
  await writeFile(tmp, JSON.stringify(next, null, 2), 'utf8');
  await rename(tmp, file);
  // Mirror the identity bits to the channel-root installation file so they
  // survive a namespace-scoped data-dir wipe. Only fires when the caller
  // explicitly touched `installationId` (avoiding noisy writes on every
  // unrelated app-config update). A write failure here doesn't roll back
  // the app-config write — the next read merges them transparently.
  if (Object.prototype.hasOwnProperty.call(partial, 'installationId')) {
    const id = next.installationId;
    // Caller explicitly touched installationId — mirror the outcome
    // (including the clear case) to installation.json so a future read
    // doesn't keep serving the old value out of the channel-root file.
    // "Delete my data" relies on this clear path.
    const installPatch: InstallationFilePatch = {
      installationId: typeof id === 'string' && id.length > 0 ? id : null,
    };
    try {
      await writeInstallationFile(resolveInstallationDir(dataDir), installPatch);
    } catch {
      // swallow — install file mirroring is best-effort; the canonical
      // app-config write already succeeded.
    }
  }
  return next as AppConfigPrefs;
}
