import type { Express } from 'express';
import type {
  CreateSkillDraftResponse,
  SkillDraftDiagnostic,
  SkillDraftEval,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import { slugifySkillName } from './skills.js';
import { listInstalledPlugins } from './plugins/registry.js';
import { callModelOnce } from './memory-llm.js';

export interface RegisterSkillDraftRoutesDeps extends RouteDeps<'db' | 'http' | 'paths'> {}

// Which plugins reference each skill — both the global injections
// (od.context.skills[].ref) and the stage-level bindings
// (od.workflow.stages[].skills[].ref). Path-based refs (./SKILL.md) are a
// plugin's own local skill, not a library reference, so they don't count.
// Exported for unit tests.
export function computeSkillUsage(
  plugins: Array<{ id: string; manifest?: unknown }>,
): Record<string, string[]> {
  const usage: Record<string, string[]> = {};
  const add = (skillId: unknown, pluginId: string) => {
    if (typeof skillId !== 'string' || !skillId.trim()) return;
    const key = skillId.trim();
    const list = (usage[key] ??= []);
    if (!list.includes(pluginId)) list.push(pluginId);
  };
  for (const plugin of plugins) {
    const od = (plugin.manifest as { od?: { context?: { skills?: unknown }; workflow?: { stages?: unknown } } })?.od;
    const contextSkills = Array.isArray(od?.context?.skills) ? od.context.skills : [];
    for (const ref of contextSkills) add((ref as { ref?: unknown })?.ref, plugin.id);
    const stages = Array.isArray(od?.workflow?.stages) ? od.workflow.stages : [];
    for (const stage of stages) {
      const stageSkills = Array.isArray((stage as { skills?: unknown })?.skills)
        ? ((stage as { skills: unknown[] }).skills)
        : [];
      for (const ref of stageSkills) {
        add(typeof ref === 'string' ? ref : (ref as { ref?: unknown })?.ref, plugin.id);
      }
    }
  }
  return usage;
}

// The drafting prompt encodes the Anthropic skill-creator authoring spec, so
// every skill drafted through Open Design lands in the same shape the
// upstream eval/improve tooling expects. Spec source: the skill-creator
// SKILL.md ("Skill Writing Guide" + "Description Optimization" sections).
const DRAFT_SYSTEM_PROMPT = [
  '你在为 Open Design 起草一个 Agent Skill(SKILL.md)。用户给你一段自然语言描述(这个技能要做什么、什么时候用、期望产出),你产出一份完整的技能草稿。',
  '',
  '遵循 Anthropic skill-creator 撰写规范:',
  '- `name`:kebab-case 短标识(小写字母/数字/短横线),贴合技能内容。',
  '- `description`:这是技能能否被正确触发的唯一依据,必须同时写清「做什么」和「什么时候用」。模型有触发不足(undertrigger)的倾向,所以 description 要稍微主动一点——列出会用到它的具体场景和用户说法,哪怕用户没有点名这个技能。和触发时机有关的信息全部放 description,不要放正文。',
  '- `triggers`:5-10 个用户真实会说的触发词/短语(中英都可,贴合用户描述的语言)。',
  '- `body`(SKILL.md 正文):',
  '  * 用祈使句直接给指令;解释每条约束背后的「为什么」,而不是堆砌全大写的 MUST/NEVER——模型有良好的意图理解力,讲清原因比命令更有效。',
  '  * 控制在 500 行以内(渐进式披露:超长的参考资料应拆到 references/ 并在正文里说明何时去读,本次起草正文里直接精简)。',
  '  * 输出格式要求用明确的模板段落给出(「## 输出结构」+ 模板)。',
  '  * 配 1-2 个 Input/Output 示例(Examples 模式),让执行者看到典型输入输出长什么样。',
  '  * 保持通用,不要过拟合到某一个具体例子;宁可给方法和判断标准,不要写死枚举。',
  '- `evals`:2-3 个真实感测试 prompt——像真实用户会打的字(具体、带细节、可以口语化),不是抽象需求;每个配一句 expected_output 描述预期结果。这些会存进技能的 evals/evals.json,供后续「运行→评审→改进」循环使用。',
  '',
  '严格只返回一个 JSON 对象,不要任何解释、不要代码围栏以外的文字:',
  '{"name":"<kebab-case id>","description":"<做什么+何时用>","triggers":["..."],"body":"<SKILL.md 正文 markdown>","evals":[{"id":1,"prompt":"<真实用户任务>","expected_output":"<预期结果描述>"}]}',
].join('\n');

interface ParsedDraft {
  name?: string;
  description?: string;
  triggers?: string[];
  body?: string;
  evals?: SkillDraftEval[];
}

// Tolerant parse of the model's JSON output (strip ``` fences, find the
// object) — same defensive strategy as plugin-edit-routes' parseAssistJson.
export function parseSkillDraftJson(raw: string): ParsedDraft | null {
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
        ...(typeof obj.description === 'string' ? { description: obj.description } : {}),
        ...(Array.isArray(obj.triggers)
          ? { triggers: obj.triggers.filter((t): t is string => typeof t === 'string' && t.trim().length > 0) }
          : {}),
        ...(typeof obj.body === 'string' ? { body: obj.body } : {}),
        ...(Array.isArray(obj.evals) ? { evals: coerceDraftEvals(obj.evals) } : {}),
      };
    } catch {
      /* try next */
    }
  }
  return null;
}

