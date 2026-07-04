import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Express } from 'express';
import { resolveLocalizedText } from '@open-design/contracts';
import type {
  PluginSourceResponse,
  PluginSourceStage,
  UpdatePluginSourceResponse,
  AssistEditResponse,
  PluginConfigResponse,
  PluginConfigKeyView,
  UpdatePluginConfigResponse,
  AccountProfilesResponse,
  AccountProfileView,
  UpsertAccountProfileResponse,
  DeleteAccountProfileResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import {
  accountPlatformFromManifest,
  readAppConfig,
  writeAppConfig,
  validatePluginConfig,
  platformAccountsForPlatform,
} from './app-config.js';
import {
  accountToView,
  deletePlatformAccount,
  platformCredentialKeys,
  upsertPlatformAccount,
} from './account-routes.js';
import { readPluginConfigEnvFile } from './plugin-config-env.js';
import {
  getInstalledPlugin,
  resolvePluginFolder,
  upsertInstalledPlugin,
} from './plugins/registry.js';
import {
  listPluginVersions,
  readPluginVersion,
  recordPluginVersion,
} from './plugin-history.js';
import { callModelOnce } from './memory-llm.js';

export interface RegisterPluginEditRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

// Tolerant parse of the model's JSON output (strip ``` fences, find the object).
function parseAssistJson(
  raw: string,
): { skill?: string; query?: string; stages?: unknown } | null {
  const text = String(raw ?? '').trim();
  if (!text) return null;
  const candidates: string[] = [];
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) candidates.push(fence[1].trim());
  const brace = text.match(/\{[\s\S]*\}/);
  if (brace?.[0]) candidates.push(brace[0]);
  candidates.push(text);
  for (const c of candidates) {
    try {
      const obj = JSON.parse(c) as Record<string, unknown>;
      if (obj && typeof obj === 'object') {
        return {
          ...(typeof obj.skill === 'string' ? { skill: obj.skill } : {}),
          ...(typeof obj.query === 'string' ? { query: obj.query } : {}),
          ...(Array.isArray(obj.stages) ? { stages: obj.stages } : {}),
        };
      }
    } catch {
      /* try next */
    }
  }
  return null;
}

const STAGE_LOCALE = 'zh-CN';
const GATES = new Set(['confirm', 'choice', 'none']);
const SELECTS = new Set(['single', 'multi']);
const PICKS = new Set(['ask', 'input']);

type StageMode = PluginSourceStage['modes'][number];
type StageSubMode = NonNullable<StageMode['modes']>[number];
type StageBranch = NonNullable<PluginSourceStage['branch']>;

// A branch object present on a stage/mode marks it as an explicit fork. Resolve
// its select/pick to the editor's required shape (defaults single / ask).
// Absent → no fork (legacy flat modes), returns undefined.
function readBranch(raw: unknown): StageBranch | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const b = raw as { select?: unknown; pick?: unknown };
  const select = typeof b.select === 'string' && SELECTS.has(b.select) ? (b.select as StageBranch['select']) : 'single';
  const pick = typeof b.pick === 'string' && PICKS.has(b.pick) ? (b.pick as StageBranch['pick']) : 'ask';
  return { select, pick };
}

// Level-2 leaf options nested under a mode (e.g. "真抓热榜" → scrape methods).
function readSubModes(raw: unknown): StageSubMode[] {
  if (!Array.isArray(raw)) return [];
  const out: StageSubMode[] = [];
  for (const m of raw) {
    const mode = (m ?? {}) as { id?: unknown; label?: unknown; label_i18n?: unknown; prompt?: unknown; prompt_i18n?: unknown };
    const id = typeof mode.id === 'string' ? mode.id : '';
    if (!id) continue;
    const label =
      resolveLocalizedText(mode.label_i18n as never, STAGE_LOCALE) ||
      (typeof mode.label === 'string' ? mode.label : '') ||
      id;
    const prompt =
      resolveLocalizedText(mode.prompt_i18n as never, STAGE_LOCALE) ||
      (typeof mode.prompt === 'string' ? mode.prompt : '');
    out.push({ id, label, prompt });
  }
  return out;
}

function readModes(raw: unknown): StageMode[] {
  if (!Array.isArray(raw)) return [];
  const out: StageMode[] = [];
  for (const m of raw) {
    const mode = (m ?? {}) as { id?: unknown; label?: unknown; label_i18n?: unknown; prompt?: unknown; prompt_i18n?: unknown; branch?: unknown; modes?: unknown };
    const id = typeof mode.id === 'string' ? mode.id : '';
    if (!id) continue;
    const label =
      resolveLocalizedText(mode.label_i18n as never, STAGE_LOCALE) ||
      (typeof mode.label === 'string' ? mode.label : '') ||
      id;
    const prompt =
      resolveLocalizedText(mode.prompt_i18n as never, STAGE_LOCALE) ||
      (typeof mode.prompt === 'string' ? mode.prompt : '');
    const entry: StageMode = { id, label, prompt };
    const branch = readBranch(mode.branch);
    if (branch) entry.branch = branch;
    const sub = readSubModes(mode.modes);
    if (sub.length > 0) entry.modes = sub;
    out.push(entry);
  }
  return out;
}

