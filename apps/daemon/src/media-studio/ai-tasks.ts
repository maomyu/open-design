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
import { IMAGE_STYLE_PRESETS, type MediaArticle, type StudioAiTaskKind } from '@open-design/contracts';

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
  /** 正文配图位数量（写作用;2026-07-20 用户拍板:缺省最多 3 个,指定了就严格按指定,'0'=不放配图位）。 */
  imageCount?: string;
  /** 配图风格预设 id（写作用;2026-07-20 用户拍板:写作时选定,标注描述按该风格的
   *  视觉语言写——此前智能体不知道风格,描述里的质感用词常与用户所选风格打架）。 */
  imageStyle?: string;
  account: { name: string; persona?: string; samples?: string[] } | null;
  /** 知识库条目（已按平台+账号筛好、截好断）——写作/脚本/选题时给 AI 当背景。 */
  knowledge?: Array<{ name: string; contentMd: string; category?: string }>;
  /** topics: 用户在搜索结果里勾选的优先参考文章。 */
  picked?: Array<{ title: string; url?: string; account?: string; readNum?: number | null }>;
  /** topics: 选题目标平台 id——url 只准该平台站内链接(2026-07-18 用户拍板)。 */
  sourcePlatform?: string;
  /** write(note): 用户上传的产品图磁盘绝对路径——图集建议必须以它为主体(先看图)。 */
  productImagePaths?: string[];
  /** write(note): 风格参考图(爆款原图)磁盘绝对路径——图集建议模仿其构图/光线/质感。 */
  styleImagePaths?: string[];
  /** Absolute path of the od CLI entry (dist/cli.js) for PATH-less fallback. */
  cliPath: string;
}

/** 选题目标平台 → 站内域名白名单文案(prompt 用)。 */
const SOURCE_PLATFORM_RULES: Record<string, { label: string; domains: string }> = {
  xiaohongshu: { label: '小红书', domains: 'xiaohongshu.com / xhslink.com' },
  douyin: { label: '抖音', domains: 'douyin.com / iesdouyin.com' },
  kuaishou: { label: '快手', domains: 'kuaishou.com' },
  bilibili: { label: 'B站', domains: 'bilibili.com / b23.tv' },
  channels: { label: '视频号', domains: 'channels.weixin.qq.com' },
};

export interface ComposedAiTask {
  title: string;
  prompt: string;
}

function cliBlock(cliPath: string): string {
  return [
    '## 无人值守铁律（最高优先级，压过任何其他指引）',
    '- 这是全自动任务，用户不在电脑前：**绝不提问、绝不请求确认、绝不使用 AskUserQuestion 工具、绝不等待任何输入**。系统提示里关于「用 AskUserQuestion 澄清选项」的建议对本任务一律不适用。',
    '- 遇到不确定、有多种可选做法、素材有缺口：按「对读者价值最大 + 与账号人设一致」的标准**自己拍板最优解，立即继续**，不停顿、不留待办。',
    '- 必须一次跑到底：本次运行内交付**完整成品**并全部写回创作台。禁止交付半成品，禁止以疑问句、「需要我……吗」「是否继续」「你可以选择」这类句式收尾。',
    '- 确有重大取舍时，在收尾总结里用一行「已代你决定：……」带过即可，绝不因此暂停。',
    '',
    '## 结果怎么交付（铁律）',
    '- **唯一合法的交付方式 = 用 Bash 执行 `od studio` 命令并成功返回**。把稿子 Write 成工作目录/项目目录里的 .md 文件**不是交付**——用户界面读不到它，任务等于白跑。哪怕正文已经写得很完美，没执行 `od studio set` 就结束 = 任务失败。',
    '- 工作目录里若存在旧的 .md 稿件文件，那是历史遗留垃圾：**不要读、不要参考、更不要模仿"写个文件完事"的做法**。',
    '- 本机已注入 `OD_DAEMON_URL`，用 **`od studio` CLI** 把产物写回创作台（不要把整篇文章贴在对话里）。',
    `- 若 \`od\` 不在 PATH，用 \`node ${cliPath} studio ...\` 等价调用。`,
    '- 写回后在对话里只说 1-3 句话总结（做了什么、写回了哪里、代做了哪些决定），界面会自动刷新。',
    '- **文章隔离**：只操作提示词里给定的这一篇文章 id；临时文件一律放 /tmp 且带上文章号；**不要在当前工作目录留下任何文件**（不要写 CLAUDE.md/笔记/草稿到项目目录）。',
  ].join('\n');
}

