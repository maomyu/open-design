import { z } from 'zod';

// `open-design.json` schema (v1). Mirrors docs/schemas/open-design.plugin.v1.json
// with one addition: this Zod schema is permissive on the top level so adapter
// outputs (synthesized PluginManifest from SKILL.md frontmatter or claude
// plugin.json) parse cleanly without losing forward-compatible fields.

export const OPEN_DESIGN_PLUGIN_SPEC_VERSION = '1.0.0';

export const OpenDesignSpecVersionSchema = z.string().min(1);

export const ReferenceSchema = z.object({
  ref:  z.string().optional(),
  path: z.string().optional(),
}).passthrough();

export const RefPathSchema = z.object({
  path: z.string().min(1),
}).passthrough();

export const McpServerSpecSchema = z.object({
  name:    z.string().min(1),
  command: z.string().optional(),
  args:    z.array(z.string()).optional(),
  env:     z.record(z.string()).optional(),
  url:     z.string().optional(),
}).passthrough();

export type McpServerSpec = z.infer<typeof McpServerSpecSchema>;

export const InputFieldSchema = z.object({
  name:        z.string().min(1),
  label:       z.string().optional(),
  type:        z.enum(['string', 'text', 'select', 'number', 'boolean', 'file']).optional(),
  required:    z.boolean().optional(),
  options:     z.array(z.string()).optional(),
  // Dynamic option source. Static `options` live in the manifest; some selects
  // are per-installation data instead — `optionsFrom: 'accounts'` means "the
  // options are this plugin's configured account-profile names". The manifest
  // stays declarative; the daemon hydrates `options` at APPLY time (the only
  // resolution point), so the composer and CLI both see the resolved list.
  // Closed enum on purpose — future dynamic sources extend it here.
  optionsFrom: z.enum(['accounts']).optional(),
  placeholder: z.string().optional(),
  default:     z.unknown().optional(),
}).passthrough();

export type InputField = z.infer<typeof InputFieldSchema>;

// A config key a plugin declares it needs (third-party API key, app id/secret,
// etc.). Values are NOT stored in the manifest — the user fills them per-plugin
// in the plugin editor; the daemon keeps them in app-config and injects them as
// env vars into that plugin's runs. `name` is env-var style (UPPER_SNAKE).
export const PluginConfigKeySchema = z.object({
  name:        z.string().regex(/^[A-Z][A-Z0-9_]*$/, 'Config key must be UPPER_SNAKE (env-var style).'),
  label:       z.string().optional(),
  description: z.string().optional(),
  required:    z.boolean().optional(),
  secret:      z.boolean().optional(), // default true → masked in the editor
  link:        z.string().optional(),  // where to obtain the key
}).passthrough();

export type PluginConfigKey = z.infer<typeof PluginConfigKeySchema>;

export const LocalizedTextSchema = z.record(z.string()).refine(
  (value) => Object.keys(value).length > 0,
  { message: 'Localized text must include at least one locale.' },
);

export type LocalizedText = string | z.infer<typeof LocalizedTextSchema>;

export function resolveLocalizedText(
  value: LocalizedText | undefined,
  locale?: string,
  fallbackLocale = 'en',
): string {
  if (!value) return '';
  if (typeof value === 'string') return value;

  const candidates = [
    locale,
    locale?.split('-')[0],
    fallbackLocale,
    fallbackLocale.split('-')[0],
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    const resolved = value[candidate];
    if (typeof resolved === 'string' && resolved.length > 0) return resolved;
  }

  return Object.values(value).find((text) => text.length > 0) ?? '';
}

export const PipelineStageSchema = z.object({
  id:        z.string().min(1),
  atoms:     z.array(z.string()),
  repeat:    z.boolean().optional(),
  until:     z.string().optional(),
  onFailure: z.enum(['abort', 'skip', 'retry']).optional(),
}).passthrough();

export type PipelineStage = z.infer<typeof PipelineStageSchema>;

export const PluginPipelineSchema = z.object({
  stages: z.array(PipelineStageSchema),
}).passthrough();

export type PluginPipeline = z.infer<typeof PluginPipelineSchema>;

