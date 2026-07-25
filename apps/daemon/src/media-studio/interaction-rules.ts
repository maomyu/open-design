/**
 * 互动匹配规则引擎 —— 纯匹配层（无 DB、无副作用）。
 *
 * 给一条评论文本 + 一组规则,判定"该不该回、回什么"。这是自动评论回复的大脑:
 * 读评论(W3) → 本匹配器 → 命中则产出回复文案 → 走执行器(W4)拟人外发(受 W1 风控台账门控)。
 * 匹配决定是纯函数(规则集 + 评论 → 命中/不命中),便于单测;store 层做增删改查与账号过滤。
 */
import type { InteractionRule, InteractionRuleMatch } from '@open-design/contracts';

/** 把回复模板里的占位符替换成实际值。{author}=评论者昵称,{keyword}=命中的关键词。 */
export function renderReplyTemplate(template: string, vars: { author?: string; keyword?: string }): string {
  return template
    .replace(/\{author\}/g, vars.author ?? '')
    .replace(/\{keyword\}/g, vars.keyword ?? '');
}

/** 单条规则对评论文本的匹配:命中返回命中的关键词(regex 返回匹配子串),不命中返回 null。 */
function matchOne(rule: InteractionRule, text: string): string | null {
  const kws = (rule.keywords ?? []).filter((k) => typeof k === 'string' && k.length > 0);
  if (rule.matchMode === 'regex') {
    const pat = kws[0];
    if (!pat) return null;
    try {
      const m = text.match(new RegExp(pat, 'i'));
      return m ? (m[0] ?? '') : null;
    } catch {
      return null; // 坏正则当不命中,不炸
    }
  }
  const lowered = text.toLowerCase();
  if (rule.matchMode === 'exact') {
    const t = text.trim().toLowerCase();
    const kw = kws.find((k) => k.trim().toLowerCase() === t);
    return kw ?? null;
  }
  // contains(默认):评论含任一关键词即命中(大小写不敏感,对英文关键词友好;中文无影响)。
  const kw = kws.find((k) => lowered.includes(k.toLowerCase()));
  return kw ?? null;
}

/**
 * 从一组规则里为一条评论找最优命中。只看启用的,按优先级降序(同优先级按建时间升序稳定),
 * 第一个命中即返回(已解析占位符的回复)。都不命中返回 null(=不回复)。
 */
export function matchInteractionRule(
  rules: InteractionRule[],
  comment: { text: string; author?: string },
): InteractionRuleMatch | null {
  const text = comment.text ?? '';
  if (!text) return null;
  const sorted = [...rules]
    .filter((r) => r.enabled)
    .sort((a, b) => (b.priority - a.priority) || (a.createdAt - b.createdAt));
  for (const r of sorted) {
    const hit = matchOne(r, text);
    if (hit !== null) {
      const mode = r.replyMode === 'ai' ? 'ai' : 'template';
      return {
        ruleId: r.id,
        ruleName: r.name,
        // AI 模式下 replyTemplate 是【意图】,不是文案:占位符照样替换(意图里写 {author} 也讲得通),
        // 但调用方必须把它当意图交给 AI 现写,绝不能直接外发。
        reply: renderReplyTemplate(r.replyTemplate, { author: comment.author ?? '', keyword: hit }),
        replyMode: mode,
        action: r.action,
        matchedKeyword: hit || null,
      };
    }
  }
  return null;
}