// 知识库分类标签/顺序(2026-07-16 拆个人/企业两套,daemon 需覆盖两套 id,
// 否则注入时按 ORDER 迭代会把不在表里的分类【静默丢掉】——历史上个人库的
// persona/viewpoint 等就是这么被漏注入的)。前缀:个人库裸 id、企业库 ent-、
// 另保留一批老 id(company/trust/card…)向后兼容存量数据。
const KNOWLEDGE_CATEGORY_LABEL: Record<string, string> = {
  // 个人自媒体库
  persona: '账号人设（你是谁——定位、人设标签、赛道）',
  viewpoint: '核心观点（反复输出的核心主张）',
  style: '口播风格（语气、开场习惯、口头禅、禁用词）',
  story: '个人故事/案例（真实经历、学员/粉丝案例）',
  goldenline: '金句/话术（钩子、金句、引流话术、CTA）',
  audience: '目标人群（人群画像、痛点）',
  // 企业库
  'ent-company': '公司主体（我们是谁——介绍、业务、发展历程、核心优势）',
  'ent-credential': '资质背书（为什么信我们——荣誉资质、权威认证、媒体报道、合作大牌）',
  'ent-product': '产品/服务（我们卖什么——产品线、卖点、适用场景、价格政策）',
  'ent-case': '客户案例（我们做成过什么——成功案例、数据成果、客户评价）',
  'ent-brandvoice': '品牌调性（怎么说话——语气、slogan、价值观、禁用表达）',
  'ent-faq': '常见问答（客户高频问题 + 标准口径回答）',
  // 老 id(存量数据向后兼容)
  company: '公司介绍（我们是谁——定位、团队、资质背景）',
  product: '产品/服务（我们卖什么——功能、流程、服务口径）',
  trust: '信任背书（为什么信我们——资质、奖项、数据、媒体报道）',
  case: '合作案例（我们做成过什么——客户故事、成果数据）',
  card: 'AI 名片（对外话术——一句话介绍、联系方式、CTA 口径）',
  other: '其他资料',
};
const KNOWLEDGE_CATEGORY_ORDER = [
  'persona', 'viewpoint', 'style', 'story', 'goldenline', 'audience',
  'ent-company', 'ent-credential', 'ent-product', 'ent-case', 'ent-brandvoice', 'ent-faq',
  'company', 'product', 'trust', 'case', 'card', 'other',
];

