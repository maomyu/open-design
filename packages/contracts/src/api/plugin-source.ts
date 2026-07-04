// Direct plugin editing — the operator edits a plugin's prompts in place and
// re-registers ("publishes") it so the next run uses the new prompts. The
// plugin IS the asset: its prompts are just files (SKILL.md body + the
// kickoff query in open-design.json), so editing is transparent, portable,
// and version-controllable — no hidden preference layer.

// How a node's parallel child options are chosen (mirror of the manifest
// WorkflowBranch). `select`: 'single' = pick exactly one; 'multi' = pick
// one-or-more and EACH picked branch runs a pass, outputs merged. `pick`:
// 'ask' = the running agent asks via AskUserQuestion; 'input' = resolved from
// an input value (legacy). Absent on a stage/mode → legacy flat modes.
export interface PluginSourceStageBranch {
  select: 'single' | 'multi';
  pick: 'ask' | 'input';
}

// A level-2 leaf option nested under a mode (e.g. "真抓热榜" → each scrape
// method). Nesting is capped at two levels; a submode has no further children.
export interface PluginSourceStageSubMode {
  id: string;
  label: string;
  prompt: string;
}

// A per-mode prompt slot inside a step (e.g. the topic step's "AI suggest" vs
// "scrape via bb-browser" paths). Each mode's prompt is tuned independently. A
// mode may itself fork: `branch` + nested `modes` (level-2 submodes) let e.g.
// "真抓热榜" fan out into several user-selectable scrape methods.
export interface PluginSourceStageMode {
  id: string;
  label: string;
  prompt: string;
  branch?: PluginSourceStageBranch;
  modes?: PluginSourceStageSubMode[];
}

// A workflow step as edited in the plugin editor. The full manifest stage
// (`od.workflow.stages[]`) may carry extra fields (title_i18n, passthrough);
// this is the flattened, operator-editable view. `gate` is the human
// checkpoint after the step: 'confirm' (approve/reject), 'choice' (pick), or
// 'none'. `prompt` is the step's own methodology — what decides that step's
// output effect/style — composed into the run prompt by the daemon. `modes`
// are optional per-mode prompt slots. These must stay in sync with the steps
// described in the SKILL.md / query prose.
export interface PluginSourceStage {
  id: string;
  title: string;
  gate: 'confirm' | 'choice' | 'none';
  prompt: string;
  /** How this stage's modes are chosen (single/multi fork). Absent → legacy
   *  flat modes composed together. */
  branch?: PluginSourceStageBranch;
  modes: PluginSourceStageMode[];
  /** Global skill ids bound to this step (`od.workflow.stages[].skills[].ref`).
   *  The daemon injects each bound skill's body under this step's prompt
   *  block at compose time, scoping that methodology to this stage. */
  skills: string[];
}

export interface PluginSourceResponse {
  id: string;
  /** The plugin's SKILL.md body (the per-step methodology / prompts). */
  skill: string;
  /** The kickoff brief (`od.useCase.query`) the composer is seeded with.
   *  Localized maps are flattened to the operator's locale for editing. */
  query: string;
  /** The workflow step skeleton (`od.workflow.stages`). Empty for plugins
   *  that declare no workflow. */
  stages: PluginSourceStage[];
  /** Whether the on-disk source is editable (false for read-only sources). */
  editable: boolean;
}

export interface UpdatePluginSourceRequest {
  /** New SKILL.md body. Omit to leave unchanged. */
  skill?: string;
  /** New kickoff query. Omit to leave unchanged. */
  query?: string;
  /** New workflow steps. Omit to leave unchanged; pass [] to clear. */
  stages?: PluginSourceStage[];
}

export interface UpdatePluginSourceResponse {
  id: string;
  /** True once the edits were written and the plugin re-registered (live). */
  published: boolean;
}

// "AI 帮我改" — the operator describes the change in natural language and the
// configured model rewrites the prompts. The result is RETURNED (not written)
// so the operator reviews it and then saves via PUT /source.
export interface AssistEditRequest {
  /** Natural-language instruction, e.g. "选题步只给 3 个但每个更狠". */
  instruction: string;
  /** Current prompts to edit (sent so the model has the full context). */
  skill?: string;
  query?: string;
  /** Current workflow steps, sent so the model keeps them in sync when the
   *  instruction adds/removes/renames a step. */
  stages?: PluginSourceStage[];
  // Chat config so the daemon resolves the same provider as the user's chat
  // (mirrors /api/memory/extract). Local-CLI agents only need chatAgentId.
  chatAgentId?: string;
  chatModel?: string;
  chatProvider?: unknown;
}

export interface AssistEditResponse {
  /** The model's proposed SKILL.md body. */
  skill: string;
  /** The model's proposed kickoff query. */
  query: string;
  /** The model's proposed workflow steps, kept consistent with skill/query. */
  stages: PluginSourceStage[];
}