export const GenUISurfaceSpecSchema = z.object({
  id:      z.string().min(1),
  kind:    z.enum(['form', 'choice', 'confirmation', 'oauth-prompt']),
  persist: z.enum(['run', 'conversation', 'project']),
  trigger: z.object({
    stageId: z.string().optional(),
    atom:    z.string().optional(),
  }).passthrough().optional(),
  schema:               z.record(z.unknown()).optional(),
  prompt:               z.string().optional(),
  capabilitiesRequired: z.array(z.string()).optional(),
  timeout:              z.number().int().positive().optional(),
  onTimeout:            z.enum(['abort', 'default', 'skip']).optional(),
  default:              z.unknown().optional(),
  oauth: z.object({
    route:       z.enum(['connector', 'mcp', 'plugin']),
    connectorId: z.string().optional(),
    mcpServerId: z.string().optional(),
  }).passthrough().optional(),
  // Phase 4 / spec §10.3.5 alignment-roadmap row 2 — plugin-bundled
  // React component path. Capability-gated by `genui:custom-component`
  // (a future patch to the §5.3 capability vocabulary). The web
  // GenUISurfaceRenderer falls back to the built-in renderer when the
  // capability is not granted; the field stays an opaque relpath in
  // v1 contracts so the UI loader / sandbox can evolve without
  // touching the manifest schema.
  component: z.object({
    // Path to the entry module relative to the plugin folder, e.g.
    // `./surfaces/critique-panel.tsx`. The host loader is responsible
    // for compilation + sandboxing.
    path:     z.string().min(1),
    // Optional named export the host should mount; defaults to the
    // module's default export.
    export:   z.string().optional(),
    // Sandbox tier the surface needs. v1 only ships 'iframe' but the
    // contract leaves room for a Phase 4 React-component sandbox.
    sandbox:  z.enum(['iframe', 'react']).optional(),
  }).passthrough().optional(),
}).passthrough();

export type GenUISurfaceSpec = z.infer<typeof GenUISurfaceSpecSchema>;

export const PluginConnectorRefSchema = z.object({
  id:    z.string().min(1),
  tools: z.array(z.string()).default([]),
  required: z.boolean().optional(),
}).passthrough();

export type PluginConnectorRef = z.infer<typeof PluginConnectorRefSchema>;

// How a node's parallel child options are chosen. A "branch" turns a flat
// mode list into an explicit fork:
//   - select 'single' → the options are mutually-exclusive alternatives (pick
//     exactly one); 'multi' → the operator/user may pick several and EACH
//     picked branch runs one pass, its outputs merged.
//   - pick 'ask' → the running agent surfaces the choice at that step via
//     AskUserQuestion (multiSelect for 'multi'); 'input' → the choice is
//     resolved implicitly from an input value (legacy behavior, no extra
//     prompt). When `branch` is ABSENT the modes stay legacy: the daemon
//     composes every mode prompt and the agent matches one by input value.
// `select`/`pick` are OPTIONAL at the manifest layer — the daemon resolves the
// defaults (single / ask) when it flattens stages for the editor and the run.
// Keeping them optional here also keeps the schema's input type equal to its
// output type, which lets the node schemas below carry explicit `z.ZodType<T>`
// annotations (needed so the deeper nesting doesn't blow past tsc's
// declaration-emit size limit — TS7056).
export interface WorkflowBranch {
  select?: 'single' | 'multi';
  pick?: 'ask' | 'input';
  [k: string]: unknown;
}
export const WorkflowBranchSchema = z.object({
  select: z.enum(['single', 'multi']).optional(),
  pick:   z.enum(['ask', 'input']).optional(),
}).passthrough() as unknown as z.ZodType<WorkflowBranch>;

