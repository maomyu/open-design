// Direct plugin editing — the operator edits a plugin's prompts in place and
// re-registers ("publishes") it so the next run uses the new prompts. The
// plugin IS the asset: its prompts are just files (SKILL.md body + the
// kickoff query in open-design.json), so editing is transparent, portable,
// and version-controllable — no hidden preference layer.

export interface PluginSourceResponse {
  id: string;
  /** The plugin's SKILL.md body (the per-step methodology / prompts). */
  skill: string;
  /** The kickoff brief (`od.useCase.query`) the composer is seeded with.
   *  Localized maps are flattened to the operator's locale for editing. */
  query: string;
  /** Whether the on-disk source is editable (false for read-only sources). */
  editable: boolean;
}

export interface UpdatePluginSourceRequest {
  /** New SKILL.md body. Omit to leave unchanged. */
  skill?: string;
  /** New kickoff query. Omit to leave unchanged. */
  query?: string;
}

export interface UpdatePluginSourceResponse {
  id: string;
  /** True once the edits were written and the plugin re-registered (live). */
  published: boolean;
}
