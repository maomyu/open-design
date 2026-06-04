// Self-improving agent loop ("调教") — the bridge from a user's reaction to
// an OUTPUT into durable memory that the existing memory injection feeds back
// into every future run. See packages/contracts/src/api/learning.ts for the
// product rationale.
//
// All three mechanisms ride the daemon memory system (apps/daemon/src/memory.ts):
//   1. Feedback → a `feedback` memory entry (preference), accumulated per context.
//   2. Approved output → a `reference` memory entry (style sample), last-N kept.
//   3. Sedimentation/recall → composeMemoryBody already injects both (memory
//      entries are auto-linked into the index by upsertMemoryEntry).
//
// The key move for mechanism 1: users judge outputs but can't write prompts,
// so REASON_GUIDANCE encodes the expertise — it maps a plain reaction
// ("不够吸引人") to a concrete directive the agent can act on.

import type {
  LearningFeedbackRequest,
  LearningFeedbackResponse,
  LearningSampleRequest,
  LearningSampleResponse,
  LearningListResponse,
  LearningItem,
} from '@open-design/contracts';
import {
  upsertMemoryEntry,
  readMemoryEntry,
  listMemoryEntries,
} from './memory.js';

// Plain reaction → concrete directive (the expertise the user lacks).
// Unknown reasons pass through verbatim so the chip set can grow without a
// code change.
const REASON_GUIDANCE: Record<string, string> = {
  '不够吸引人':
    '开头 3 秒钩子要更强：用反常识结论 / 扎心痛点 / 高对比承诺开场，禁止平淡的自我介绍式开头。',
  '太长了': '更精简：砍掉冗余信息，单条信息更密，口播更短、节奏更快。',
  '换个角度': '换一个切入角度或卖点，不要重复上一版的角度。',
  '太硬广': '弱化广告感：先给价值/干货，CTA 自然不突兀，少用促销词。',
  '标题不行': '标题更具体：用数字 / 明确利益 / 钩子词（干货、避雷、亲测），避免空泛。',
  '语气不对': '调整语气，更贴目标平台与账号人设。',
};

function slugify(value?: string): string {
  const base = (value ?? 'global')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  return base.slice(0, 40) || 'global';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// Mechanism 1 — turn a reaction into an accumulating preference memory.
export async function recordLearningFeedback(
  dataDir: string,
  req: LearningFeedbackRequest,
): Promise<LearningFeedbackResponse> {
  const ctx = (req.context ?? '').trim();
  const id = `feedback_${slugify(ctx)}_prefs`;
  const reasons = Array.isArray(req.reasons)
    ? req.reasons.filter((r) => typeof r === 'string' && r.trim().length > 0)
    : [];
  const note = (req.note ?? '').trim();

  const directives: string[] = [];
  if (req.rating === 'good') {
    directives.push('延续这一版的风格与结构——用户认可。');
  }
  for (const r of reasons) {
    directives.push(REASON_GUIDANCE[r] ?? `用户觉得「${r}」，据此调整。`);
  }
  if (note) directives.push(`用户补充：${note}`);
  if (directives.length === 0) directives.push('（无具体方向）');

  const bullet = `- [${today()}] ${directives.join(' ')}`;
  const existing = await readMemoryEntry(dataDir, id);
  const prev = existing?.body && existing.body.trim().length > 0 ? `${existing.body.trim()}\n` : '';
  const body = `${prev}${bullet}`;

  await upsertMemoryEntry(dataDir, {
    id,
    name: ctx ? `${ctx} · 偏好` : '内容偏好',
    description: ctx
      ? `用户对「${ctx}」累积的偏好（自动从反馈学习）`
      : '用户累积的内容偏好（自动从反馈学习）',
    type: 'feedback',
    body,
  }, { source: 'manual' });
  return { memoryId: id, preference: body };
}

// Mechanism 2 — remember a concrete good output as a few-shot style sample.
export async function recordLearningSample(
  dataDir: string,
  req: LearningSampleRequest,
): Promise<LearningSampleResponse> {
  const ctx = (req.context ?? '').trim();
  const id = `reference_${slugify(ctx)}_samples`;
  const content = (req.content ?? '').trim();
  if (!content) throw new Error('sample content is empty');
  const title = (req.title ?? '').trim() || today();
  const block = `### 样板：${title}\n\n${content}`;

  const existing = await readMemoryEntry(dataDir, id);
  const prevBlocks = existing?.body
    ? existing.body
        .split(/\n(?=### 样板：)/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
    : [];
  // Bound the injected prompt: keep only the most recent few exemplars.
  const MAX_SAMPLES = 3;
  const blocks = [...prevBlocks, block].slice(-MAX_SAMPLES);

  await upsertMemoryEntry(dataDir, {
    id,
    name: ctx ? `${ctx} · 风格样板` : '风格样板',
    description: ctx
      ? `「${ctx}」用户采纳的优秀产物，作为少样本风格参考`
      : '用户采纳的优秀产物，作为少样本风格参考',
    type: 'reference',
    body: blocks.join('\n\n'),
  }, { source: 'manual' });
  return { memoryId: id };
}

// What the agent has learned so far (for the UI panel + `od learning list`).
export async function listLearning(
  dataDir: string,
  context?: string,
): Promise<LearningListResponse> {
  const ctx = (context ?? '').trim();
  const slug = slugify(ctx);
  const entries = await listMemoryEntries(dataDir);
  const items: LearningItem[] = [];
  for (const e of entries) {
    const matchesCtx = (prefix: string, suffix: string) =>
      ctx
        ? e.id === `${prefix}_${slug}_${suffix}`
        : e.id.startsWith(`${prefix}_`) && e.id.endsWith(`_${suffix}`);
    const isPref = matchesCtx('feedback', 'prefs');
    const isSample = matchesCtx('reference', 'samples');
    if (!isPref && !isSample) continue;
    items.push({
      memoryId: e.id,
      kind: isPref ? 'preference' : 'sample',
      name: e.name,
      description: e.description,
      updatedAt: e.updatedAt,
    });
  }
  items.sort((a, b) => b.updatedAt - a.updatedAt);
  return { ...(ctx ? { context: ctx } : {}), items };
}