function coerceDraftEvals(value: unknown[]): SkillDraftEval[] {
  const out: SkillDraftEval[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const e = entry as Record<string, unknown>;
    const prompt = typeof e.prompt === 'string' ? e.prompt.trim() : '';
    if (!prompt) continue;
    const expected =
      typeof e.expected_output === 'string'
        ? e.expected_output
        : typeof e.expectedOutput === 'string'
          ? e.expectedOutput
          : '';
    out.push({ id: out.length + 1, prompt, expectedOutput: expected });
  }
  return out;
}

// The spec's description guidance: it must carry enough "when to use" signal
// to trigger reliably. We can't judge semantics server-side, but a very short
// description provably can't contain both "what" and "when" — flag it.
const DESCRIPTION_MIN_CHARS = 50;
// The spec's progressive-disclosure guideline: SKILL.md body should stay
// under ~500 lines; overflow belongs in references/ with pointers.
const BODY_MAX_LINES = 500;

// Spec-conformance check for a drafted (or hand-edited) skill. Errors block
// saving; warnings surface inline in the review UI / CLI output so the
// operator can decide. Exported for unit tests.
export function validateSkillDraft(draft: {
  name?: string;
  description?: string;
  triggers?: string[];
  body?: string;
}): SkillDraftDiagnostic[] {
  const out: SkillDraftDiagnostic[] = [];
  const name = typeof draft.name === 'string' ? draft.name.trim() : '';
  if (!name) {
    out.push({ severity: 'error', code: 'NAME_REQUIRED', message: 'name is required' });
  } else if (slugifySkillName(name) !== name) {
    out.push({
      severity: 'error',
      code: 'NAME_INVALID',
      message: `name must be a kebab-case slug (a-z, 0-9, dash); got "${name}"`,
    });
  }
  const description = typeof draft.description === 'string' ? draft.description.trim() : '';
  if (!description) {
    out.push({
      severity: 'error',
      code: 'DESCRIPTION_REQUIRED',
      message: 'description is required — it is the primary triggering mechanism',
    });
  } else if (description.length < DESCRIPTION_MIN_CHARS) {
    out.push({
      severity: 'warning',
      code: 'DESCRIPTION_SHORT',
      message:
        'description is too short to carry both what the skill does and when to use it; expand it with concrete trigger contexts',
    });
  }
  const body = typeof draft.body === 'string' ? draft.body.trim() : '';
  if (!body) {
    out.push({ severity: 'error', code: 'BODY_REQUIRED', message: 'SKILL.md body is required' });
  } else {
    const lines = body.split(/\r?\n/).length;
    if (lines > BODY_MAX_LINES) {
      out.push({
        severity: 'warning',
        code: 'BODY_TOO_LONG',
        message: `body is ${lines} lines; the spec recommends staying under ${BODY_MAX_LINES} (move reference material into references/)`,
      });
    }
  }
  if (!Array.isArray(draft.triggers) || draft.triggers.length === 0) {
    out.push({
      severity: 'warning',
      code: 'NO_TRIGGERS',
      message: 'no trigger phrases — add a few realistic user phrasings to improve discovery',
    });
  }
  return out;
}

/**
 * POST /api/skills/draft — draft a complete skill from a natural-language
 * description, following the skill-creator authoring spec. The draft is
 * returned for review (never written); the operator saves the reviewed draft
 * via the existing POST /api/skills/import, which accepts the same fields.
 */
export function registerSkillDraftRoutes(app: Express, ctx: RegisterSkillDraftRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR, PROJECT_ROOT } = ctx.paths;

  // GET /api/skills/usage — which plugins reference each skill. Powers the
  // skill library's "referenced by" column and `od skill usage`.
  app.get('/api/skills/usage', (_req, res) => {
    try {
      res.json({ usage: computeSkillUsage(listInstalledPlugins(db)) });
    } catch (err) {
      sendApiError(res, 500, 'SKILL_USAGE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.post('/api/skills/draft', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const description = typeof body.description === 'string' ? body.description.trim() : '';
      if (!description) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'description is required');
      }
      const requestedName = typeof body.name === 'string' ? body.name.trim() : '';
      const withEvals = body.withEvals !== false;
      const user = [
        '技能描述:',
        description,
        ...(requestedName ? ['', `期望的技能 id:${requestedName}`] : []),
        ...(withEvals ? [] : ['', '本次不需要 evals,返回 "evals": []。']),
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
          // Drafting a full SKILL.md is a larger generation than memory
          // extraction — same headroom as the plugin assist route.
          timeoutMs: 240_000,
        });
      } catch (err) {
        if ((err as { code?: string })?.code === 'NO_PROVIDER') {
          return sendApiError(
            res,
            400,
            'NO_MODEL_PROVIDER',
            '未配置可用模型:请在设置里选好本地 CLI 或填好模型 Key 后再用「AI 起草技能」。',
          );
        }
        throw err;
      }

      const parsed = parseSkillDraftJson(raw);
      if (!parsed || (!parsed.body && !parsed.description)) {
        return sendApiError(res, 502, 'DRAFT_PARSE_FAILED', '模型返回的内容无法解析为技能草稿,请重试或换个说法。');
      }
      // Normalize the model's name to a valid slug; fall back to the
      // operator's requested name when the model omitted one.
      const name = slugifySkillName(parsed.name || requestedName) || '';
      const draft = {
        name,
        description: parsed.description ?? '',
        triggers: parsed.triggers ?? [],
        body: parsed.body ?? '',
        evals: withEvals ? (parsed.evals ?? []) : [],
      };
      const out: CreateSkillDraftResponse = {
        ...draft,
        diagnostics: validateSkillDraft(draft),
      };
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'SKILL_DRAFT_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
