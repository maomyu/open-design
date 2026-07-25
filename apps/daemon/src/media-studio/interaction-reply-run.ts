// 互动区 AI 智能评论回复——【执行侧】:解析创作台在用的那个「检测到的本地 CLI 智能体」,
// 调 callModelOnce(与创作台走同一个 AI,不另配 Key)出结构化拟稿。提示词/解析在 interaction-reply.ts。
import { callModelOnce } from '../memory-llm.js';
import { detectAgents } from '../agents.js';
import { readAppConfig } from '../app-config.js';
import {
  buildReplySystemPrompt,
  buildReplyUserPrompt,
  parseReplyResults,
  buildOpeningSystemPrompt,
  buildOpeningUserPrompt,
  parseOpeningResult,
  type ReplyComment,
  type ReplyNote,
  type ReplyResult,
} from './interaction-reply.js';

/** 解析创作台同口径的 agent(显式 > 配置的 agentId > 第一个可用的检测到的 CLI)。 */
export async function resolveStudioAgentId(dataDir: string, explicit?: string | null): Promise<string> {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  try {
    const cfg = await readAppConfig(dataDir);
    if (typeof cfg.agentId === 'string' && cfg.agentId.trim()) return cfg.agentId.trim();
    const agents = await detectAgents(cfg.agentCliEnv ?? {}).catch(() => [] as Array<{ id: string; available: boolean }>);
    return agents.find((a) => a.available)?.id ?? '';
  } catch {
    return '';
  }
}

/**
 * 没显式给人设时,自动用【账号中心里这个账号的人设】(账号档案 `style.persona`,创作台写作一直在用它)。
 *
 * 互动区原来要用户在互动页再手填一遍语气——同一个账号的人设已经在「账号」页存过了,重填既啰嗦又
 * 容易两处不一致(写作一个调、回评论另一个调)。放在 daemon 而不是界面上做,是为了 UI 和
 * `od studio ai-auto-reply`(不带 --persona)拿到的是同一份人设。
 *
 * 显式传了 persona 就以显式的为准(临时换语气);账号找不到/没填人设则返回空串,行为跟以前一样。
 */
export async function resolveAccountPersona(
  dataDir: string,
  platform: string,
  account: string | null | undefined,
  explicit?: string | null,
): Promise<string> {
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim();
  const name = (account ?? '').trim();
  const plat = (platform ?? '').trim();
  if (!name || !plat) return '';
  try {
    const cfg = await readAppConfig(dataDir);
    const rows = (cfg.platformAccounts ?? {})[plat] ?? [];
    const rec = rows.find((r) => r.name === name) ?? rows.find((r) => r.id === name);
    return (rec?.style?.persona ?? '').trim();
  } catch {
    return '';
  }
}

export interface GenerateDraftsOpts {
  note?: ReplyNote;
  persona?: string;
  comments: ReplyComment[];
  sentReplies?: string[];
  maxLen?: number;
  chatAgentId?: string | null;
  /** 关键词规则 AI 模式的【意图】(例:「引导私信,别甩链接」)。约束回复方向,不越过安全铁律。 */
  intent?: string;
}

/** 一批评论 → 逐条 AI 拟稿(该不该回 + 回什么)。空评论直接返回 []。抛 NO_PROVIDER 时上层给人话。 */
export async function generateReplyDrafts(
  dataDir: string,
  projectRoot: string,
  opts: GenerateDraftsOpts,
): Promise<ReplyResult[]> {
  const comments = (opts.comments ?? []).filter((c) => c && String(c.id ?? '').trim()).slice(0, 40);
  if (comments.length === 0) return [];
  const system = buildReplySystemPrompt(opts.persona ?? '', opts.maxLen ?? 60, opts.intent ?? '');
  const user = buildReplyUserPrompt(opts.note ?? {}, comments, opts.sentReplies ?? []);
  const agentId = await resolveStudioAgentId(dataDir, opts.chatAgentId);
  const raw = await callModelOnce(dataDir, {
    projectRoot,
    ...(agentId ? { chatAgentId: agentId } : {}),
    system,
    user,
    timeoutMs: 180_000,
  });
  return parseReplyResults(String(raw ?? ''), comments);
}

/** 给一条【没人评论】的笔记写 1 条开场评论(抢首评引流)。不合适/敏感返回空串。抛 NO_PROVIDER 时上层给人话。 */
export async function generateOpeningComment(
  dataDir: string,
  projectRoot: string,
  opts: { note?: ReplyNote; persona?: string; maxLen?: number; chatAgentId?: string | null },
): Promise<string> {
  const system = buildOpeningSystemPrompt(opts.persona ?? '', opts.maxLen ?? 50);
  const user = buildOpeningUserPrompt(opts.note ?? {});
  const agentId = await resolveStudioAgentId(dataDir, opts.chatAgentId);
  const raw = await callModelOnce(dataDir, {
    projectRoot,
    ...(agentId ? { chatAgentId: agentId } : {}),
    system,
    user,
    timeoutMs: 120_000,
  });
  return parseOpeningResult(String(raw ?? ''));
}