// Stage-bound skill refs ↔ editor skill ids. The manifest stores
// `skills: [{ ref: '<skill-id>' }]`; the editor works with plain id strings.
function readStageSkills(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const entry of raw) {
    const id =
      typeof (entry as { ref?: unknown })?.ref === 'string'
        ? ((entry as { ref: string }).ref)
        : typeof entry === 'string'
          ? entry
          : '';
    const trimmed = id.trim();
    if (trimmed && !out.includes(trimmed)) out.push(trimmed);
  }
  return out;
}

// Flatten od.workflow.stages to the editor's view (id/title/gate/prompt/modes/skills).
function readStages(manifest: unknown): PluginSourceStage[] {
  const raw = (manifest as { od?: { workflow?: { stages?: unknown } } })?.od?.workflow?.stages;
  if (!Array.isArray(raw)) return [];
  const out: PluginSourceStage[] = [];
  for (const s of raw) {
    const stage = (s ?? {}) as { id?: unknown; title?: unknown; title_i18n?: unknown; gate?: unknown; prompt?: unknown; prompt_i18n?: unknown; branch?: unknown; modes?: unknown; skills?: unknown };
    const id = typeof stage.id === 'string' ? stage.id : '';
    if (!id) continue;
    const title =
      resolveLocalizedText(stage.title_i18n as never, STAGE_LOCALE) ||
      (typeof stage.title === 'string' ? stage.title : '') ||
      id;
    const gate =
      typeof stage.gate === 'string' && GATES.has(stage.gate)
        ? (stage.gate as PluginSourceStage['gate'])
        : 'none';
    const prompt =
      resolveLocalizedText(stage.prompt_i18n as never, STAGE_LOCALE) ||
      (typeof stage.prompt === 'string' ? stage.prompt : '');
    const branch = readBranch(stage.branch);
    out.push({ id, title, gate, prompt, ...(branch ? { branch } : {}), modes: readModes(stage.modes), skills: readStageSkills(stage.skills) });
  }
  return out;
}

function coerceSubModes(input: unknown): StageSubMode[] {
  if (!Array.isArray(input)) return [];
  const out: StageSubMode[] = [];
  for (const m of input) {
    const mode = (m ?? {}) as { id?: unknown; label?: unknown; prompt?: unknown };
    const id = typeof mode.id === 'string' ? mode.id.trim() : '';
    if (!id) continue;
    const label = typeof mode.label === 'string' && mode.label.trim() ? mode.label : id;
    const prompt = typeof mode.prompt === 'string' ? mode.prompt : '';
    out.push({ id, label, prompt });
  }
  return out;
}

function coerceModes(input: unknown): StageMode[] {
  if (!Array.isArray(input)) return [];
  const out: StageMode[] = [];
  for (const m of input) {
    const mode = (m ?? {}) as { id?: unknown; label?: unknown; prompt?: unknown; branch?: unknown; modes?: unknown };
    const id = typeof mode.id === 'string' ? mode.id.trim() : '';
    if (!id) continue;
    const label = typeof mode.label === 'string' && mode.label.trim() ? mode.label : id;
    const prompt = typeof mode.prompt === 'string' ? mode.prompt : '';
    const entry: StageMode = { id, label, prompt };
    const branch = readBranch(mode.branch);
    if (branch) entry.branch = branch;
    const sub = coerceSubModes(mode.modes);
    if (sub.length > 0) entry.modes = sub;
    out.push(entry);
  }
  return out;
}

export interface DerivedInputField {
  name: string;
  label: string;
  type: 'string';
}

// Derive fillable input fields from a query's `{{placeholders}}`. A plugin
// authored via the editor / AI draft carries `{{topic}}` etc. in its kickoff
// query but no `od.inputs`, so the composer can't render those placeholders as
// fillable slots (no field to bind). This returns a string field for every
// placeholder NOT already declared, so callers can append them and the picker's
// "Use"-style echo lights up. Order follows first appearance in the query.
export function deriveInputsFromQuery(
  query: string,
  existing?: ReadonlyArray<{ name?: unknown }> | null,
): DerivedInputField[] {
  const declared = new Set(
    (Array.isArray(existing) ? existing : [])
      .map((f) => (typeof f?.name === 'string' ? f.name : ''))
      .filter(Boolean),
  );
  const re = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;
  const out: DerivedInputField[] = [];
  const seen = new Set<string>();
  let m: RegExpExecArray | null;
  while ((m = re.exec(query)) !== null) {
    const name = m[1];
    if (!name || declared.has(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, label: name, type: 'string' });
  }
  return out;
}

