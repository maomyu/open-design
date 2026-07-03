// AI-assisted skill creation ("从一句话起草一个技能"). The operator describes
// what the skill should do in natural language; the daemon drafts a complete
// SKILL.md (frontmatter + body) plus eval seed prompts, following the
// Anthropic skill-creator authoring spec:
//
//   - frontmatter `name` + `description` are required; the description is the
//     primary triggering mechanism, so it must say WHAT the skill does AND
//     WHEN to use it (slightly "pushy" to combat under-triggering).
//   - body stays under ~500 lines (progressive disclosure: split overflow
//     into references/), uses imperative voice, and explains the why behind
//     constraints instead of bare MUSTs.
//   - 2-3 realistic eval prompts seed the skill's `evals/evals.json` so the
//     improve-loop (run → review → rewrite) has test cases from day one.
//
// The draft is RETURNED for review (never written); the operator saves via
// the existing POST /api/skills/import, which accepts the same field shape.

export interface CreateSkillDraftRequest {
  /** Natural-language description of the skill: what it should do, when it
   *  should trigger, expected output. The richer this is, the better the
   *  draft — the UI's intent-capture form concatenates its answers here. */
  description: string;
  /** Preferred skill id (kebab-case). Omit to let the model pick one. */
  name?: string;
  /** Generate eval seed prompts (default true). */
  withEvals?: boolean;
  // Chat config so the daemon resolves the same provider as the user's chat
  // (mirrors /api/plugins/:id/source/assist). Local-CLI agents only need
  // chatAgentId.
  chatAgentId?: string;
  chatModel?: string;
  chatProvider?: unknown;
}

/** One eval seed, mirroring the skill-creator `evals/evals.json` entry shape
 *  (persisted on save as snake_case `expected_output` for compatibility with
 *  the upstream eval tooling). */
export interface SkillDraftEval {
  id: number;
  /** A realistic user task prompt — the kind of thing a user would actually
   *  type, not an abstract request. */
  prompt: string;
  /** Description of the expected result, used by graders/reviewers. */
  expectedOutput: string;
}

/** Spec-conformance finding from the draft validator. `error` blocks saving;
 *  `warning` is advisory (e.g. body over the ~500-line guideline). */
export interface SkillDraftDiagnostic {
  severity: 'error' | 'warning';
  code:
    | 'NAME_REQUIRED'
    | 'NAME_INVALID'
    | 'DESCRIPTION_REQUIRED'
    | 'DESCRIPTION_SHORT'
    | 'BODY_REQUIRED'
    | 'BODY_TOO_LONG'
    | 'NO_TRIGGERS';
  message: string;
}

export interface CreateSkillDraftResponse {
  /** Proposed skill id (kebab-case slug). */
  name: string;
  /** Frontmatter description — what the skill does + when to use it. */
  description: string;
  /** Trigger keywords/phrases for the frontmatter `triggers` list. */
  triggers: string[];
  /** SKILL.md markdown body (everything below the frontmatter). */
  body: string;
  /** Eval seed prompts ([] when withEvals is false or the model omitted them). */
  evals: SkillDraftEval[];
  /** Spec-conformance findings for the review UI to surface inline. */
  diagnostics: SkillDraftDiagnostic[];
}
