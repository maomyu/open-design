/**
 * Studio AI-task prompt composer — every step's agent action reuses the SAME
 * methodology the 公众号 plugin runs on (workbench MY-wechat-* skills, 贝拉
 * viral method, account personas), scoped to one step and instructed to write
 * results back through the `od studio` CLI (the UI/CLI dual-track contract:
 * the agent and the human operate the same article entity).
 *
 * Execution is NOT here: the route returns {projectId, conversationId,
 * prompt} and the web starts a normal run via POST /api/runs, so streaming,
 * cancel, agent resolution and credential injection all come for free.
 */
import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { MediaArticle, StudioAiTaskKind } from '@open-design/contracts';

const WORKBENCH_DIR = path.join(
  process.env.OD_WORKBENCH_DIR || path.join(os.homedir(), '.open-design', 'workbenches'),
  '多媒体自动发布',
);

const WRITER_SKILL_BY_TYPE: Record<string, string> = {
  信息服务攻略: 'MY-wechat-writer-service',
  口语化科普: 'MY-wechat-writer-default',
  深度长文: 'MY-wechat-writer-deep',
  情感共鸣: 'MY-wechat-writer-emotion',
  插画金句: 'MY-wechat-illustrated-quote',
  硬核攻略: 'MY-wechat-writer-guide',
};

async function readWorkbenchFile(rel: string): Promise<string | null> {
  try {
    return await readFile(path.join(WORKBENCH_DIR, rel), 'utf8');
  } catch {
    return null;
  }
}

async function readSkillBody(skillDirName: string): Promise<string | null> {
  return readWorkbenchFile(path.join('.claude', 'skills', skillDirName, 'SKILL.md'));
}

export interface ComposeAiTaskInput {
  kind: StudioAiTaskKind;
  platform: string;
  article: MediaArticle | null;
  note: string;
  articleType: string;
  /** 目标字数档位（写作用，如 "1500-2000"）。 */
  wordCount?: string;
  account: { name: string; persona?: string; samples?: string[] } | null;
  /** 知识库条目（已按平台+账号筛好、截好断）——写作/脚本/选题时给 AI 当背景。 */
  knowledge?: Array<{ name: string; contentMd: string }>;
  /** Absolute path of the od CLI entry (dist/cli.js) for PATH-less fallback. */
  cliPath: string;
}

export interface ComposedAiTask {
  title: string;
  prompt: string;
}

function cliBlock(cliPath: string): string {
  return [
    '## 结果怎么交付（铁律）',
    '- 本机已注入 `OD_DAEMON_URL`，用 **`od studio` CLI** 把产物写回创作台（不要把整篇文章贴在对话里）。',
    `- 若 \`od\` 不在 PATH，用 \`node ${cliPath} studio ...\` 等价调用。`,
    '- 写回后在对话里只说 1-3 句话总结（做了什么、写回了哪里），界面会自动刷新。',
    '- 全程不要用 AskUserQuestion 停下来问；拿不准就按最合理的默认做。',
    '- **文章隔离**：只操作提示词里给定的这一篇文章 id；临时文件一律放 /tmp 且带上文章号；**不要在当前工作目录留下任何文件**（不要写 CLAUDE.md/笔记/草稿到项目目录）。',
  ].join('\n');
}

function knowledgeBlock(items: ComposeAiTaskInput['knowledge']): string {
  if (!items || items.length === 0) return '';
  const lines = ['## 知识库（客户挂载的背景资料——事实、口径、案例以此为准）'];
  for (const item of items) {
    lines.push(`### ${item.name}\n${item.contentMd}`);
  }
  return lines.join('\n\n');
}

function accountBlock(account: ComposeAiTaskInput['account']): string {
  if (!account) return '';
  const lines = [`## 账号人设（写作腔调以此为准，高于文章类型模板）`, `- 账号：${account.name}`];
  if (account.persona) lines.push(`- 人设/风格：${account.persona}`);
  for (const sample of account.samples ?? []) {
    lines.push(`- 范文片段：\n${sample.slice(0, 1200)}`);
  }
  return lines.join('\n');
}