// A level-2 leaf option nested under a mode (e.g. the "真抓热榜" mode's
// individual scrape methods: bb-browser / gstack / TikHub …). Nesting is
// capped at two levels — a submode carries no further children — to keep the
// editor and the runtime picker bounded.
export interface WorkflowStageSubMode {
  id: string;
  label?: string;
  label_i18n?: LocalizedText;
  prompt?: string;
  prompt_i18n?: LocalizedText;
  [k: string]: unknown;
}
export const WorkflowStageSubModeSchema = z.object({
  id:          z.string().min(1),
  label:       z.string().optional(),
  label_i18n:  LocalizedTextSchema.optional(),
  prompt:      z.string().optional(),
  prompt_i18n: LocalizedTextSchema.optional(),
}).passthrough() as unknown as z.ZodType<WorkflowStageSubMode>;

// A per-mode prompt slot inside a stage. Some steps run differently depending
// on a runtime input (e.g. the topic step: "AI suggest" vs "scrape trending
// via bb-browser"); each mode carries its own prompt so the operator can tune
// each path's output independently. A mode may itself declare a `branch` +
// nested `modes` (level-2 submodes) — e.g. "真抓热榜" fans out into several
// scrape methods the user can multi-select.
export interface WorkflowStageMode {
  id: string;
  label?: string;
  label_i18n?: LocalizedText;
  prompt?: string;
  prompt_i18n?: LocalizedText;
  branch?: WorkflowBranch;
  modes?: WorkflowStageSubMode[];
  [k: string]: unknown;
}
export const WorkflowStageModeSchema = z.object({
  id:          z.string().min(1),
  label:       z.string().optional(),
  label_i18n:  LocalizedTextSchema.optional(),
  prompt:      z.string().optional(),
  prompt_i18n: LocalizedTextSchema.optional(),
  branch:      WorkflowBranchSchema.optional(),
  modes:       z.array(WorkflowStageSubModeSchema).optional(),
}).passthrough() as unknown as z.ZodType<WorkflowStageMode>;

// Workflow mode (deer-flow inspired). A plugin can declare an explicit,
// ordered list of stages so the host renders a step rail and the agent
// drives the conversation stage by stage. `gate: 'confirm'` marks a
// human checkpoint between stages — the agent raises AskUserQuestion and
// the streaming run pauses until the operator confirms/rejects. Each stage
// carries its own `prompt` (the methodology that decides that step's output
// style) and optional per-mode prompt slots; the daemon composes these into
// the system prompt so they actually drive the run. The shared state surfaces
// are TodoWrite (the step rail) and a live-artifact board.
export interface WorkflowStage {
  id: string;
  title?: string;
  title_i18n?: LocalizedText;
  gate?: 'confirm' | 'choice' | 'none';
  prompt?: string;
  prompt_i18n?: LocalizedText;
  branch?: WorkflowBranch;
  modes?: WorkflowStageMode[];
  skills?: Array<{ ref?: string; path?: string; [k: string]: unknown }>;
  [k: string]: unknown;
}
export const WorkflowStageSchema = z.object({
  id:          z.string().min(1),
  title:       z.string().optional(),
  title_i18n:  LocalizedTextSchema.optional(),
  gate:        z.enum(['confirm', 'choice', 'none']).optional(),
  prompt:      z.string().optional(),
  prompt_i18n: LocalizedTextSchema.optional(),
  // How this stage's `modes` are chosen. Absent → legacy (compose all, agent
  // matches by input). Present → an explicit single/multi fork the runtime
  // surfaces (see WorkflowBranchSchema).
  branch:      WorkflowBranchSchema.optional(),
  modes:       z.array(WorkflowStageModeSchema).optional(),
  // Stage-level skill bindings. Each reference (by global skill id via
  // `ref`) scopes that skill's methodology to THIS step: the daemon
  // injects the skill body under the step's prompt block, so a plugin can
  // orchestrate different skills per stage (e.g. a scraping skill on the
  // topic step, a copywriting skill on the script step) instead of
  // injecting everything globally via od.context.skills.
  skills:      z.array(ReferenceSchema).optional(),
}).passthrough() as unknown as z.ZodType<WorkflowStage>;

export const PluginWorkflowSchema = z.object({
  stages: z.array(WorkflowStageSchema),
}).passthrough();

export type PluginWorkflow = z.infer<typeof PluginWorkflowSchema>;