// Scoped single-field rewrite — "AI-edit just this step/mode prompt". Sends
// only the one piece of text + the instruction, so it's far faster than a
// whole-plugin assist and can't drift other fields.
export interface AssistFieldRequest {
  /** Natural-language instruction for this one field. */
  instruction: string;
  /** The current text to rewrite. */
  text: string;
  /** Human label for context, e.g. "热点选题 · AI 建议 模式". */
  label?: string;
  chatAgentId?: string;
  chatModel?: string;
  chatProvider?: unknown;
}

export interface AssistFieldResponse {
  /** The rewritten text. */
  text: string;
}

// Edit history — every save snapshots the pre-edit source so hand edits and
// AI rewrites alike can be rolled back. Version ids are save timestamps.
export interface PluginVersionSummary {
  id: string;
  savedAt: number;
}

export interface ListPluginVersionsResponse {
  versions: PluginVersionSummary[];
}

export interface RollbackPluginSourceRequest {
  versionId: string;
}

export interface RollbackPluginSourceResponse {
  id: string;
  /** The restored editable source, so the editor can refresh in place. */
  source: PluginSourceResponse;
}

// Per-plugin config (third-party API keys, app id/secret, etc.). The plugin
// DECLARES which keys it needs via `od.config` in its manifest; the operator
// fills the VALUES here in the plugin editor; the daemon stores them in
// app-config and injects them as env vars into this plugin's runs only. Secret
// values are never returned — the server reports `set` (whether a value is
// saved) and returns the plaintext only for non-secret keys.
export interface PluginConfigKeyView {
  /** Env-var style key the plugin reads at runtime. */
  name: string;
  label?: string;
  description?: string;
  required?: boolean;
  /** Resolved (manifest default is true) — secret values are masked. */
  secret: boolean;
  /** Where to obtain the key. */
  link?: string;
  /** Whether a value is currently saved for this key (in pluginConfig OR the
   *  plugin's declared `.env`). */
  set: boolean;
  /** Where the saved value comes from: 'config' = entered in the editor
   *  (pluginConfig), 'env' = the plugin's existing `.env`. Absent when unset. */
  source?: 'config' | 'env';
  /** Present only for non-secret keys; secret keys omit this. */
  value?: string;
  /** True when this key is claimed by `od.accounts.credentialKeys`: its value
   *  is configured PER ACCOUNT (账号区), and the plugin-level config panel
   *  must not offer a value input for it — plugin-level/`.env` values for
   *  these keys are stripped at run time (exclusive account injection). */
  perAccount?: boolean;
}

export interface PluginConfigResponse {
  id: string;
  keys: PluginConfigKeyView[];
  /** Whether config can be written (false for read-only/uneditable plugins). */
  editable: boolean;
}

export interface UpdatePluginConfigRequest {
  /** KEY -> value to set. Empty string clears that key. Keys absent from the
   *  map are left unchanged. */
  values: Record<string, string>;
}

export interface UpdatePluginConfigResponse {
  id: string;
  saved: boolean;
}

// Account profiles — a plugin (e.g. 公众号发布) can drive several distinct
// accounts, each with its OWN credentials AND its own writing persona, because
// different accounts read differently. The operator manages profiles in the
// editor; at runtime the workflow's first "pick account" step selects one and
// the daemon injects that account's persona/samples into the writing step and
// its credentials into the publishing step. Credentials are secret and stored
// encrypted per-plugin (like pluginConfig); they are never returned in full.
export interface AccountStyle {
  /** Free-text persona / voice description injected into the writing step. */
  persona?: string;
  /** Optional reference sample article bodies the agent studies before
   *  writing, so the output imitates this account's established voice. */
  samples?: string[];
}

export interface AccountProfileView {
  id: string;
  /** Human-facing account name shown in the picker (e.g. 「报考日记」). */
  name: string;
  style: AccountStyle;
  /** Per-credential-key presence flags (secret values never returned). The
   *  key set is the plugin's declared credential keys (see od.config). */
  credentials: Record<string, boolean>;
}

export interface AccountProfilesResponse {
  id: string;
  /** Which credential keys each account carries (plugin's declared secrets). */
  credentialKeys: string[];
  accounts: AccountProfileView[];
  /** Whether accounts can be written (false for read-only plugins). */
  editable: boolean;
}

export interface UpsertAccountProfileRequest {
  /** Omit to create a new profile; provide to update an existing one. */
  id?: string;
  name: string;
  style?: AccountStyle;
  /** KEY -> secret value to set. Empty string clears that credential. Keys
   *  absent from the map are left unchanged. */
  credentials?: Record<string, string>;
}

export interface UpsertAccountProfileResponse {
  id: string;
  saved: boolean;
  account: AccountProfileView;
}

export interface DeleteAccountProfileResponse {
  id: string;
  deleted: boolean;
}
