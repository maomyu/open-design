// 互动区 AI 智能评论回复——提示词组装 + 结果解析(纯函数)。
//
// 走【与创作台同一个「检测到的本地 CLI 智能体」】:端点用 callModelOnce(memory-llm)复用
// 多 provider 层(本地 CLI / BYOK 都行),不另配文本模型 Key。逐条判「该不该回 + 回什么」,
// 人预览确认后才外发。安全铁律写进 system prompt(负面/敏感→不硬回;不承诺不引战不甩链接;
// 同批 + 与已发回复去重)。

export interface ReplyComment {
  id: string;
  author?: string;
  text: string;
}
export interface ReplyNote {
  title?: string;
  content?: string;
}
export interface GenReplyPayload {
  note?: ReplyNote;
  persona?: string;
  comments: ReplyComment[];
  sentReplies?: string[];
  constraints?: { maxLen?: number };
}
export interface ReplyResult {
  id: string;
  should_reply: boolean;
  category: string;
  reply: string;
  reason: string;
  confidence: number;
}

const NOTE_CLIP = 800;
const PERSONA_CLIP = 1200;

export function buildReplySystemPrompt(persona: string, maxLen: number, intent?: string): string {
  const p = (persona || '').trim().slice(0, PERSONA_CLIP) || '一个真实、真诚、专业的自媒体创作者';
  // intent 来自【关键词规则的 AI 模式】:关键词负责"找准该回的人",这句意图负责"这类人要往哪带"
  // (例:命中"价格/多少钱"→意图「引导私信,别在评论区甩链接」)。它约束方向,不改上面那些安全铁律
  // ——意图再急也不能突破不承诺/不引战/不甩链接。
  const goal = (intent || '').trim().slice(0, 300);
  return [
    `你是「${p}」本人的社媒评论区运营助手。任务:针对一条笔记下的一批评论,逐条判断【该不该回复】以及【如果回复、回复什么】。这是评论区互动,不是客服。`,
    ...(goal ? [`这批评论是被同一条关键词规则挑出来的,回复要围绕这个意图来写:「${goal}」。但下面的铁律优先于意图——意图与安全冲突时按铁律办(该不回就不回)。`] : []),
    '铁律:',
    `1. 像真人本人在回、口语化、简短(每条 ≤ ${maxLen} 字),自然贴合这条评论和这条笔记的内容,绝不能是套路模板腔、绝不群发感。`,
    '2. 负面攻击/杠精/敏感话题(政治、涉黄涉暴、医疗或金融的承诺性建议、人身攻击、举报威胁)→ should_reply=false 且 category 标「负面」或「需人工」,不要硬回、不要争辩。',
    '3. 不承诺疗效/收益、不引战、不辱骂、不泄露隐私;求链接/求购/要联系方式的,不在评论区直接甩链接或微信,而是热情引导「私信我」。',
    '4. 同一批里的回复不要雷同,也不要和【已发回复】重样,换着说法。',
    '5. 纯表情、无意义灌水、广告水军 → should_reply=false。',
    '6. 真心夸赞→真诚回应带一点个人温度;提问→简短给到点上(展开的引导私信);共鸣→接住情绪。',
    '只输出一个 JSON 对象,不要多余文字、不要 markdown 代码围栏。结构:',
    '{"results":[{"id":"评论id","should_reply":true或false,"category":"夸赞/提问/求链接/共鸣/负面/需人工/水军 之一","reply":"要发的回复(should_reply=false 时留空字符串)","reason":"一句话说明为什么这样处理","confidence":0到1之间的小数}]}',
  ].join('\n');
}

export function buildReplyUserPrompt(note: ReplyNote, comments: ReplyComment[], sent: string[]): string {
  const title = (note?.title || '').trim().slice(0, 120);
  const content = (note?.content || '').trim().slice(0, NOTE_CLIP);
  const lines = [
    `【笔记标题】${title || '(无)'}`,
    `【笔记正文】${content || '(未抓到正文,只能靠评论本身判断)'}`,
  ];
  const joined = (sent || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 12).join(' / ');
  if (joined) lines.push(`【本条笔记已发过的回复,别重样】${joined}`);
  lines.push('【待处理评论】');
  for (const c of comments) {
    const author = (c.author || '').trim() || '网友';
    const text = String(c.text || '').trim().replace(/\n/g, ' ').slice(0, 200);
    lines.push(`- id=${String(c.id).trim()} | 作者=${author} | 评论:${text}`);
  }
  return lines.join('\n');
}

// ── 自动直发的"安全正向"白名单 ─────────────────────────────────────────
// 「稳健」模式只自动外发这几类 + AI 判 should_reply=true 的评论回复。负面/水军/需人工/求链接
// 一律不自动发:负面/水军/需人工是攻击/垃圾/敏感,求链接虽内容安全(回"私信我"),但群发引导私信
// 像推广、最容易被平台判营销/骚扰,稳健起见排除,留给人工手动发。这是「避免平台风控」的第一道闸。
export const SAFE_AUTO_REPLY_CATEGORIES: ReadonlySet<string> = new Set(['夸赞', '提问', '共鸣', '开场']);

