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

interface RawBranch {
  select?: unknown;
  pick?: unknown;
}
interface RawMode {
  id?: unknown;
  label?: unknown;
  label_i18n?: unknown;
  prompt?: unknown;
  prompt_i18n?: unknown;
  branch?: unknown;
  modes?: unknown;
}
interface RawStage {
  id?: unknown;
  title?: unknown;
  title_i18n?: unknown;
  gate?: unknown;
  prompt?: unknown;
  prompt_i18n?: unknown;
  branch?: unknown;
  modes?: unknown;
  skills?: unknown;
}

// The instruction line that precedes a fork's options. `branch` decides how the
// user/agent chooses among them:
//   - absent            → legacy: match one option by the relevant input value.
//   - pick 'input'      → same legacy input-driven match, made explicit.
//   - pick 'ask' single → the agent asks (AskUserQuestion) and the user picks ONE.
//   - pick 'ask' multi  → the agent asks with multiSelect; EACH option the user
//                         picks runs its own pass, outputs merged/de-duped.
// In 自动模式 the 'ask' variants collapse: no AskUserQuestion — the agent
// resolves the fork itself (input value first, else default / best judgment).
function branchNote(branch: RawBranch | undefined, kind: '模式' | '子选项', autoMode = false): string {
  const pick = typeof branch?.pick === 'string' ? branch.pick : 'ask';
  const multi = branch?.select === 'multi';
  if (!branch || pick === 'input') {
    return `（这一步有多种${kind}，按相关输入值选匹配的那个执行：）`;
  }
  if (autoMode) {
    return `（这一步有多种${kind}。自动模式：不要问用户——有对应输入值按输入匹配，没有就选默认或你判断最合适的一种直接执行：）`;
  }
  if (multi) {
    return (
      `（这一步有多种${kind}，**用 AskUserQuestion 让用户多选**（multiSelect）；` +
      `用户勾选的每一种都要**各跑一遍**、把各自结果合并去重，某一种缺工具/失败就如实降级说明，别影响其它种：）`
    );
  }
  return `（这一步有多种${kind}，**用 AskUserQuestion 让用户单选一种**再执行：）`;
}

/** Resolves a stage-bound skill reference (global skill id) to its injectable
 *  content. Return null for unknown ids — the stage renders without it. */
export type StageSkillResolver = (skillId: string) => { name: string; body: string } | null;

const GATE_NOTE: Record<string, string> = {
  confirm: '（完成后用 AskUserQuestion 让用户确认/驳回，再进下一步）',
  choice: '（完成后用 AskUserQuestion 让用户做出选择，再继续）',
  none: '',
};

// 自动模式 gate note — replaces GATE_NOTE so the per-step instructions don't
// contradict the AUTO block in the user message. The outward-publish
// exception is restated here because it is the one gate auto mode keeps.
const AUTO_GATE_NOTE =
  '（自动模式：完成本步直接进下一步，不用 AskUserQuestion 征求确认；仅当本步要执行真正对外发布的上传动作时，仍须先做一次发布确认）';

/**
 * Returns the markdown block for the plugin's step prompts, or '' when the
 * plugin declares no workflow / no step prompts (so non-workflow plugins are
 * unaffected).
 */