// Coerce an incoming editor stages array to clean entries. Shared with the
// plugin draft routes (create flow), which accept the same editor shape.
export function coerceStages(input: unknown): PluginSourceStage[] | null {
  if (!Array.isArray(input)) return null;
  const out: PluginSourceStage[] = [];
  for (const s of input) {
    const stage = (s ?? {}) as { id?: unknown; title?: unknown; gate?: unknown; prompt?: unknown; branch?: unknown; modes?: unknown; skills?: unknown };
    const id = typeof stage.id === 'string' ? stage.id.trim() : '';
    if (!id) continue;
    const title = typeof stage.title === 'string' && stage.title.trim() ? stage.title : id;
    const gate =
      typeof stage.gate === 'string' && GATES.has(stage.gate)
        ? (stage.gate as PluginSourceStage['gate'])
        : 'none';
    const prompt = typeof stage.prompt === 'string' ? stage.prompt : '';
    const branch = readBranch(stage.branch);
    out.push({ id, title, gate, prompt, ...(branch ? { branch } : {}), modes: coerceModes(stage.modes), skills: readStageSkills(stage.skills) });
  }
  return out;
}

// Write a localized-or-plain text field back: if the existing value is a
// localized map, update the operator's locale; otherwise set a plain string.
function writeLocalized(obj: Record<string, unknown>, key: string, value: string): void {
  const existing = obj[key];
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    (existing as Record<string, string>)[STAGE_LOCALE] = value;
  } else {
    obj[key] = value;
  }
}

// Write (or clear) a node's `branch` fork, preserving any passthrough keys on
// an existing branch object. Absent branch → delete, so a node reverts to
// legacy flat modes.
function writeBranch(obj: Record<string, unknown>, branch: StageBranch | undefined): void {
  if (!branch) {
    delete obj.branch;
    return;
  }
  const prev =
    obj.branch && typeof obj.branch === 'object' && !Array.isArray(obj.branch)
      ? (obj.branch as Record<string, unknown>)
      : {};
  obj.branch = { ...prev, select: branch.select, pick: branch.pick };
}

// Merge edited stages back into the manifest, preserving each stage's (and
// mode's) passthrough fields by id while applying the new order, titles,
// gates, prompts, and modes. Incoming order is authoritative.
function mergeStagesIntoManifest(
  json: { od?: { workflow?: { stages?: unknown } } },
  edited: PluginSourceStage[],
): void {
  const prev = Array.isArray(json.od?.workflow?.stages)
    ? (json.od!.workflow!.stages as Array<Record<string, unknown>>)
    : [];
  const prevById = new Map(prev.map((s) => [String(s.id ?? ''), s] as const));
  const next = edited.map((stage) => {
    const base = { ...(prevById.get(stage.id) ?? {}) };
    base.id = stage.id;
    writeLocalized(base, 'title', stage.title);
    base.gate = stage.gate;
    writeLocalized(base, 'prompt', stage.prompt);
    writeBranch(base, stage.branch);
    if (stage.modes.length > 0) {
      const prevModes = Array.isArray(base.modes) ? (base.modes as Array<Record<string, unknown>>) : [];
      const prevModeById = new Map(prevModes.map((m) => [String(m.id ?? ''), m] as const));
      base.modes = stage.modes.map((mode) => {
        const mbase = { ...(prevModeById.get(mode.id) ?? {}) };
        mbase.id = mode.id;
        writeLocalized(mbase, 'label', mode.label);
        writeLocalized(mbase, 'prompt', mode.prompt);
        writeBranch(mbase, mode.branch);
        // Level-2 submodes (e.g. "真抓热榜" → scrape methods). Preserve each
        // submode's passthrough fields by id; absent → clear.
        if (mode.modes && mode.modes.length > 0) {
          const prevSub = Array.isArray(mbase.modes) ? (mbase.modes as Array<Record<string, unknown>>) : [];
          const prevSubById = new Map(prevSub.map((m) => [String(m.id ?? ''), m] as const));
          mbase.modes = mode.modes.map((sub) => {
            const sbase = { ...(prevSubById.get(sub.id) ?? {}) };
            sbase.id = sub.id;
            writeLocalized(sbase, 'label', sub.label);
            writeLocalized(sbase, 'prompt', sub.prompt);
            return sbase;
          });
        } else {
          delete mbase.modes;
        }
        return mbase;
      });
    } else {
      delete base.modes;
    }
    // Stage-bound skills: editor ids → manifest refs. Incoming list is
    // authoritative; an empty list clears the binding.
    if (Array.isArray(stage.skills) && stage.skills.length > 0) {
      base.skills = stage.skills.map((skillId) => ({ ref: skillId }));
    } else {
      delete base.skills;
    }
    return base;
  });
  json.od = json.od ?? {};
  json.od.workflow = json.od.workflow ?? {};
  (json.od.workflow as { stages?: unknown }).stages = next;
}