export const PluginManifestSchema = z.object({
  $schema:     z.string().optional(),
  specVersion: OpenDesignSpecVersionSchema.optional(),
  name:        z.string().min(1).regex(/^[a-z0-9][a-z0-9._-]*$/),
  title:       z.string().optional(),
  title_i18n:  LocalizedTextSchema.optional(),
  version:     z.string().min(1),
  description: z.string().optional(),
  description_i18n: LocalizedTextSchema.optional(),
  author:   z.object({
    name: z.string().optional(),
    url:  z.string().optional(),
  }).passthrough().optional(),
  license:  z.string().optional(),
  homepage: z.string().optional(),
  icon:     z.string().optional(),
  tags:     z.array(z.string()).optional(),
  compat: z.object({
    agentSkills:   z.array(RefPathSchema).optional(),
    claudePlugins: z.array(RefPathSchema).optional(),
  }).passthrough().optional(),
  od: z.object({
    kind:     z.enum(['skill', 'scenario', 'atom', 'bundle']).optional(),
    taskKind: z.enum(['new-generation', 'code-migration', 'figma-migration', 'tune-collab']).optional(),
    mode:     z.string().optional(),
    platform: z.string().optional(),
    scenario: z.string().optional(),
    engineRequirements: z.object({
      od: z.string().optional(),
    }).passthrough().optional(),
    preview: z.object({
      type:   z.string().optional(),
      entry:  z.string().optional(),
      poster: z.string().optional(),
      video:  z.string().optional(),
      gif:    z.string().optional(),
    }).passthrough().optional(),
    useCase: z.object({
      query: z.union([z.string(), LocalizedTextSchema]).optional(),
      exampleOutputs: z.array(z.object({
        path:  z.string(),
        title: z.string().optional(),
      }).passthrough()).optional(),
    }).passthrough().optional(),
    context: z.object({
      skills:        z.array(ReferenceSchema).optional(),
      designSystem:  z.union([
        ReferenceSchema,
        z.object({ ref: z.string().optional(), primary: z.boolean().optional() }).passthrough(),
      ]).optional(),
      craft:         z.array(z.string()).optional(),
      assets:        z.array(z.string()).optional(),
      claudePlugins: z.array(ReferenceSchema).optional(),
      mcp:           z.array(McpServerSpecSchema).optional(),
      atoms:         z.array(z.string()).optional(),
    }).passthrough().optional(),
    pipeline: PluginPipelineSchema.optional(),
    genui: z.object({
      surfaces: z.array(GenUISurfaceSpecSchema).optional(),
    }).passthrough().optional(),
    connectors: z.object({
      required: z.array(PluginConnectorRefSchema).optional(),
      optional: z.array(PluginConnectorRefSchema).optional(),
    }).passthrough().optional(),
    inputs: z.array(InputFieldSchema).optional(),
    // Config keys the plugin needs (API keys / app id+secret). The user fills
    // values per-plugin in the plugin editor; the daemon injects them as env
    // vars into this plugin's runs. See PluginConfigKeySchema.
    config: z.array(PluginConfigKeySchema).optional(),
    // Optional path to an existing `.env` the plugin already reads (e.g. a
    // workbench's). Supports `~` and `${OD_WORKBENCH_DIR}`. The daemon reads it
    // so the editor reflects already-configured keys AND injects them into runs
    // (per-plugin `pluginConfig` overrides these).
    configEnvFile: z.string().optional(),
    // Account-profile support. A plugin that drives several distinct accounts
    // (e.g. 公众号发布) declares which `od.config` keys are PER-ACCOUNT
    // credentials here; the operator manages named account profiles (each with
    // its own credentials + writing persona) in the editor, and the run's first
    // step picks one. See AccountProfile in api/plugin-source.ts.
    accounts: z.object({
      credentialKeys: z.array(z.string()).optional(),
    }).passthrough().optional(),
    capabilities: z.array(z.string()).optional(),
    // Workflow-mode declaration. When present, the host renders a step
    // rail from these stages and the agent drives the run stage by stage
    // with human gates. See WorkflowStageSchema above.
    workflow: PluginWorkflowSchema.optional(),
  }).passthrough().optional(),
}).passthrough();

export type PluginManifest = z.infer<typeof PluginManifestSchema>;
