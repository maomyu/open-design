// Render a plugin's per-step prompts into a markdown block that the daemon
// appends to the injected SKILL.md at compose time. This is what makes the
// `od.workflow.stages[].prompt` (and per-mode prompts) actually drive the run:
// each step's prompt decides that step's output effect/style, and the agent
// follows them in order, honoring each step's gate.
//
// The step skeleton (id/title/gate) also drives the UI step rail; here we only
// turn the prompt bodies into agent-facing instructions.

import { resolveLocalizedText } from '@open-design/contracts';

const LOCALE = 'zh-CN';

function text(localized: unknown, plain: unknown): string {
  const loc = resolveLocalizedText(localized as never, LOCALE);
  if (loc) return loc;
  return typeof plain === 'string' ? plain : '';
}

interface RawMode {
  id?: unknown;
  label?: unknown;
  label_i18n?: unknown;
  prompt?: unknown;
  prompt_i18n?: unknown;
}
interface RawStage {
  id?: unknown;
  title?: unknown;
  title_i18n?: unknown;
  gate?: unknown;
  prompt?: unknown;
  prompt_i18n?: unknown;
  modes?: unknown;
  skills?: unknown;
}

/** Resolves a stage-bound skill reference (global skill id) to its injectable
 *  content. Return null for unknown ids — the stage renders without it. */
export type StageSkillResolver = (skillId: string) => { name: string; body: string } | null;

const GATE_NOTE: Record<string, string> = {
  confirm: '（完成后用 AskUserQuestion 让用户确认/驳回，再进下一步）',
  choice: '（完成后用 AskUserQuestion 让用户做出选择，再继续）',
  none: '',
};

/**
 * Returns the markdown block for the plugin's step prompts, or '' when the
 * plugin declares no workflow / no step prompts (so non-workflow plugins are
 * unaffected).
 */
export function renderStagePromptsBlock(
  manifest: unknown,
  resolveSkill?: StageSkillResolver,
): string {
  const stages = (manifest as { od?: { workflow?: { stages?: unknown } } })?.od?.workflow?.stages;
  if (!Array.isArray(stages) || stages.length === 0) return '';

  const sections: string[] = [];
  let n = 0;
  for (const raw of stages as RawStage[]) {
    const stage = raw ?? {};
    const id = typeof stage.id === 'string' ? stage.id : '';
    if (!id) continue;
    n += 1;
    const title = text(stage.title_i18n, stage.title) || id;
    const gate = typeof stage.gate === 'string' ? stage.gate : 'none';
    const prompt = text(stage.prompt_i18n, stage.prompt).trim();
    const gateNote = GATE_NOTE[gate] ?? '';

    const lines: string[] = [`### 步骤 ${n} · ${title} ${gateNote}`.trimEnd()];
    if (prompt) lines.push(prompt);

    const modes = Array.isArray(stage.modes) ? (stage.modes as RawMode[]) : [];
    const renderedModes = modes
      .map((m) => {
        const mid = typeof m?.id === 'string' ? m.id : '';
        if (!mid) return '';
        const label = text(m.label_i18n, m.label) || mid;
        const mp = text(m.prompt_i18n, m.prompt).trim();
        return mp ? `**模式「${label}」**\n${mp}` : '';
      })
      .filter(Boolean);
    if (renderedModes.length > 0) {
      lines.push('（这一步有多种模式，按相关输入选匹配的那个执行：）');
      lines.push(renderedModes.join('\n\n'));
    }

    // Stage-bound skills — inject each bound skill's body UNDER this step so
    // its methodology applies to this stage only (the orchestration core:
    // different steps run on different skills). Unresolvable refs are skipped
    // silently; the step still runs on its own prompt.
    const skillRefs = Array.isArray(stage.skills) ? stage.skills : [];
    if (resolveSkill && skillRefs.length > 0) {
      const renderedSkills: string[] = [];
      for (const ref of skillRefs) {
        const skillId =
          typeof (ref as { ref?: unknown })?.ref === 'string'
            ? ((ref as { ref: string }).ref)
            : typeof ref === 'string'
              ? ref
              : '';
        if (!skillId) continue;
        const skill = resolveSkill(skillId);
        if (!skill || !skill.body.trim()) continue;
        renderedSkills.push(`#### 本步技能「${skill.name}」\n${skill.body.trim()}`);
      }
      if (renderedSkills.length > 0) {
        lines.push('（这一步绑定了下列技能，执行本步时按这些技能的方法操作：）');
        lines.push(renderedSkills.join('\n\n'));
      }
    }

    if (lines.length > 1) sections.push(lines.join('\n\n'));
  }

  if (sections.length === 0) return '';
  return (
    '\n\n---\n\n## 各步骤提示词（workflow steps）\n\n' +
    '下面是本工作流每一步自己的提示词，**决定该步产出的效果与风格**。' +
    '严格按步骤顺序推进，每步产出对应结果后按括注的闸门处理，不要一口气跑完。\n\n' +
    sections.join('\n\n')
  );
}