const ASSIST_SYSTEM_PROMPT =
  '你在帮用户编辑一个 AI 插件的提示词。根据用户的「修改指令」，改写下面的内容。\n' +
  '- `skill` 是插件的全局方法论（SKILL.md，markdown：开场、看板规则、通用规范），`query` 是用户选用插件时填进对话框的开场指令。\n' +
  '- `stages` 是工作流步骤，每个步骤有：id（稳定标识，英文小写短横线）、title（显示名）、gate（"confirm" 需人工确认 / "choice" 让用户选 / "none" 不卡）、**prompt（这一步自己的提示词——决定该步产出的效果和风格，是最重要的字段）**、modes（可选，按运行时模式分的独立提示词槽，每个有 id/label/prompt，比如选题步分「AI 建议」和「真抓热榜」两种）。\n' +
  '- 步骤或某个 mode 可选带 `branch`={"select":"single|multi","pick":"ask|input"}，表示它下面的 modes 是「并列可选项」：select=single 单选一种、multi 可多选（多选时每种各跑一遍合并）；pick=ask 运行时用 AskUserQuestion 问用户、input 按输入值自动选。带 branch 的 mode 还能有自己的嵌套 `modes`（第二层子选项，最多两层），比如「真抓热榜」下再挂 bb-browser / gstack / TikHub 等抓取方式。\n' +
  '- 关键：用户说「改某一步」时，重点改那一步的 `prompt`（或对应 mode 的 prompt）。增删/改名/重排步骤时让 stages 与 skill、query 保持一致。**已有的 branch、嵌套 modes、skills 等字段没被要求改就原样保留、别丢**。\n' +
  '- query 里形如 {{platform}} 的占位必须原样保留。\n' +
  '- 严格只返回一个 JSON 对象：{"skill":"<完整 SKILL.md>","query":"<完整 query>","stages":[{"id":"...","title":"...","gate":"confirm|choice|none","prompt":"<该步提示词>","branch":{"select":"single|multi","pick":"ask|input"},"modes":[{"id":"...","label":"...","prompt":"<该模式提示词>","branch":{...},"modes":[{"id":"...","label":"...","prompt":"..."}]}]}]}。branch 与嵌套 modes 可省略；不要任何解释、不要代码围栏以外的文字。';

/**
 * Direct plugin editing. The plugin IS the asset: its prompts are files
 * (SKILL.md body + the kickoff query in open-design.json). The operator edits
 * them in place, then we re-register the folder so the next run picks up the
 * change ("发布"). SKILL.md is read fresh at prompt-compose time, so its edits
 * are live immediately; manifest edits (query/workflow) need the re-register.
 *
 *   GET /api/plugins/:id/source  — read the editable prompts
 *   PUT /api/plugins/:id/source  — write + re-register
 */
// Build the editable-source view for a plugin record (shared by GET /source
// and the rollback response).
async function readPluginSourceView(
  plugin: { fsPath: string; sourceKind?: string; manifest?: unknown },
  id: string,
): Promise<PluginSourceResponse> {
  let skill = '';
  try {
    skill = await fsp.readFile(path.join(plugin.fsPath, 'SKILL.md'), 'utf8');
  } catch {
    skill = '';
  }
  const q = (plugin.manifest as { od?: { useCase?: { query?: unknown } } } | undefined)?.od?.useCase?.query;
  const query = resolveLocalizedText(q as never, STAGE_LOCALE) || (typeof q === 'string' ? q : '');
  const stages = readStages(plugin.manifest);
  const editable = plugin.sourceKind === 'bundled' || plugin.sourceKind === 'user';
  return { id, skill, query, stages, editable };
}

const CONFIG_KEY_NAME = /^[A-Z][A-Z0-9_]*$/;

interface DeclaredConfigKey {
  name: string;
  label?: string;
  description?: string;
  required?: boolean;
  secret: boolean;
  link?: string;
}

// Read the config keys a plugin DECLARES it needs (`od.config`). Secret defaults
// to true (mask in the editor). Malformed / non-env-shaped / duplicate names are
// dropped.
function readDeclaredConfigKeys(manifest: unknown): DeclaredConfigKey[] {
  const raw = (manifest as { od?: { config?: unknown } } | undefined)?.od?.config;
  if (!Array.isArray(raw)) return [];
  const out: DeclaredConfigKey[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const name = typeof o.name === 'string' ? o.name : '';
    if (!CONFIG_KEY_NAME.test(name) || seen.has(name)) continue;
    seen.add(name);
    out.push({
      name,
      ...(typeof o.label === 'string' ? { label: o.label } : {}),
      ...(typeof o.description === 'string' ? { description: o.description } : {}),
      ...(typeof o.required === 'boolean' ? { required: o.required } : {}),
      secret: o.secret !== false,
      ...(typeof o.link === 'string' ? { link: o.link } : {}),
    });
  }
  return out;
}