export function renderStagePromptsBlock(
  manifest: unknown,
  resolveSkill?: StageSkillResolver,
  options?: { autoMode?: boolean },
): string {
  const autoMode = options?.autoMode === true;
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
    const gateNote = autoMode
      ? (gate === 'none' ? '' : AUTO_GATE_NOTE)
      : (GATE_NOTE[gate] ?? '');

    const lines: string[] = [`### 步骤 ${n} · ${title} ${gateNote}`.trimEnd()];
    if (prompt) lines.push(prompt);

    const modes = Array.isArray(stage.modes) ? (stage.modes as RawMode[]) : [];
    const renderedModes = modes
      .map((m) => {
        const mid = typeof m?.id === 'string' ? m.id : '';
        if (!mid) return '';
        const label = text(m.label_i18n, m.label) || mid;
        const mp = text(m.prompt_i18n, m.prompt).trim();
        const parts: string[] = [mp ? `**模式「${label}」**\n${mp}` : `**模式「${label}」**`];
        // Level-2 submodes (e.g. "真抓热榜" → each scrape method). Rendered as a
        // nested fork with its own single/multi note.
        const subs = Array.isArray(m.modes) ? (m.modes as RawMode[]) : [];
        const renderedSubs = subs
          .map((s) => {
            const sid = typeof s?.id === 'string' ? s.id : '';
            if (!sid) return '';
            const slabel = text(s.label_i18n, s.label) || sid;
            const sp = text(s.prompt_i18n, s.prompt).trim();
            return sp ? `- **${slabel}**：${sp}` : `- **${slabel}**`;
          })
          .filter(Boolean);
        if (renderedSubs.length > 0) {
          parts.push(branchNote(m.branch as RawBranch | undefined, '子选项', autoMode));
          parts.push(renderedSubs.join('\n'));
        }
        return parts.join('\n\n');
      })
      .filter(Boolean);
    if (renderedModes.length > 0) {
      lines.push(branchNote(stage.branch as RawBranch | undefined, '模式', autoMode));
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
  // 自动模式 rewrites the pacing sentence — the default one ends with
  // "不要一口气跑完", which is exactly what auto mode wants; contradicting it
  // here would leave the model torn between the two.
  const pacing = autoMode
    ? '本次运行为**自动模式**：严格按步骤顺序推进，做完一步直接进下一步，**全程不要用 AskUserQuestion 停下征求确认**（除各步括注里写明的对外发布确认外）。' +
      '没填的输入你自己定；岔路选默认或最合理的一种。缺 API Key/凭证时不要编造：说清缺哪个、到哪配（插件编辑页「插件配置」/「账号」区或左侧「账号」页），把进度写进 board.json 后结束本轮；用户配好后回复「继续」，你从 board.json 断点接着跑，已完成的步骤不重做。'
    : '严格按步骤顺序推进，每步产出对应结果后按括注的闸门处理，不要一口气跑完。';
  return (
    '\n\n---\n\n## 各步骤提示词（workflow steps）\n\n' +
    '下面是本工作流每一步自己的提示词，**决定该步产出的效果与风格**。' +
    pacing + '\n\n' +
    sections.join('\n\n')
  );
}

// One configured account for the roster block (mirror of PluginAccountRecord;
// credentials are NEVER passed here — only names/styles reach the prompt).
// Credential DELIVERY is not the model's job anymore: the daemon injects the
// chosen account's keys under their standard names at spawn time, so the
// roster carries no env-var mechanics.
export interface AccountRosterEntry {
  id: string;
  name: string;
  style?: { persona?: string; samples?: string[] };
}

/**
 * Account roster — injected for plugins that support account profiles
 * (`od.accounts`). Makes account selection the run's FIRST move and injects each
 * account's writing persona/samples so the writing step imitates that account's
 * voice. Credentials never appear here — only the env-var NAMES the publish step
 * should use for the chosen account. Returns '' for plugins without account
 * support.
 */
export function renderAccountRosterBlock(
  manifest: unknown,
  accounts: AccountRosterEntry[],
): string {
  const od = (manifest as { od?: { accounts?: unknown } } | undefined)?.od;
  if (!od || od.accounts === undefined) return '';
  if (accounts.length === 0) {
    return (
      '\n\n---\n\n## 账号（前置）\n' +
      '本插件按「账号」区分写作风格，但你还没在插件编辑页的「账号」区配置任何账号。' +
      '**开工第一步：提醒用户去插件编辑页 → 账号，先建一个账号**（填名称 + 写作风格/人设 + 凭证），再回来开工。别用空账号硬跑。'
    );
  }
  const entries = accounts.map((a) => {
    const parts = [`### 账号「${a.name}」（id: \`${a.id}\`）`];
    if (a.style?.persona?.trim()) parts.push(`写作风格 / 人设：${a.style.persona.trim()}`);
    if (a.style?.samples && a.style.samples.length > 0) {
      parts.push(
        '风格范文样本（写稿前先读它们、把腔调学到手再仿写，不要照抄）：\n' +
        a.style.samples.map((s, i) => `范文 ${i + 1}：\n${s}`).join('\n\n'),
      );
    }
    return parts.join('\n');
  });
  return (
    '\n\n---\n\n## 账号（前置——第 0 步必须先定）\n' +
    '**开场输入里已带账号名就直接用它、绝不复问（已选定的输入不复问）；账号为空时才用 AskUserQuestion ' +
    '在下面这些账号里让用户单选一个。** 不同账号写作风格不同，定下后**写稿严格按该账号的「写作风格 / 人设」和范文样本来**。' +
    '**发布凭证已由系统按选定账号自动注入为标准环境变量（如 `WECHAT_APPID`）——直接执行发布命令即可，' +
    '不要也不需要手动设置/覆盖任何凭证环境变量。** 若发布脚本报某个凭证缺失，如实告知用户缺哪个键、' +
    '引导去插件编辑页「账号」区给该账号补上——**不要换用别的账号重试**。别把凭证明文写进对话或看板。\n\n' +
    entries.join('\n\n')
  );
}