function knowledgeBlock(items: ComposeAiTaskInput['knowledge']): string {
  if (!items || items.length === 0) return '';
  const lines = ['## 知识库（客户挂载的背景资料——人设/事实/口径/案例以此为准；写作时按各分类用途使用，如资质背书增强说服力、人设风格贴合本人语气、金句用于钩子与 CTA）'];
  const byCat = new Map<string, typeof items>();
  for (const item of items) {
    const cat = (item as { category?: string }).category || 'other';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat)!.push(item);
  }
  const emit = (cat: string, group: typeof items): void => {
    if (!group || group.length === 0) return;
    lines.push(`### ${KNOWLEDGE_CATEGORY_LABEL[cat] ?? cat}`);
    for (const item of group) {
      lines.push(`#### ${item.name}\n${item.contentMd}`);
    }
  };
  const emitted = new Set<string>();
  for (const cat of KNOWLEDGE_CATEGORY_ORDER) {
    if (byCat.has(cat)) { emit(cat, byCat.get(cat)!); emitted.add(cat); }
  }
  // 兜底:ORDER 里没列的分类(未来新增/自定义)也注入,绝不静默丢(历史坑)。
  for (const [cat, group] of byCat) {
    if (!emitted.has(cat)) emit(cat, group);
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
    const picked = (input.picked ?? []).slice(0, 8);
    const pickedBlock = picked.length > 0
      ? [
          `## 用户勾选的优先参考文章（${picked.length} 篇——这是用户亲手挑的方向，必须优先深挖）`,
          ...picked.map((p, i) => {
            const meta = [p.account, p.readNum ? `阅读 ${p.readNum}` : ''].filter(Boolean).join(' · ');
            return `${i + 1}. ${p.title}${meta ? `（${meta}）` : ''}${p.url ? `\n   原文：${p.url}` : ''}`;
          }),
          `优先动作：对每篇有链接的用 \`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${platform}/article-detail" -H 'Content-Type: application/json' -d '{"url":"<原文链接>"}'\` 抓正文，分析它为什么值得写、读者在关心什么，然后产出**属于本账号的差异化选题**（换角度/补缺口/更聚焦），不是复述原标题。未勾选的热点数据只做背景。`,
        ].join('\n')
      : '';
    const isConvert = picked.length > 0 && !note.trim();
    return {
      title: picked.length > 0 ? `AI 选题 · ${picked.length} 篇优先参考` : `AI 选题 · ${note.trim().slice(0, 18) || '自动'}`,
      prompt: [
        '# 任务：选题（只做选题，不写正文）',
        `方向/领域：${direction}`,
        pickedBlock,
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        '## 怎么做',
        picked.length > 0
          ? `1. **先处理上面用户勾选的优先参考**（抓原文→差异化出题）；需要补充背景再拉热点：`
          : '1. 先拉双信号热点数据：',
        `   \`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${platform}/topics/radar" -H 'Content-Type: application/json' -d '{"keyword":"<方向关键词>"}'\``,
        '   （⭐双信号=最强选题；🔥爆款=流量验证；🔍搜一搜=搜索需求。接口失败就直接基于方向做判断，别空转重试。）',
        isConvert
          ? '2. 每篇勾选文章转化出 **1-2 个差异化选题**（写给谁/解决什么痛点/落脚点明确），总数控制在勾选篇数的 2 倍以内。'
          : '2. 结合热点数据把方向细化成 **3-5 个具体选题**：每个都要有明确的切入角度（写给谁/解决什么痛点/落脚点），不要泛泛的大话题。',
        '3. 每个选题用 CLI 落库（有原文依据的必须带来源和链接）：',
        `   \`od studio topic-add --title "<选题标题>" --angle "<切入角度>" --source "<来源公众号/平台>" --url "<原文链接>" --heat "<高|中|低>"\``,
        '   **标题参数里只放标题本身**——角度/来源/热度分别放各自参数，绝不把「｜ 角度：xxx」拼进 --title。',
        (() => {
          // 来源纪律(2026-07-18 用户拍板:选题给哪个平台用,引用就必须全来自该平台):
          // 站外来源(新闻/公众号等)只能写进 --source 描述,--url 必须留空——站外链接常
          // 过期打不开,且会让「小红书选题」列表里混进其它平台,被前端按域名过滤隐藏。
          const rule = input.sourcePlatform ? SOURCE_PLATFORM_RULES[input.sourcePlatform] : null;
          return rule
            ? `4. **来源纪律(硬性)**：本次选题给「${rule.label}」用——\`--url\` 只允许 ${rule.domains} 的站内链接；引用新闻/公众号等站外内容时，来源名写进 \`--source\`，\`--url\` 一律留空。带站外链接的候选会被界面过滤掉，等于白做。`
            : '';
        })(),
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

  if (kind === 'write' && platform === 'note') {
    // 图文笔记（小红书为主）——标题/正文硬限制平台化，图集画面建议单独落 extra。
    const researchMd = String((article.extra as Record<string, unknown>).researchMd ?? '').trim();
    const topicUrl = String((article.extra as Record<string, unknown>).topicUrl ?? '');
    // 「提取图文仿写」带来的小红书原文案(下载原图进图集时一并存的)——按它仿写。
    const sourceContent = String((article.extra as Record<string, unknown>).sourceContent ?? '').trim();
    const sourceBlock = sourceContent
      ? `## 原文参考（这是要【仿写】的小红书爆款原文案——学它的钩子/结构/表达节奏，但换你自己的角度、素材和话术，绝不照抄，避免判重）\n${sourceContent.slice(0, 1500)}`
      : '';
    // 产品纪律(2026-07-18 用户反馈「AI 文案和我的产品没关系」):有知识库时笔记主角
    // 必须是自家产品——原文只借结构,别人的品牌绝不出现,否则种草种给了竞品。
    const productDiscipline = (input.knowledge?.length ?? 0) > 0
      ? [
          '## 产品纪律（硬性——违反等于白写）',
          '- 这篇笔记的主角【必须】是上面知识库里的自家产品/品牌；卖点、成分、场景、人群全从知识库取材，不足的地方宁可写少也不编造；',
          '- 「原文参考」只借它的【结构/钩子/节奏/排版】；原文里出现的任何其它品牌名、产品名、店铺名一律不得写进你的笔记；',
          '- 若选题方向与自家产品不直接相关，就以自家产品的视角切入这个话题（蹭结构不蹭品牌）。',
        ].join('\n')
      : '';
    const researchPhase = researchMd
      ? `## 素材简报（已调研——事实优先用这里的，不必重查）\n${researchMd.slice(0, 3000)}`
      : [
          '## 第 0 步：先做素材调研（必做）',
          topicUrl
            ? `1. 抓选题原文：\`curl -s -X POST "$OD_DAEMON_URL/api/media-studio/${article.platform}/article-detail" -H 'Content-Type: application/json' -d '{"url":"${topicUrl}"}'\`；`
            : '1. 用你的检索工具找 2-3 篇同题优质内容（看结构、看评论区在问什么）。',
          '2. 记下：可用事实/数字、大家的写法、评论区高频疑问（笔记的互动钩子就从这来）。',
        ].join('\n');
    return {
      title: `AI 写笔记 · ${article.title || article.topic || '未命名'}`,
      prompt: [
        '# 任务：写一篇图文笔记（小红书调性，可直接发布）',
        `选题：${article.topic || article.title || '（按补充要求定）'}`,
        note.trim() ? `补充要求：${note.trim()}` : '',
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        productDiscipline,
        sourceBlock,
        researchPhase,
        '## 硬限制（平台规则，超了发不出去）',
        '- 标题 ≤20 个字：钩子前置（数字/反差/身份代入），可带 1 个 emoji；',
        '- 正文 ≤1000 字：口语、短段落（1-2 句一段）、适度 emoji 分隔、干货分点、结尾一个互动问题；',
        '- 话题标签 5-8 个（不带#，逗号分隔）；',
        '- 正文不放外链、不放微信号（平台高压线）。',
        '## 图集画面建议（3-6 张，之后图集页按描述逐张生成）',
        // 看图定制(2026-07-18 用户拍板):有产品图/风格图时,建议必须「先看图再写」——
        // 以自家产品为主体、模仿风格图的构图光线质感,不许凭正文空想一堆无关画面。
        ...((input.productImagePaths?.length || input.styleImagePaths?.length)
          ? [
              '**先看图再写(必做)**:用 Read 工具逐张查看下面的图片,看清楚了再写建议——',
              ...(input.productImagePaths?.length
                ? [`- 产品图(自家产品,生成时会原样融入画面,建议里的主体就是它们):\n${input.productImagePaths.map((p) => `  ${p}`).join('\n')}`]
                : []),
              ...(input.styleImagePaths?.length
                ? [`- 风格参考图(爆款原图——每条建议的构图/机位/光线/氛围/道具风格都要模仿它们的调子):\n${input.styleImagePaths.map((p) => `  ${p}`).join('\n')}`]
                : []),
              '每条建议 = 一个可直接执行的具体画面:【自家产品为主体】+【模仿风格图的构图光线氛围】+【呼应正文对应段落的卖点】。写清场景、机位/角度、光线、道具;别写与产品和风格图无关的泛泛画面。',
            ]
          : []),
        '- 第 1 张是封面：大字观点/清单结论，一眼有信息量；',
        '- 后续每张一个要点。',
        '- 每条只写【画面内容】(主体/构图/信息),**禁止写画风词**(插画/手绘/摄影/水彩/3D/卡通等)——画风由图集页的风格模板在生图时动态注入,描述里写了画风会和用户选的风格打架。',
        '## 交付',
        `1. 正文存临时文件 /tmp/studio-note-${article.id.slice(0, 8)}.md（纯正文，不含标题/标签/图集建议）；`,
        `2. \`od studio set ${article.id} --platform ${article.platform} --body-file /tmp/studio-note-${article.id.slice(0, 8)}.md --title "<≤20字标题>" --digest "<一句话简介>" --tags "标签1,标签2"\`；`,
        `3. 图集画面建议（每行一张的画面描述）存 /tmp/studio-note-ideas-${article.id.slice(0, 8)}.txt，写进 extra：`,
        '```bash',
        `node -e 'const fs=require("fs");fetch(process.env.OD_DAEMON_URL+"/api/media-studio/${article.platform}/articles/${article.id}",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({extra:{imageIdeas:fs.readFileSync("/tmp/studio-note-ideas-${article.id.slice(0, 8)}.txt","utf8")}})}).then(r=>console.log("ideas saved",r.status))'`,
        '```',
        '4. 写完先按 AI 腔自查清一遍（机翻感/套话），再交付。',
        cli,
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
        (input.knowledge?.length ?? 0) > 0
          ? '## 产品纪律（硬性）：脚本主角必须是知识库里的自家产品/品牌，卖点从知识库取材；参考的爆款只借结构钩子，其它品牌名一律不出现。'
          : '',
        '## 想清楚这几块，但【正文只写口播脚本本身】',
        '- 标题备选：构思 3 个（钩子感强、平台风格），挑最好的一个作 --title，其余不写进正文；',
        '- 口播脚本：钩子（前3秒）→ 预告 → 正文分点 → CTA，逐句可读，不写镜头术语、不写 markdown 强调符号——这就是正文的全部内容；',
        '- 话题标签：5-8 个（不带#，逗号分隔）→ 走 --tags，不写进正文；',
        '- 封面文字：主标题 + 副标题 → 走 --digest，不写进正文。',
        '## 交付（关键）',
        '1. 【只把口播脚本正文】写进临时文件——不要把「标题备选/话题标签/封面文字」写进这个正文文件；',
        `2. \`od studio set ${article.id} --platform ${article.platform} --body-file <文件> --title "<最佳标题>" --digest "<封面主标题或一句话简介>" --tags "标签1,标签2"\`。`,
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
          '## 第 0 步：先做素材调研（必做，然后才动笔；**时间盒：最多 3 次检索，素材够支撑正文就立刻动笔**——宁可写作中发现缺口再补一查，绝不前置长调研）',
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
        '**最高优先级：必须一次性交付完整成品，且成品必须通过 `od studio set` 命令写回（把稿子写成本地/项目目录文件不算交付）。全程绝不提问、绝不等待确认——任何取舍自己按最优判断拍板并继续（调研范围、结构、角度、案例取舍……全部如此）。**',
        '**进度自报（用户在界面上实时等着看）**：每进入一个阶段，先单独输出一行进度标记再干活——`【进度】1/3 调研素材中…`、`【进度】2/3 撰写正文中…`（初稿写回后）`【进度】3/3 清理 AI 腔、准备终稿…`。只输出这三条，别加别的进度行。',
        `选题：${article.topic || article.title || '（见下方补充要求）'}`,
        `文章类型：${articleType}`,
        input.wordCount?.trim() ? `目标字数：${input.wordCount.trim()} 字（允许 ±15%，宁短勿注水）` : '',
        note.trim() ? `补充要求：${note.trim()}` : '',
        accountBlock(input.account),
        knowledgeBlock(input.knowledge),
        researchPhase,
        '## 硬约束',
        '- **标题必须重新拟**（选题原句只是方向描述，不是成品标题），**严格 ≤21 个中文字符**（微信硬限 64 字节，超出 `od studio set` 会直接报错拒收）。写完标题先数一遍字数再用。',
        '- **摘要（digest）必须交付**：一句话卖点（≤100 字），说清「读者能得到什么」，吸引点开——不要复述标题、不要写「本文介绍了……」。',
        '- **正文不写大标题**（标题单独走 title 字段），从导语/首段直接开始。',
        '- 在正文里标注配图位：`<!-- IMAGE_N: 画面描述, 4:3 -->`（封面 `<!-- IMAGE_COVER: 描述, 16:9 -->` 放最前）。**标注必须紧跟在它要配图的那个段落后面**（生图会按这个位置取上文段落做场景依据）。',
        input.imageCount?.trim()
          ? (input.imageCount.trim() === '0'
              ? '- **配图数量（用户指定）：正文不放任何配图位**（封面标注照常放）。'
              : `- **配图数量（用户指定）：正文配图位必须正好 ${input.imageCount.trim()} 个**（封面标注不计入）。放在最能提升理解的段落后。`)
          : '- **配图数量：正文配图位最多 3 个**（封面不计入），宁缺毋滥——只放在配图真能提升理解/情绪的关键段落后。',
        // 配图风格贯通(2026-07-20 用户拍板:写作时已选定风格,描述用词必须与之协调
        // ——此前智能体不知道风格,写出的"写实摄影感"会和用户选的插画/手绘风打架)。
        (() => {
          const id = input.imageStyle?.trim();
          if (!id) return '';
          if (id === 'none') {
            return '- **配图风格（用户已选）：不用模板（纯提示词）**——风格完全由你的描述决定：封面与每条配图描述都自带完整风格词（媒介、质感、光线、色调），整篇统一同一种风格。';
          }
          const label = IMAGE_STYLE_PRESETS.find((s) => s.id === id)?.label ?? id;
          const textRule = id === 'bigtext'
            ? '该风格允许画面出现大字标题——封面描述里直接给出要写的那句短标题（≤12 字）；正文配图位仍不写字。'
            : '';
          return `- **配图风格（用户已选）：《${label}》**——封面与所有配图位的描述必须与该风格协调：场景、光线、质感、氛围的用词都按这个风格的视觉语言写；不要写与风格冲突的媒介词（摄影类风格别写「插画/卡通/3D」，插画手绘类风格别写「实拍/镜头/摄影质感」）。生图时系统会自动叠加该风格的完整风格词，描述不必堆风格词，专注画面内容本身。${textRule}`;
        })(),
        '- **配图描述是直接发给生图模型的完整提示词，必须细致**，40~120 字，且画的必须是所在段落讲的事。按分镜要素写全：主体（谁/什么，外观特征）+ 动作或状态 + 环境与关键道具（来自该段的具体事物）+ 构图与视角（特写/俯视/中景…）+ 光线与色调 + 质感/情绪。禁止「商务场景」「示意图」「相关配图」这类空泛词；画面里不要出现可读文字（生图模型写不好字）；讲数据/政策的段落用可视化隐喻（上涨曲线、天平、盖章的文件、放大镜看合同等）。示例：段落讲「社保断缴影响购房资格」→ `<!-- IMAGE_2: 特写镜头，一只手正把社保卡插回桌上的读卡器，卡面微微反光；旁边摊开的购房合同压着一串黄铜钥匙，背景是虚化的窗光客厅；暖色台灯光从左侧打来，写实摄影质感，氛围略带紧迫, 4:3 -->`（示例按摄影风格写；实际质感/媒介用词跟随所选配图风格）。',
        '- markdown 只用 `##`/`###` 小节、`**加粗**`、`>` 引用、`1.`/`-` 列表。',
        method ? `## 方法论（贝拉爆文方法论，策略层）\n${method}` : '',
        writer ? `## 文章类型写法（${writerSkill}，落笔层）\n${writer}` : '（工作台写作技能文件缺失——按公众号最佳实践写。）',
        detector ? `## AI 腔自查（写完必须过一遍再交付，与写作同一次完成）\n${detector}` : '',
        '## 交付（写作 + 清 AI 腔一次完成，不分两趟；但要两次写回让用户实时看到）',
        `1. **初稿写完立刻先写回一次**（用户界面在实时等着看）：初稿存 /tmp/studio-article-${article.id.slice(0, 8)}.md，马上执行 \`od studio set ${article.id} --body-file /tmp/studio-article-${article.id.slice(0, 8)}.md --title "<拟好的标题,≤21个中文字符>" --digest "<一句话摘要>"\`——**标题和摘要初稿就要有**，不许留空到最后；`,
        '2. 然后**按上面的 AI 腔自查方法通读清理一遍**（机翻感/套话/空转过渡/防御性自证）；',
        `3. 清理后的终稿覆盖同一个临时文件，再写回一次：\`od studio set ${article.id} --body-file /tmp/studio-article-${article.id.slice(0, 8)}.md --title "<终稿标题>" --digest "<一句话摘要>"\`。`,
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