// Which of a plugin's declared config keys are PER-ACCOUNT credentials
// (`od.accounts.credentialKeys`). Only keys the plugin actually declares in
// `od.config` are honored, so a typo can't invent a phantom credential.
function readAccountCredentialKeys(manifest: unknown): string[] {
  const raw = (manifest as { od?: { accounts?: { credentialKeys?: unknown } } } | undefined)
    ?.od?.accounts?.credentialKeys;
  if (!Array.isArray(raw)) return [];
  const declared = new Set(readDeclaredConfigKeys(manifest).map((k) => k.name));
  const out: string[] = [];
  for (const k of raw) {
    if (typeof k === 'string' && declared.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

// Which PLATFORM this plugin's accounts belong to. `od.accounts.platform` is
// the declaration; the wechat plugin id is grandfathered so a stale manifest
// keeps resolving to 公众号 during the platform pivot.
function pluginAccountPlatform(manifest: unknown, pluginId: string): string | null {
  return accountPlatformFromManifest(manifest)
    ?? (pluginId === 'wechat-mp-publish' ? 'wechat-mp' : null);
}

// Re-export so existing callers/tests keep importing from this module; the
// implementation moved to account-routes.ts with the platform pivot.
export { accountNameConflicts } from './account-routes.js';

export function registerPluginEditRoutes(app: Express, ctx: RegisterPluginEditRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR, PROJECT_ROOT } = ctx.paths;
  const HISTORY_ROOT = path.join(RUNTIME_DATA_DIR, 'plugin-history');

  // "AI 帮我改" — the model rewrites the prompts per a natural-language
  // instruction and returns them for review (does NOT write; the operator
  // saves via PUT /source). Reuses the multi-provider model call shared with
  // memory extraction (callModelOnce), so it works for local-CLI and BYOK.
  app.post('/api/plugins/:id/source/assist', async (req, res) => {
    try {
      const id = req.params.id;
      if (!getInstalledPlugin(db, id)) {
        return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      }
      const body = (req.body ?? {}) as Record<string, unknown>;
      const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
      if (!instruction) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'instruction is required');
      }
      const curSkill = typeof body.skill === 'string' ? body.skill : '';
      const curQuery = typeof body.query === 'string' ? body.query : '';
      const curStages = coerceStages(body.stages) ?? [];
      const user = [
        `修改指令：${instruction}`,
        '',
        '===== 当前 SKILL.md =====',
        curSkill,
        '',
        '===== 当前 query =====',
        curQuery,
        '',
        '===== 当前 stages（步骤骨架）=====',
        JSON.stringify(curStages, null, 2),
      ].join('\n');

      let raw: string;
      try {
        raw = await callModelOnce(RUNTIME_DATA_DIR, {
          projectRoot: PROJECT_ROOT,
          ...(typeof body.chatAgentId === 'string' ? { chatAgentId: body.chatAgentId } : {}),
          ...(typeof body.chatModel === 'string' ? { chatModel: body.chatModel } : {}),
          ...(body.chatProvider !== undefined ? { chatProvider: body.chatProvider } : {}),
          system: ASSIST_SYSTEM_PROMPT,
          user,
          // Rewriting a full SKILL.md is a larger generation than memory
          // extraction — give the local CLI more headroom than the 60s default.
          timeoutMs: 240_000,
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'NO_PROVIDER') {
          return sendApiError(
            res,
            400,
            'NO_MODEL_PROVIDER',
            '未配置可用模型：请在设置里选好本地 CLI 或填好模型 Key 后再用「AI 帮我改」。',
          );
        }
        throw err;
      }

      const parsed = parseAssistJson(raw);
      // On a clean parse use it; otherwise treat the whole reply as the new
      // SKILL.md so the user can review/fix it rather than hitting an error.
      const skill = parsed?.skill ?? raw.trim();
      const query = parsed?.query ?? curQuery;
      // Keep the model's stages if it returned a valid array; otherwise leave
      // the current steps untouched (a prompt-only edit shouldn't drop them).
      const stages = coerceStages(parsed?.stages) ?? curStages;
      const out: AssistEditResponse = { skill, query, stages };
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'ASSIST_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Scoped, STREAMING single-field rewrite — "AI 改这步". Sends only one piece
  // of text (a step's prompt or a mode's prompt) + the instruction, and streams
  // the rewritten prose back over SSE so the editor fills in live, like the main
  // chat. Far faster than the whole-plugin assist and can't drift other fields.
  app.post('/api/plugins/:id/source/assist-field', async (req, res) => {
    const id = req.params.id;
    if (!getInstalledPlugin(db, id)) {
      return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
    }
    const body = (req.body ?? {}) as Record<string, unknown>;
    const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
    const current = typeof body.text === 'string' ? body.text : '';
    if (!instruction) {
      return sendApiError(res, 400, 'BAD_REQUEST', 'instruction is required');
    }
    const label = typeof body.label === 'string' && body.label.trim() ? body.label.trim() : '提示词';

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    };
    let aborted = false;
    req.on('close', () => { aborted = true; });

    const system =
      `你在帮用户改写一段插件提示词（${label}）。根据用户的「指令」改写这段文字。\n` +
      '只返回改写后的纯文本本身，不要任何解释、不要 JSON、不要代码围栏、不要前后缀标签。\n' +
      '保留与原文一致的语气与占位（形如 {{platform}} 的占位原样保留）。';
    const user = `指令：${instruction}\n\n===== 当前内容 =====\n${current}`;

    try {
      const raw = await callModelOnce(RUNTIME_DATA_DIR, {
        projectRoot: PROJECT_ROOT,
        ...(typeof body.chatAgentId === 'string' ? { chatAgentId: body.chatAgentId } : {}),
        ...(typeof body.chatModel === 'string' ? { chatModel: body.chatModel } : {}),
        ...(body.chatProvider !== undefined ? { chatProvider: body.chatProvider } : {}),
        system,
        user,
        timeoutMs: 180_000,
        onDelta: (chunk: string) => {
          if (!aborted) send('delta', { delta: chunk });
        },
      });
      if (aborted) return res.end();
      // Defensively strip code fences the model may have wrapped around prose.
      const text = String(raw ?? '')
        .replace(/^\s*```[a-z]*\s*\n?/i, '')
        .replace(/\n?```\s*$/i, '')
        .trim();
      send('done', { text });
      res.end();
    } catch (err) {
      if (aborted) return res.end();
      const code = (err as { code?: string })?.code;
      send('error', {
        message:
          code === 'NO_PROVIDER'
            ? '未配置可用模型：请在设置里选好本地 CLI 或填好模型 Key。'
            : String((err as Error)?.message ?? err),
      });
      res.end();
    }
  });

  app.get('/api/plugins/:id/source', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id);
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      res.json(await readPluginSourceView(plugin as never, id));
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_SOURCE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Per-plugin config (third-party API keys / app id+secret). GET returns the
  // manifest-DECLARED keys (`od.config`) + whether each has a saved value.
  // Secret values are NEVER returned; non-secret values are returned verbatim.
  app.get('/api/plugins/:id/config', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as
        | { manifest?: unknown; sourceKind?: string }
        | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const declared = readDeclaredConfigKeys(plugin.manifest);
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      const stored = validatePluginConfig(cfg.pluginConfig)?.[id] ?? {};
      // Existing values from the plugin's declared `.env` (if any) — so already-
      // configured keys show as set. pluginConfig (editor) takes precedence.
      const envVals = readPluginConfigEnvFile(plugin.manifest);
      // Keys claimed by od.accounts.credentialKeys are configured PER ACCOUNT
      // — the plugin-level panel shows a "per-account" badge instead of a
      // value input, and run-time injection strips plugin-level/.env values
      // for them (exclusive account rule).
      const perAccountKeys = new Set(readAccountCredentialKeys(plugin.manifest));
      const keys: PluginConfigKeyView[] = declared.map((k) => {
        const cfgVal = stored[k.name];
        const envVal = envVals[k.name];
        const fromConfig = typeof cfgVal === 'string' && cfgVal.length > 0;
        const fromEnv = typeof envVal === 'string' && envVal.length > 0;
        const view: PluginConfigKeyView = { name: k.name, secret: k.secret, set: fromConfig || fromEnv };
        if (k.label) view.label = k.label;
        if (k.description) view.description = k.description;
        if (k.required) view.required = k.required;
        if (k.link) view.link = k.link;
        if (perAccountKeys.has(k.name)) view.perAccount = true;
        if (fromConfig) view.source = 'config';
        else if (fromEnv) view.source = 'env';
        // Non-secret values are safe to echo; prefer the editor override.
        if (!k.secret) {
          const shown = fromConfig ? cfgVal : (fromEnv ? envVal : undefined);
          if (typeof shown === 'string') view.value = shown;
        }
        return view;
      });
      const editable = plugin.sourceKind === 'bundled' || plugin.sourceKind === 'user';
      const response: PluginConfigResponse = { id, keys, editable };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_CONFIG_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Save values for the plugin's DECLARED keys only (unknown keys ignored).
  // Empty string clears a key. Stored under app-config `pluginConfig[id]` and
  // injected into THIS plugin's runs as env vars (see server.ts run spawn).
  app.put('/api/plugins/:id/config', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as { manifest?: unknown } | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const declared = new Set(readDeclaredConfigKeys(plugin.manifest).map((k) => k.name));
      const values = (req.body as { values?: unknown })?.values;
      if (!values || typeof values !== 'object' || Array.isArray(values)) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'values object is required');
      }
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      const all = { ...(validatePluginConfig(cfg.pluginConfig) ?? {}) };
      const next: Record<string, string> = { ...(all[id] ?? {}) };
      for (const [k, v] of Object.entries(values as Record<string, unknown>)) {
        if (!declared.has(k)) continue; // only keys this plugin declares
        if (typeof v !== 'string') continue;
        const trimmed = v.trim();
        if (trimmed) next[k] = trimmed;
        else delete next[k]; // empty string clears
      }
      if (Object.keys(next).length > 0) all[id] = next;
      else delete all[id];
      await writeAppConfig(RUNTIME_DATA_DIR, { pluginConfig: all });
      const response: UpdatePluginConfigResponse = { id, saved: true };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_CONFIG_SAVE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // ===== Account profiles (platform facade) ==============================
  // Accounts belong to PLATFORMS (see account-routes.ts). These per-plugin
  // routes remain as a FACADE for the plugin editor: they resolve the plugin's
  // platform (`od.accounts.platform`) and read/write the platform-level store,
  // so the editor's 账号区 and the 账号 page always show the same roster.

  app.get('/api/plugins/:id/accounts', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as { manifest?: unknown; sourceKind?: string } | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const platform = pluginAccountPlatform(plugin.manifest, id);
      const credentialKeys = platform ? platformCredentialKeys(platform) : [];
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      const accounts = platform
        ? platformAccountsForPlatform(cfg, platform).map((a) => accountToView(a, credentialKeys))
        : [];
      const editable = plugin.sourceKind === 'bundled' || plugin.sourceKind === 'user';
      const response: AccountProfilesResponse = { id, credentialKeys, accounts, editable };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_ACCOUNTS_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.put('/api/plugins/:id/accounts', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as { manifest?: unknown } | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const platform = pluginAccountPlatform(plugin.manifest, id);
      if (!platform) {
        return sendApiError(res, 400, 'ACCOUNTS_UNSUPPORTED', 'plugin does not declare account support');
      }
      const outcome = await upsertPlatformAccount(
        RUNTIME_DATA_DIR,
        platform,
        (req.body ?? {}) as Parameters<typeof upsertPlatformAccount>[2],
      );
      if (!outcome.ok) return sendApiError(res, outcome.status, outcome.code, outcome.message);
      const response: UpsertAccountProfileResponse = {
        id,
        saved: true,
        account: accountToView(outcome.account, platformCredentialKeys(platform)),
      };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_ACCOUNT_SAVE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.delete('/api/plugins/:id/accounts/:accountId', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as { manifest?: unknown } | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const platform = pluginAccountPlatform(plugin.manifest, id);
      if (platform) await deletePlatformAccount(RUNTIME_DATA_DIR, platform, req.params.accountId);
      const response: DeleteAccountProfileResponse = { id, deleted: true };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_ACCOUNT_DELETE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Reveal ONE config key's saved plaintext (the editor's eye toggle). Returned
  // only on this explicit per-key request — never in the masked list above — and
  // only for keys the plugin declares. Local-only: the daemon runs on the user's
  // machine and this is their own credential. Value = pluginConfig override, else
  // the plugin's declared `.env`.
  app.get('/api/plugins/:id/config/reveal/:key', async (req, res) => {
    try {
      const id = req.params.id;
      const key = req.params.key;
      const plugin = getInstalledPlugin(db, id) as { manifest?: unknown } | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const declared = new Set(readDeclaredConfigKeys(plugin.manifest).map((k) => k.name));
      if (!declared.has(key)) return sendApiError(res, 404, 'KEY_NOT_DECLARED', 'key not declared by this plugin');
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      const stored = validatePluginConfig(cfg.pluginConfig)?.[id] ?? {};
      const envVals = readPluginConfigEnvFile(plugin.manifest);
      const sv = stored[key];
      const ev = envVals[key];
      const value = (typeof sv === 'string' && sv) ? sv : (typeof ev === 'string' ? ev : '');
      res.json({ name: key, value });
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_CONFIG_REVEAL_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Edit history. Every PUT /source snapshots the PRE-edit files below, so
  // this lists restore points for hand edits and AI rewrites alike.
  app.get('/api/plugins/:id/source/history', async (req, res) => {
    try {
      const id = req.params.id;
      if (!getInstalledPlugin(db, id)) {
        return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      }
      res.json({ versions: await listPluginVersions(HISTORY_ROOT, id) });
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_HISTORY_FAILED', String((err as Error)?.message ?? err));
    }
  });

  // Roll the on-disk source back to a recorded version. The current state is
  // snapshotted first, so a rollback is itself undoable.
  app.post('/api/plugins/:id/source/rollback', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as
        | { fsPath: string; sourceKind: string; source: string; trust: string; manifest?: unknown }
        | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const versionId = typeof (req.body as { versionId?: unknown })?.versionId === 'string'
        ? (req.body as { versionId: string }).versionId
        : '';
      const version = await readPluginVersion(HISTORY_ROOT, id, versionId);
      if (!version) return sendApiError(res, 404, 'VERSION_NOT_FOUND', 'version not found');

      // Snapshot what's on disk now before overwriting it.
      let currentSkill = '';
      try {
        currentSkill = await fsp.readFile(path.join(plugin.fsPath, 'SKILL.md'), 'utf8');
      } catch { /* missing SKILL.md snapshots as empty */ }
      await recordPluginVersion(HISTORY_ROOT, id, { skill: currentSkill, manifest: plugin.manifest });

      await fsp.writeFile(path.join(plugin.fsPath, 'SKILL.md'), version.skill, 'utf8');
      if (version.manifest && typeof version.manifest === 'object') {
        await fsp.writeFile(
          path.join(plugin.fsPath, 'open-design.json'),
          JSON.stringify(version.manifest, null, 2) + '\n',
          'utf8',
        );
      }
      const resolved = await resolvePluginFolder({
        folder: plugin.fsPath,
        folderId: id,
        sourceKind: plugin.sourceKind as never,
        source: plugin.source,
        trust: plugin.trust as never,
      });
      if (!resolved.ok) {
        return sendApiError(res, 400, 'PLUGIN_REPARSE_FAILED', resolved.errors.join('; '));
      }
      upsertInstalledPlugin(db, resolved.record);
      const fresh = getInstalledPlugin(db, id);
      res.json({ id, source: await readPluginSourceView(fresh as never, id) });
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_ROLLBACK_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.put('/api/plugins/:id/source', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as
        | { fsPath: string; sourceKind: string; source: string; trust: string }
        | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const fsPath = plugin.fsPath;
      const body = (req.body ?? {}) as { skill?: unknown; query?: unknown; stages?: unknown };

      // Snapshot the pre-edit source first — the safety net under every
      // save, whether it came from a hand edit or an AI rewrite.
      try {
        let preSkill = '';
        try {
          preSkill = await fsp.readFile(path.join(fsPath, 'SKILL.md'), 'utf8');
        } catch { /* missing SKILL.md snapshots as empty */ }
        await recordPluginVersion(HISTORY_ROOT, id, {
          skill: preSkill,
          manifest: (plugin as { manifest?: unknown }).manifest,
        });
      } catch { /* history is best-effort; the save itself must not fail */ }

      if (typeof body.skill === 'string') {
        await fsp.writeFile(path.join(fsPath, 'SKILL.md'), body.skill, 'utf8');
      }

      // The kickoff query and the workflow stages both live in open-design.json
      // — read it once, apply whichever the request carries, write once.
      const editStages = coerceStages(body.stages);
      if (typeof body.query === 'string' || editStages) {
        const manifestPath = path.join(fsPath, 'open-design.json');
        const raw = await fsp.readFile(manifestPath, 'utf8');
        const json = JSON.parse(raw) as {
          od?: { useCase?: { query?: unknown }; workflow?: { stages?: unknown }; inputs?: unknown };
        };
        json.od = json.od ?? {};
        if (typeof body.query === 'string') {
          json.od.useCase = json.od.useCase ?? {};
          const existing = json.od.useCase.query;
          if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            // Keep the localized map; update the operator's locale (zh-CN).
            (existing as Record<string, string>)['zh-CN'] = body.query;
          } else {
            json.od.useCase.query = body.query;
          }
          // Grow `od.inputs` to cover any NEW `{{placeholder}}` the edited query
          // introduced, so the composer keeps rendering them as fillable slots.
          // Existing declared inputs (with their richer specs) are preserved.
          const declaredInputs = Array.isArray(json.od.inputs)
            ? (json.od.inputs as Array<{ name?: unknown }>)
            : [];
          const derived = deriveInputsFromQuery(body.query, declaredInputs);
          if (derived.length > 0) {
            json.od.inputs = [...declaredInputs, ...derived];
          }
        }
        if (editStages) {
          mergeStagesIntoManifest(json, editStages);
        }
        await fsp.writeFile(manifestPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      }

      // Re-register the folder so the edited manifest goes live.
      const resolved = await resolvePluginFolder({
        folder: fsPath,
        folderId: id,
        sourceKind: plugin.sourceKind as never,
        source: plugin.source,
        trust: plugin.trust as never,
      });
      if (!resolved.ok) {
        return sendApiError(res, 400, 'PLUGIN_REPARSE_FAILED', resolved.errors.join('; '));
      }
      upsertInstalledPlugin(db, resolved.record);
      const out: UpdatePluginSourceResponse = { id, published: true };
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_SOURCE_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