export async function composeStudioAiTask(input: ComposeAiTaskInput): Promise<ComposedAiTask> {
  const { kind, article, note, platform } = input;
  const cli = cliBlock(input.cliPath);

  if (kind === 'topics') {
    const direction = note.trim() || '（用户没给方向——先按账号人设推断最合适的领域）';
    return {
      title: `AI 选题 · ${note.trim().slice(0, 18) || '自动'}`,
      prompt: [
        '# 任务：选题（只做选题，不写正文）',
        `方向/领域：${direction}`,
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        '## 怎么做',
        '1. 先拉双信号热点数据：',
        `   \`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${platform}/topics/radar" -H 'Content-Type: application/json' -d '{"keyword":"<方向关键词>"}'\``,
        '   （⭐双信号=最强选题；🔥爆款=流量验证；🔍搜一搜=搜索需求。接口失败就直接基于方向做判断，别空转重试。）',
        '2. 结合热点数据把方向细化成 **3-5 个具体选题**：每个都要有明确的切入角度（写给谁/解决什么痛点/落脚点），不要泛泛的大话题。',
        '3. 每个选题用 CLI 落库（有原文依据的必须带来源和链接）：',
        `   \`od studio topic-add --title "<选题标题>" --angle "<切入角度>" --source "<来源公众号/平台>" --url "<原文链接>" --heat "<高|中|低>"\``,
        cli,
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (!article) throw new Error('该 AI 动作需要先选中一篇文章');

  if (kind === 'research') {
    const topicUrl = String((article.extra as Record<string, unknown>).topicUrl ?? '');
    return {
      title: `素材简报 · ${article.topic || article.title || '未命名'}`,
      prompt: [
        '# 任务：为这个选题做全网素材战情简报（只做研究，不写正文）',
        `选题：${article.topic || article.title}`,
        note.trim() ? `补充要求：${note.trim()}` : '',
        '## 怎么做',
        topicUrl
          ? `1. 先抓选题原文：\`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${article.platform}/article-detail" -H 'Content-Type: application/json' -d '{"url":"${topicUrl}"}'\`（返回 title/account/markdown）。`
          : '1. 没有原文链接——直接用你的检索工具找 3-5 篇高质量相关内容。',
        '2. 用你可用的搜索/抓取工具再补 2-4 个独立信源（数据、案例、反方观点）。',
        '3. 产出简报 markdown：核心事实（带来源）/ 可用数据与案例 / 大家都在写什么角度 / 差异化切入建议 / 风险与需核实点。',
        '## 交付',
        `1. 简报存临时文件 /tmp/studio-research-${article.id.slice(0, 8)}.md；`,
        '2. 用 node 一行把它写进文章的 extra.researchMd（写作时会自动带上）：',
        '```bash',
        `node -e 'const fs=require("fs");fetch(process.env.OD_DAEMON_URL+"/api/media-studio/${article.platform}/articles/${article.id}",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({extra:{researchMd:fs.readFileSync("/tmp/studio-research-${article.id.slice(0, 8)}.md","utf8")}})}).then(r=>console.log("saved",r.status))'`,
        '```',
        cli,
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (kind === 'review') {
    const reviewData = String((article.extra as Record<string, unknown>).reviewData ?? '');
    return {
      title: `发布复盘 · ${article.title || '未命名'}`,
      prompt: [
        '# 任务：复盘这篇已发布内容，给下一篇可执行的改进建议',
        `标题：${article.title}`,
        reviewData ? `用户填的实际数据：${reviewData}` : '（用户没填数据——从内容本身做定性复盘）',
        note.trim() ? `用户补充：${note.trim()}` : '',
        accountBlock(input.account),
        '## 正文',
        '```markdown',
        article.bodyMd.slice(0, 6000),
        '```',
        '## 交付（对话里直接说，不写回文章）',
        '- 钩子/标题/结构各打一个直观分数并说为什么；',
        '- 结合数据（若有）判断哪一环节掉链子（打开率=标题封面、读完率=结构节奏、转发=价值点）；',
        '- 给下一篇的 3 条具体改法 + 2 个衍生选题（可用 `od studio topic-add` 直接落进选题库）。',
        cliBlock(input.cliPath),
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (kind === 'script') {
    // 短视频口播脚本 — reuse short-video-copy 的平台调性方法论（提示词内联）。
    const extra = article.extra as Record<string, unknown>;
    const tone = String(input.note ? '' : extra.tone ?? '') || '真诚口播';
    const duration = String(extra.duration ?? '') || '30s';
    const targetPlatform = String(extra.targetPlatform ?? '') || '抖音';
    return {
      title: `AI 写脚本 · ${article.title || article.topic || '未命名'}`,
      prompt: [
        '# 任务：写一条短视频口播脚本（可直接开拍/配音）',
        `选题：${article.topic || article.title || '（按补充要求定）'}`,
        `主发平台：${targetPlatform}（按平台调性写：小红书=闺蜜感种草、抖音=前3秒钩子+快节奏、视频号=稳重可信、B站=展开讲逻辑、快手=实在接地气）`,
        `语气：${tone}；目标时长：${duration}（中文口播约 4-5 字/秒，控制字数）`,
        note.trim() ? `补充要求：${note.trim()}` : '',
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        '## 输出结构（markdown，写进正文）',
        '- `## 标题备选`：3 个（钩子感强、平台风格），把最好的一个也设成文章标题；',
        '- `## 口播脚本`：钩子（前3秒）→ 预告 → 正文分点 → CTA，逐句可读，不写镜头术语也不写 markdown 强调符号；',
        '- `## 话题标签`：5-8 个（不带#，逗号分隔）；',
        '- `## 封面文字`：主标题 + 副标题各一行。',
        '## 交付',
        '1. 整篇 markdown 存临时文件；',
        `2. \`od studio set ${article.id} --platform ${article.platform} --body-file <文件> --title "<最佳标题>" --digest "<一句话简介,发布时当作品描述>" --tags "标签1,标签2"\`。`,
        cli,
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (kind === 'write') {
    const articleType = input.articleType || '信息服务攻略';
    const writerSkill = WRITER_SKILL_BY_TYPE[articleType] ?? 'MY-wechat-writer-service';
    const [method, writer, detector] = await Promise.all([
      readWorkbenchFile(path.join('.claude', 'skills', 'MY-wechat-shared', 'references', 'viral-method.md')),
      readSkillBody(writerSkill),
      readSkillBody('MY-wechat-ai-detector'),
    ]);
    const researchMd = String((article.extra as Record<string, unknown>).researchMd ?? '').trim();
    const topicUrl = String((article.extra as Record<string, unknown>).topicUrl ?? '');
    // 素材调研是写作的必经前置：做过就复用简报，没做过就在同一次任务里先调研。
    const researchPhase = researchMd
      ? `## 素材简报（已调研——事实与数据优先用这里的，不必重查）\n${researchMd.slice(0, 4000)}`
      : [
          '## 第 0 步：先做素材调研（必做，然后才动笔）',
          topicUrl
            ? `1. 抓选题原文：\`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${article.platform}/article-detail" -H 'Content-Type: application/json' -d '{"url":"${topicUrl}"}'\`（返回 title/account/markdown；接口失败就跳过原文，别空转重试）。`
            : '1. 没有选题原文链接——直接用你的检索工具找 2-4 篇高质量相关内容。',
          '2. 补齐关键事实：涉及费用/时长/政策/流程的数字必须有出处；顺手记下大家都在写的角度，好做差异化。',
          `3. 把简报（核心事实带来源/可用数据案例/差异化切入/需核实点）存 /tmp/studio-research-${article.id.slice(0, 8)}.md，并写回文章备查：`,
          '```bash',
          `node -e 'const fs=require("fs");fetch(process.env.OD_DAEMON_URL+"/api/media-studio/${article.platform}/articles/${article.id}",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({extra:{researchMd:fs.readFileSync("/tmp/studio-research-${article.id.slice(0, 8)}.md","utf8")}})}).then(r=>console.log("research saved",r.status))'`,
          '```',
          '4. 然后基于简报里的事实写作——正文里的数字、结论必须能在简报中找到依据。',
        ].join('\n');
    return {
      title: `AI 写一版 · ${article.title || article.topic || '未命名'}`,
      prompt: [
        '# 任务：写一版可发布的公众号长文正文（先调研，后写作，写完清 AI 腔，一次完成）',
        `选题：${article.topic || article.title || '（见下方补充要求）'}`,
        `文章类型：${articleType}`,
        input.wordCount?.trim() ? `目标字数：${input.wordCount.trim()} 字（允许 ±15%，宁短勿注水）` : '',
        note.trim() ? `补充要求：${note.trim()}` : '',
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        researchPhase,
        '## 硬约束',
        '- **正文不写大标题**（标题单独走 title 字段），从导语/首段直接开始。',
        '- 按写作方法论在正文里标注配图位：`<!-- IMAGE_N: 具体场景描述, 4:3 -->`（封面 `<!-- IMAGE_COVER: 描述, 16:9 -->` 放最前）。',
        '- markdown 只用 `##`/`###` 小节、`**加粗**`、`>` 引用、`1.`/`-` 列表。',
        method ? `## 方法论（贝拉爆文方法论，策略层）\n${method}` : '',
        writer ? `## 文章类型写法（${writerSkill}，落笔层）\n${writer}` : '（工作台写作技能文件缺失——按公众号最佳实践写。）',
        detector ? `## AI 腔自查（写完必须过一遍再交付，与写作同一次完成）\n${detector}` : '',
        '## 交付（写作 + 清 AI 腔一次完成，不分两趟）',
        '1. 写完整正文后，**先按上面的 AI 腔自查方法通读清理一遍**（机翻感/套话/空转过渡/防御性自证），再进入交付；',
        `2. 清理后的完整正文 markdown 存到一个临时文件（如 /tmp/studio-article-${article.id.slice(0, 8)}.md）；`,
        `3. \`od studio set ${article.id} --body-file /tmp/studio-article-${article.id.slice(0, 8)}.md --title "<拟好的标题,≤21个中文字符>" --digest "<一句话摘要>"\``,
        cli,
      ].filter(Boolean).join('\n\n'),
    };
  }

  if (kind === 'revise') {
    return {
      title: `按建议改 · ${article.title || '未命名'}`,
      prompt: [
        '# 任务：按用户意见修改公众号正文（最小改动，别整篇重写）',
        `用户意见：${note.trim() || '（无——通读一遍做一轮从紧的自我校对）'}`,
        accountBlock(input.account),
        '## 当前正文（markdown）',
        '```markdown',
        article.bodyMd,
        '```',
        '## 交付',
        '1. 只改需要改的部分，保留 `<!-- IMAGE_N -->` 标注和整体结构。',
        `2. 改完整篇存临时文件，\`od studio set ${article.id} --body-file <文件>\`；若标题也要改，加 \`--title\`。`,
        cli,
      ].join('\n\n'),
    };
  }

  // ai-check
  const detector = await readSkillBody('MY-wechat-ai-detector');
  return {
    title: `查 AI 腔 · ${article.title || '未命名'}`,
    prompt: [
      '# 任务：检测并清除正文里的 AI 腔（中英文机翻感/套话/空转过渡）',
      detector ? `## 检测方法论（MY-wechat-ai-detector）\n${detector}` : '',
      '## 当前正文（markdown）',
      '```markdown',
      article.bodyMd,
      '```',
      '## 交付',
      `1. 清理后的整篇正文存临时文件，\`od studio set ${article.id} --body-file <文件>\`。`,
      '2. 对话里只报：发现几处、典型例子 2-3 个（改前→改后）。',
      cliBlock(input.cliPath),
    ].filter(Boolean).join('\n\n'),
  };
}