export interface AutoSendCandidate {
  id: string;
  reply: string;
  category: string;
  author?: string;
}

/**
 * 从 AI 逐条草稿里挑「可自动直发」的候选:必须 should_reply=true、有回复文案、且类目在安全白名单内。
 * 按 confidence 降序(先发模型最有把握的),截到 max 条。是 UI/CLI/服务端共用的唯一筛选口径——
 * 服务端在 autoSend 路径会再过一遍这个函数兜底,绝不把非安全类自动外发。
 */
export function pickAutoSendCandidates(
  drafts: ReadonlyArray<{ id: string; should_reply?: boolean; category?: string; reply?: string; confidence?: number; author?: string }>,
  max: number,
  categories: ReadonlySet<string> = SAFE_AUTO_REPLY_CATEGORIES,
): AutoSendCandidate[] {
  return drafts
    .filter((d) => Boolean(d.should_reply) && String(d.reply ?? '').trim().length > 0 && categories.has(String(d.category ?? '').trim()))
    .slice()
    .sort((a, b) => (Number(b.confidence) || 0) - (Number(a.confidence) || 0))
    .slice(0, Math.max(0, Math.floor(max) || 0))
    .map((d) => ({ id: String(d.id), reply: String(d.reply).trim(), category: String(d.category ?? '').trim(), ...(d.author ? { author: String(d.author) } : {}) }));
}

// ── 开场评论(笔记还没人评论时,写一条首评抢热度引流)────────────────────
export function buildOpeningSystemPrompt(persona: string, maxLen: number): string {
  const p = (persona || '').trim().slice(0, PERSONA_CLIP) || '一个真实、真诚、专业的自媒体创作者';
  return [
    `你是「${p}」本人。任务:给一条【别人的】笔记写一条【开场评论/首评】(这条还没人评论,你来抢第一个)。目的是自然融入、蹭点热度,不是打广告。`,
    '铁律:',
    `1. 像真人读完随手评的一句,口语化、简短(≤ ${maxLen} 字),紧扣这条笔记的主题——真诚共鸣、或一个真问题、或一句到位的补充。`,
    '2. 绝不套路模板腔、绝不群发感;不吹捧过头、不假大空。',
    '3. 不承诺、不引战、不辱骂;绝不甩链接/微信/求关注/求互关(那是广告,必被删/被限)。',
    '4. 敏感话题(政治、涉黄涉暴、医疗或金融承诺性内容)一律不碰——遇到这类笔记直接返回空、ok=false。',
    '只输出一个 JSON 对象,不要多余文字、不要 markdown 围栏。结构:{"comment":"要发的开场评论(不合适就空字符串)","ok":true或false}',
  ].join('\n');
}

export function buildOpeningUserPrompt(note: ReplyNote): string {
  const title = (note?.title || '').trim().slice(0, 120);
  const content = (note?.content || '').trim().slice(0, NOTE_CLIP);
  return [
    `【笔记标题】${title || '(无)'}`,
    `【笔记正文】${content || '(未抓到正文,只能看标题)'}`,
    '给这条笔记写一条自然、贴题的开场评论。',
  ].join('\n');
}

export function parseOpeningResult(raw: string): string {
  let data: unknown = null;
  try { data = JSON.parse(raw); } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) { try { data = JSON.parse(raw.slice(s, e + 1)); } catch { data = null; } }
  }
  if (data && typeof data === 'object') {
    const o = data as { comment?: unknown; ok?: unknown };
    if (o.ok === false) return '';
    return String(o.comment ?? '').trim();
  }
  return '';
}

/** 从模型返回文本里解析结构化结果,和输入 comments 一一对齐(模型漏给的条兜底成"未判定不回复")。 */
export function parseReplyResults(raw: string, comments: ReplyComment[]): ReplyResult[] {
  let data: unknown = null;
  try {
    data = JSON.parse(raw);
  } catch {
    const s = raw.indexOf('{');
    const e = raw.lastIndexOf('}');
    if (s >= 0 && e > s) {
      try { data = JSON.parse(raw.slice(s, e + 1)); } catch { data = null; }
    }
  }
  const rows = data && typeof data === 'object' && Array.isArray((data as { results?: unknown }).results)
    ? ((data as { results: unknown[] }).results as Array<Record<string, unknown>>)
    : [];
  const byId = new Map<string, Record<string, unknown>>();
  for (const r of rows) if (r && typeof r === 'object') byId.set(String(r.id ?? ''), r);
  return comments.map((c) => {
    const r = byId.get(String(c.id)) ?? {};
    const has = Object.keys(r).length > 0;
    const reply = String(r.reply ?? '').trim();
    const should = Boolean(r.should_reply) && reply.length > 0;
    const confRaw = typeof r.confidence === 'number' ? r.confidence : Number(r.confidence);
    const conf = Number.isFinite(confRaw) ? confRaw : 0;
    return {
      id: String(c.id),
      should_reply: should,
      category: String(r.category ?? '').trim() || (has ? '其他' : '未判定'),
      reply: should ? reply : '',
      reason: String(r.reason ?? '').trim() || (has ? '' : '模型未给该条结果'),
      confidence: Math.max(0, Math.min(1, conf)),
    };
  });
}
