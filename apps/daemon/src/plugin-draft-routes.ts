import path from 'node:path';
import { promises as fsp } from 'node:fs';
import fs from 'node:fs';
import type { Express } from 'express';
import { OPEN_DESIGN_PLUGIN_SPEC_VERSION } from '@open-design/contracts';
import type {
  CreatePluginDraftResponse,
  PluginDraftDiagnostic,
  PluginSourceStage,
  SavePluginDraftResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import {
  getInstalledPlugin,
  registryRootsForDataDir,
  resolvePluginFolder,
  upsertInstalledPlugin,
} from './plugins/registry.js';
import { coerceStages } from './plugin-edit-routes.js';
import { callModelOnce } from './memory-llm.js';

export interface RegisterPluginDraftRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

// The drafting prompt combines two specs:
//   1. skill-creator authoring rules for the SKILL.md body (imperative voice,
//      explain the why, <500 lines, output-format templates, examples) — the
//      same rules /api/skills/draft enforces.
//   2. od.workflow conventions from the bundled short-video-copy plugin:
//      every stage carries its own prompt (the methodology that decides that
//      step's output), human gates sit where the user must approve before
//      work continues, and optional per-mode prompt slots cover runtime
//      branches (e.g. "AI suggest" vs "scrape live data").
const DRAFT_SYSTEM_PROMPT = [
  '你在为 Open Design 起草一个「工作流插件」。用户给你一段业务描述(要完成什么业务、大致分几步、哪里需要人确认),你产出插件的完整可编辑面:SKILL.md 正文、开场 query、工作流步骤。',
  '',
  '产出物的设计规范:',
  '- `name`:kebab-case 短标识(小写字母/数字/短横线)。`title`:画廊卡片上的显示名(贴合用户语言)。`description`:一句话说明插件做什么。',
  '- `skill`(SKILL.md 正文,遵循 Anthropic skill-creator 撰写规范):插件的全局方法论——协作协议(用 TodoWrite 维护步骤条、关键决策用 AskUserQuestion)、全局铁律、产出物规范。用祈使句,解释每条约束背后的「为什么」而不是堆砌 MUST;控制在 500 行内;输出格式给明确模板;保持通用不过拟合。',
  '- `query`:用户选用插件时填进对话框的开场指令,要让 agent 一进对话就知道自己的角色、流程和第一步做什么。',
  '- `stages`(工作流步骤,2-6 步):每步有 id(英文 kebab-case)、title(中文短名)、gate、prompt、modes。',
  '  * **prompt 是每步最重要的字段**:这一步自己的方法论,决定该步产出的效果和风格——目标、判断标准、输出格式、与用户的交互方式,写具体。',
  '  * gate 的取舍:产出需要用户拍板才能继续的步骤用 "confirm"(如选方案、定文案);让用户在多个选项里挑的用 "choice";纯收尾/汇报用 "none"。业务里「哪里需要人确认」的描述要落到 gate 上。',
  '  * modes:仅当某一步存在明显的运行时分支(如「AI 建议」vs「真抓实时数据」)才加,每个 mode 有 id/label/prompt;没有分支就给空数组。',
  '',
  '严格只返回一个 JSON 对象,不要任何解释、不要代码围栏以外的文字:',
  '{"name":"<kebab-case id>","title":"<显示名>","description":"<一句话>","query":"<开场指令>","skill":"<SKILL.md 正文 markdown>","stages":[{"id":"...","title":"...","gate":"confirm|choice|none","prompt":"<该步方法论>","modes":[]}]}',
].join('\n');

interface ParsedPluginDraft {
  name?: string;
  title?: string;
  description?: string;
  query?: string;
  skill?: string;
  stages?: PluginSourceStage[];
}

// Tolerant parse of the model's JSON output (strip ``` fences, find the
// object) — same defensive strategy as the assist/draft parsers.
export function parsePluginDraftJson(raw: string): ParsedPluginDraft | null {
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
      if (!obj || typeof obj !== 'object') continue;
      return {
        ...(typeof obj.name === 'string' ? { name: obj.name } : {}),
        ...(typeof obj.title === 'string' ? { title: obj.title } : {}),
        ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
        ...(typeof obj.query === 'string' ? { query: obj.query } : {}),
        ...(typeof obj.skill === 'string' ? { skill: obj.skill } : {}),
        ...(Array.isArray(obj.stages) ? { stages: coerceStages(obj.stages) ?? [] } : {}),
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

// Plugin ids must satisfy the manifest schema's `^[a-z0-9][a-z0-9._-]*$`.
const PLUGIN_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;

export function slugifyPluginName(value: unknown): string {
  if (typeof value !== 'string') return '';
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
  return PLUGIN_NAME_RE.test(slug) ? slug : '';
}

// The same ~500-line guideline the skill draft validator applies — the
// plugin's SKILL.md is a skill body and follows the same spec.
const SKILL_MAX_LINES = 500;

// Spec-conformance check for a drafted (or hand-edited) plugin. Errors block
// saving; warnings surface inline. Exported for unit tests.
export function validatePluginDraft(draft: {
  name?: string;
  title?: string;
  query?: string;
  skill?: string;
  stages?: PluginSourceStage[];
}): PluginDraftDiagnostic[] {
  const out: PluginDraftDiagnostic[] = [];
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) {
    out.push({ severity: 'error', code: 'NAME_REQUIRED', message: 'name is required' });
  } else if (!PLUGIN_NAME_RE.test(name)) {
    out.push({
      severity: 'error',
      code: 'NAME_INVALID',
      message: `name must match ^[a-z0-9][a-z0-9._-]*$; got "${name}"`,
    });
  }
  if (!(typeof draft.title === 'string' && draft.title.trim())) {
    out.push({ severity: 'error', code: 'TITLE_REQUIRED', message: 'title is required' });
  }
  if (!(typeof draft.query === 'string' && draft.query.trim())) {
    out.push({
      severity: 'error',
      code: 'QUERY_REQUIRED',
      message: 'query is required — it seeds the conversation when the plugin is applied',
    });
  }
  const skill = typeof draft.skill === 'string' ? draft.skill.trim() : '';
  if (!skill) {
    out.push({ severity: 'error', code: 'SKILL_REQUIRED', message: 'SKILL.md body is required' });
  } else {
    const lines = skill.split(/\r?\n/).length;
    if (lines > SKILL_MAX_LINES) {
      out.push({
        severity: 'warning',
        code: 'SKILL_TOO_LONG',
        message: `SKILL.md body is ${lines} lines; the spec recommends staying under ${SKILL_MAX_LINES}`,
      });
    }
  }
  const stages = Array.isArray(draft.stages) ? draft.stages : [];
  if (stages.length === 0) {
    out.push({
      severity: 'warning',
      code: 'NO_STAGES',
      message: 'no workflow stages — the plugin will run without a step rail or human gates',
    });
  }
  for (const stage of stages) {
    if (!stage.prompt || !stage.prompt.trim()) {
      out.push({
        severity: 'warning',
        code: 'STAGE_PROMPT_EMPTY',
        message: `stage "${stage.id}" has no prompt — that step's output style is left to chance`,
      });
    }
  }
  return out;
}

// Build the open-design.json manifest for a saved draft. Mirrors the
// candidate-draft builder (skill-candidates.ts) plus the workflow/useCase
// fields the draft carries; structure stays minimal-but-valid so the
// editor's PUT /source merge logic owns later evolution.
export function buildDraftManifest(input: {
  name: string;
  title: string;
  description: string;
  query: string;
  stages: PluginSourceStage[];
}): Record<string, unknown> {
  return {
    $schema: 'https://open-design.ai/schemas/plugin.v1.json',
    specVersion: OPEN_DESIGN_PLUGIN_SPEC_VERSION,
    name: input.name,
    title: input.title,
    version: '0.1.0',
    ...(input.description ? { description: input.description } : {}),
    od: {
      kind: 'skill',
      taskKind: 'new-generation',
      useCase: { query: input.query },
      ...(input.stages.length > 0
        ? {
            workflow: {
              stages: input.stages.map((s) => ({
                id: s.id,
                title: s.title,
                gate: s.gate,
                prompt: s.prompt,
                ...(s.modes.length > 0
                  ? { modes: s.modes.map((m) => ({ id: m.id, label: m.label, prompt: m.prompt })) }
                  : {}),
                ...(s.skills.length > 0
                  ? { skills: s.skills.map((ref) => ({ ref })) }
                  : {}),
              })),
            },
          }
        : {}),
      context: { skills: [{ path: './SKILL.md' }] },
      capabilities: ['prompt:inject'],
    },
  };
}

/**
 * Plugin creation routes.
 *
 *   POST /api/plugins/draft — draft a workflow plugin from a business
 *     description. Returned for review (never written); the shape matches
 *     the plugin editor's editable view so the draft drops straight in.
 *   POST /api/plugins — save a reviewed draft as a NEW user plugin: write
 *     SKILL.md + open-design.json under the user plugins root and register
 *     with sourceKind 'user', so it is immediately applicable and editable
 *     via the existing /api/plugins/:id/source routes.
 */
export function registerPluginDraftRoutes(app: Express, ctx: RegisterPluginDraftRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR, PROJECT_ROOT } = ctx.paths;
  const { userPluginsRoot } = registryRootsForDataDir(RUNTIME_DATA_DIR);

  app.post('/api/plugins/draft', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!description) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'description is required');
      }
      const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
      const user = [
        '业务描述:',
        description,
        ...(requestedName ? ['', `期望的插件 id:${requestedName}`] : []),
      ].join('\n');

      let raw: string;
      try {
        raw = await callModelOnce(RUNTIME_DATA_DIR, {
          projectRoot: PROJECT_ROOT,
          ...(typeof body.chatAgentId === 'string' ? { chatAgentId: body.chatAgentId } : {}),
          ...(typeof body.chatModel === 'string' ? { chatModel: body.chatModel } : {}),
          ...(body.chatProvider !== undefined ? { chatProvider: body.chatProvider } : {}),
          system: DRAFT_SYSTEM_PROMPT,
          user,
          // A full plugin draft (SKILL.md + stages) is the largest of the
          // drafting generations — same headroom as the plugin assist route.
          timeoutMs: 240_000,
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'NO_PROVIDER') {
          return sendApiError(
            res,
            400,
            'NO_MODEL_PROVIDER',
            '未配置可用模型:请在设置里选好本地 CLI 或填好模型 Key 后再用「AI 起草插件」。',
          );
        }
        throw err;
      }

      const parsed = parsePluginDraftJson(raw);
      if (!parsed || (!parsed.skill && !parsed.query)) {
        return sendApiError(res, 502, 'DRAFT_PARSE_FAILED', '模型返回的内容无法解析为插件草稿,请重试或换个说法。');
      }
      const name = slugifyPluginName(parsed.name || requestedName);
      const draft = {
        name,
        title: parsed.title ?? '',
        description: parsed.description ?? '',
        query: parsed.query ?? '',
        skill: parsed.skill ?? '',
        stages: parsed.stages ?? [],
      };
      const out: CreatePluginDraftResponse = {
        ...draft,
        diagnostics: validatePluginDraft(draft),
      };
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_DRAFT_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.post('/api/plugins', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const draft = {
        name: typeof body.name === 'string' ? body.name.trim() : '',
        title: typeof body.title === 'string' ? body.title.trim() : '',
        description: typeof body.description === 'string' ? body.description.trim() : '',
        query: typeof body.query === 'string' ? body.query : '',
        skill: typeof body.skill === 'string' ? body.skill : '',
        stages: coerceStages(body.stages) ?? [],
      };
      const errors = validatePluginDraft(draft).filter((d) => d.severity === 'error');
      if (errors.length > 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', errors.map((d) => `${d.code}: ${d.message}`).join('; '));
      }
      const overwrite = body.overwrite === true;
      if (!overwrite && getInstalledPlugin(db, draft.name)) {
        return sendApiError(res, 409, 'PLUGIN_EXISTS', `plugin "${draft.name}" already exists; pass overwrite=true to replace it`);
      }

      const folder = path.join(userPluginsRoot, draft.name);
      const existedBefore = fs.existsSync(folder);
      await fsp.mkdir(folder, { recursive: true });
      await fsp.writeFile(path.join(folder, 'SKILL.md'), draft.skill.endsWith('\n') ? draft.skill : draft.skill + '\n', 'utf8');
      await fsp.writeFile(
        path.join(folder, 'open-design.json'),
        JSON.stringify(buildDraftManifest(draft), null, 2) + '\n',
        'utf8',
      );

      // sourceKind 'user' (not 'local') so the plugin editor treats the new
      // plugin as editable; trust 'trusted' because the operator authored it.
      const resolved = await resolvePluginFolder({
        folder,
        folderId: draft.name,
        sourceKind: 'user',
        source: `draft:${draft.name}`,
        trust: 'trusted',
      });
      if (!resolved.ok) {
        // A fresh folder that failed manifest validation is ours to clean up;
        // a pre-existing folder (overwrite path) is left for inspection.
        if (!existedBefore) {
          await fsp.rm(folder, { recursive: true, force: true }).catch(() => undefined);
        }
        return sendApiError(res, 400, 'PLUGIN_DRAFT_INVALID', resolved.errors.join('; '));
      }
      upsertInstalledPlugin(db, resolved.record);
      const out: SavePluginDraftResponse = { id: draft.name, published: true };
      res.status(201).json(out);
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_SAVE_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
