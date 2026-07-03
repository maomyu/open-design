// AI-assisted plugin creation ("从一段业务描述起草一个插件"). The operator
// describes the business workflow in natural language; the daemon drafts the
// full editable surface of a workflow plugin — SKILL.md body, kickoff query,
// and od.workflow stages — in the exact shape the plugin editor
// (PluginSourceResponse) already consumes, so the draft drops straight into
// the existing review/edit UI before anything is written to disk.
//
// The SKILL.md portion follows the same skill-creator authoring spec as
// /api/skills/draft (imperative voice, explain-the-why, <500-line body);
// the stage portion follows the od.workflow conventions established by the
// bundled short-video-copy plugin (per-stage prompts, human gates, optional
// per-mode prompt slots).

import type { PluginSourceStage } from './plugin-source.js';

export interface CreatePluginDraftRequest {
  /** Natural-language description of the business workflow: what it does,
   *  the steps involved, where a human should confirm, expected outputs. */
  description: string;
  /** Preferred plugin id (kebab-case). Omit to let the model pick one. */
  name?: string;
  // Chat config so the daemon resolves the same provider as the user's chat.
  chatAgentId?: string;
  chatModel?: string;
  chatProvider?: unknown;
}

/** Spec-conformance finding from the plugin draft validator. `error` blocks
 *  saving; `warning` is advisory. */
export interface PluginDraftDiagnostic {
  severity: 'error' | 'warning';
  code:
    | 'NAME_REQUIRED'
    | 'NAME_INVALID'
    | 'TITLE_REQUIRED'
    | 'QUERY_REQUIRED'
    | 'SKILL_REQUIRED'
    | 'SKILL_TOO_LONG'
    | 'NO_STAGES'
    | 'STAGE_PROMPT_EMPTY';
  message: string;
}

export interface CreatePluginDraftResponse {
  /** Proposed plugin id (kebab-case slug). */
  name: string;
  /** Display title for the gallery card. */
  title: string;
  /** One-line manifest description. */
  description: string;
  /** Kickoff query (`od.useCase.query`) the composer is seeded with. */
  query: string;
  /** SKILL.md body — the plugin's global methodology. */
  skill: string;
  /** Workflow steps in the editor's flattened shape (`od.workflow.stages`). */
  stages: PluginSourceStage[];
  /** Spec-conformance findings for the review UI to surface inline. */
  diagnostics: PluginDraftDiagnostic[];
}

// Saving a reviewed draft creates a NEW user plugin: the daemon writes the
// folder (SKILL.md + open-design.json) under the user plugins root and
// registers it with sourceKind 'user', so it is immediately applicable AND
// editable through the existing /api/plugins/:id/source editor.
export interface SavePluginDraftRequest {
  name: string;
  title: string;
  description?: string;
  query: string;
  skill: string;
  stages: PluginSourceStage[];
  /** Replace an existing plugin with the same id (default false → 409). */
  overwrite?: boolean;
}

export interface SavePluginDraftResponse {
  id: string;
  /** True once the folder was written and the plugin registered (live). */
  published: boolean;
}
