/**
 * Media Studio（媒体创作台）contracts — spec: specs/current/media-studio.md
 *
 * Core idea: a persistent, layered Article entity that four standalone-but-
 * chainable navigations (选题/写作/排版/发布) all operate on. Rendering and
 * publishing are deterministic product code (no agent in the loop); topic
 * finding and writing may be agent-assisted but always land in this entity.
 *
 * Platform-parameterized: `wechat-mp` is the first implementation. New
 * platforms reuse the same entities/routes with their own renderer/publisher.
 */

/** Known studio platforms. Keep the string fallback so new platforms can ship
 *  daemon-side before this union catches up. */
export type MediaStudioPlatform = 'wechat-mp' | (string & {});

export type MediaArticleStatus = 'writing' | 'rendered' | 'published';

/** 公众号排版皮肤 ids（与工作台 styles.json 同源，已移植为 daemon 常量）。 */
export type WechatSkinId = 'kaiti' | 'orangeheart' | 'github';

/** The layered article. `title` never renders into the body — platforms
 *  carry it in their own title field. Body = headerMd + bodyMd + footerMd
 *  concatenated at render time so fixed openings/closings stay reusable. */
export interface MediaArticle {
  id: string;
  platform: MediaStudioPlatform;
  /** Bound platform-account id (accounts center), optional until publish. */
  accountId: string | null;
  title: string;
  digest: string;
  /** Where this article came from (topic title), display-only. */
  topic: string | null;
  headerMd: string;
  bodyMd: string;
  footerMd: string;
  skin: string;
  /** Cover image source: http(s) URL or absolute local path. Empty string =
   *  fall back to the first in-body image at publish time. */
  coverSource: string;
  /** Last persisted render (排版导航「保存排版」). Live preview does NOT
   *  write this — it uses the stateless render endpoint. */
  renderedHtml: string | null;
  renderedSkin: string | null;
  renderedAt: number | null;
  status: MediaArticleStatus;
  /** Platform-specific fields (short-video: videoPath/audioPath/tags/voice/
   *  tone/duration…), free-form JSON so the shared entity stays generic. */
  extra: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

/** List-view projection (omit heavy bodies). */
export interface MediaArticleSummary {
  id: string;
  platform: MediaStudioPlatform;
  accountId: string | null;
  title: string;
  topic: string | null;
  skin: string;
  status: MediaArticleStatus;
  updatedAt: number;
  createdAt: number;
  /** 子平台（短视频台按平台分视图用；= extra.targetPlatform，如「抖音」）。
   *  其它创作台为空。2026-07-12 短视频平台化重构。 */
  subPlatform?: string;
}

export interface MediaTopic {
  id: string;
  platform: MediaStudioPlatform;
  title: string;
  angle: string;
  source: string;
  url: string;
  heat: string;
  /** 原素材(爆款沉淀时带回;无则空)。 */
  sourceContent: string;
  sourceImages: string[];
  status: 'candidate' | 'used';
  createdAt: number;
}

/** Reusable snippet library — fixed openings/closings (markdown) and saved
 *  covers (contentMd carries the asset URL for slot 'cover'). */
export interface MediaSnippet {
  id: string;
  platform: MediaStudioPlatform;
  slot: 'header' | 'footer' | 'cover';
  name: string;
  contentMd: string;
  updatedAt: number;
}

/** 版本快照（AI 动作前自动创建；可手动存档）。 */
export interface MediaArticleVersion {
  id: string;
  articleId: string;
  label: string;
  title: string;
  digest: string;
  headerMd: string;
  bodyMd: string;
  footerMd: string;
  createdAt: number;
}
export interface MediaVersionListResponse {
  versions: MediaArticleVersion[];
}

/** 知识库条目（platform 级,可选绑定账号）。 */
export interface MediaKnowledge {
  id: string;
  platform: MediaStudioPlatform;
  accountId: string | null;
  name: string;
  contentMd: string;
  /** 公司知识分类：company/product/trust/case/card/other（历史数据默认 other）. */
  category: string;
  updatedAt: number;
  /** 飞书数据中心双写后的 record_id（我的素材库/风格画像库那条），用于更新幂等 + 删除同步。 */
  feishuRecordId?: string | null;
  /** 该条落在哪张飞书表（我的素材库 / 风格画像库）。 */
  feishuTable?: string | null;
}
export interface MediaKnowledgeListResponse {
  items: MediaKnowledge[];
}
export interface CreateMediaKnowledgeRequest {
  name: string;
  contentMd: string;
  accountId?: string | null;
  /** 分类 id（缺省 other）. */
  category?: string;
}

export interface UploadStudioAssetRequest {
  filename: string;
  /** base64（不带 data: 前缀）. */
  dataBase64: string;
}
export interface UploadStudioAssetResponse {
  url: string;
  file: string;
}

/** 抓取公众号原文（大家来 article_detail 直调）——素材简报的原料。 */
export interface FetchArticleDetailRequest {
  url: string;
}
export interface FetchArticleDetailResponse {
  title: string;
  account: string;
  markdown: string;
}

export interface MediaPublishRecord {
  id: string;
  articleId: string;
  platform: MediaStudioPlatform;
  accountId: string | null;
  accountName: string;
  status: 'ok' | 'error';
  /** WeChat draft media_id on success. */
  draftMediaId: string | null;
  /** Which step failed: token | upload | cover | draft | render | account. */
  failedStep: string | null;
  error: string | null;
  createdAt: number;
}

// ---- requests / responses ----

export interface MediaArticleListResponse {
  articles: MediaArticleSummary[];
}
export interface MediaArticleResponse {
  article: MediaArticle;
}
export interface CreateMediaArticleRequest {
  title?: string;
  topic?: string | null;
  /** When set, marks the topic row as used and copies its title. */
  fromTopicId?: string | null;
  accountId?: string | null;
  skin?: string;
  headerMd?: string;
  bodyMd?: string;
  footerMd?: string;
  /** 创建即写入 extra（短视频台按平台建作品时种 targetPlatform）。 */
  extra?: Record<string, unknown>;
}
export interface UpdateMediaArticleRequest {
  title?: string;
  digest?: string;
  topic?: string | null;
  accountId?: string | null;
  headerMd?: string;
  bodyMd?: string;
  footerMd?: string;
  skin?: string;
  coverSource?: string;
  /** Shallow-merged into the stored extra (null value deletes the key). */
  extra?: Record<string, unknown>;
}

/** Stateless render — powers live preview and the standalone 排版 mode.
 *  Renders header+body+footer with the platform renderer; nothing persisted. */
export interface MediaRenderRequest {
  platform?: MediaStudioPlatform;
  skin?: string;
  headerMd?: string;
  bodyMd?: string;
  footerMd?: string;
  /** 正文字号 px（12-22；缺省用皮肤默认 15）。 */
  bodyFontSize?: number;
  /** 小节标题字号 px（14-30；缺省用皮肤默认 20，### 自动 -3）。 */
  headingFontSize?: number;
}
export interface MediaRenderResponse {
  html: string;
  skin: string;
  /** Non-fatal notes（e.g. 剥掉了首行大标题 / 检测到本地图片将在发布时上传替换）. */
  notes: string[];
}

export interface PublishMediaArticleRequest {
  /** Platform account id from the accounts center. */
  accountId: string;
}
export interface PublishMediaArticleResponse {
  record: MediaPublishRecord;
  article: MediaArticle;
}
export interface MediaPublishListResponse {
  publishes: MediaPublishRecord[];
}

export interface MediaTopicListResponse {
  topics: MediaTopic[];
}
export interface CreateMediaTopicRequest {
  title: string;
  angle?: string;
  source?: string;
  url?: string;
  heat?: string;
  /** 原素材(2026-07-18):爆款沉淀候选时带上原文案/原图,「去创作」随稿带走。 */
  sourceContent?: string;
  sourceImages?: string[];
}
export interface UpdateMediaTopicRequest {
  title?: string;
  angle?: string;
  source?: string;
  url?: string;
  heat?: string;
  status?: 'candidate' | 'used';
}
export interface MediaTopicResponse {
  topic: MediaTopic;
}

export interface MediaSnippetListResponse {
  snippets: MediaSnippet[];
}
export interface CreateMediaSnippetRequest {
  slot: 'header' | 'footer' | 'cover';
  name: string;
  contentMd: string;
}
export interface MediaSnippetResponse {
  snippet: MediaSnippet;
}

// ---- topic data feeds（大家来爆文榜/微信搜一搜/双信号雷达，daemon 直调） ----

/** One hot-article hit from the dajiala data feeds. Transient (not stored)
 *  until the user promotes it into a MediaTopic candidate. */
export interface MediaTopicHit {
  title: string;
  url: string;
  account: string;
  publishedAt: string;
  /** trending = 阅读爆款榜；realtime = 搜一搜；kwdb = 全库搜索；peer = 对标动态. */
  signals: Array<'trending' | 'realtime' | 'kwdb' | 'peer'>;
  readNum: number | null;
  zanNum: number | null;
  /** 爆值 from the trending feed, opaque string. */
  hot: string | null;
  desc: string | null;
  /** 小红书图文爆款采集时随本条带回的原文案(desc)——图文笔记台「提取图文仿写」用,保证和本条一致。 */
  sourceContent?: string;
  /** 小红书图文爆款采集时随本条带回的原图直链——「提取图文仿写」下载进图集。 */
  sourceImages?: string[];
}

export interface TopicFeedSearchRequest {
  keyword?: string;
  /** trending window in days (default 7). */
  days?: number;
  page?: number;
  /** realtime sort: hottest(默认)/latest/all. */
  sort?: 'hottest' | 'latest' | 'all';
  /** peers feed：对标账号名列表（≤5 个）. */
  accounts?: string[];
}
export interface TopicFeedSearchResponse {
  items: MediaTopicHit[];
  /** Which feeds actually responded (radar degrades gracefully). */
  sources: Array<'trending' | 'realtime' | 'kwdb' | 'sug' | 'peer'>;
  /** sug feed：微信搜索联想词（微信用户的真实需求词）. */
  words?: string[];
}

// ---- TikHub 选题源（短视频/图文,按目标平台分流:抖音↔抖音接口…） ----

export interface TikhubFeedRequest {
  /** 目标发布平台——选题数据从该平台自己的接口来。 */
  target: 'douyin' | 'xiaohongshu' | 'kuaishou' | 'zhihu' | 'weibo';
  /** hot = 平台热榜;search = 平台内关键词搜索。 */
  mode: 'hot' | 'search';
  keyword?: string;
}

export interface TikhubFeedResponse {
  items: MediaTopicHit[];
  target: TikhubFeedRequest['target'];
  mode: TikhubFeedRequest['mode'];
}

// ---- article images（千问生图直调） ----

export interface GenerateArticleImageRequest {
  /** Scene description (Chinese ok). */
  description: string;
  /** 生图模型 id：qwen(默认) / gemini；将来扩展更多模型往这里加. */
  model?: string;
  /** whiteboard(默认) / illustrated / clean. */
  style?: string;
  /** 16:9 / 4:3(默认) / 3:4 / 1:1 / 9:16. */
  ratio?: string;
  /** When set, replace this `<!-- IMAGE_<marker>: ... -->` comment in bodyMd
   *  with the generated image markdown. e.g. marker: "1" or "COVER". */
  marker?: string | null;
  /** true → also set the article coverSource to the generated asset. */
  asCover?: boolean;
  /** Optional reference image (URL or local absolute path) steering the
   *  generation — 封面可带参考图. */
  referenceImage?: string | null;
  /** 多参考图（2026-07-18 用户拍板：产品图+风格图两类同传）——有序：产品图在前、
   *  风格参考图殿后；prompt 里按「前N张=产品、最后一张=风格」指代。优先于 referenceImage。 */
  referenceImages?: string[] | null;
}
export interface GenerateArticleImageResponse {
  /** Web-servable asset URL (/api/media-studio/assets/...). */
  url: string;
  file: string;
  article: MediaArticle;
  /** 生成过程说明（如：提示词被审查拦截已自动中性化 / 已切 Gemini 备用）。 */
  note?: string;
}

// ---- studio AI tasks（每步的智能体动作；执行走既有 /api/runs） ----

export type StudioAiTaskKind = 'topics' | 'write' | 'revise' | 'ai-check' | 'script' | 'research' | 'review';

// ---- short-video: 配音（火山 TTS 直调工作台脚本） ----

export interface StudioTtsRequest {
  /** 文本；空则取文章口播脚本（bodyMd 去掉标注后的纯文本）. */
  text?: string;
  /** 火山音色 id（S_ 开头为复刻音色）；空用默认音色. */
  voice?: string;
}
export interface StudioTtsResponse {
  /** Web-servable wav URL (/api/media-studio/assets/...). */
  url: string;
  file: string;
  article: MediaArticle;
}

// ---- short-video: 多平台矩阵发布（sau CLI 直调；对外动作,UI 必须人工确认） ----

/** sau 平台 id（tencent = 视频号）. */
export type SauPlatformId = 'douyin' | 'xiaohongshu' | 'kuaishou' | 'bilibili' | 'tencent';

export interface SauTarget {
  platform: SauPlatformId;
  /** sau 的 --account 档案名（cookie 档案）. */
  account: string;
}

export interface SauCheckRequest {
  target: SauTarget;
}
export interface SauCheckResponse {
  loggedIn: boolean;
  detail: string;
}

/** 图文笔记矩阵发布（sau upload-note；小红书/抖音/快手）。 */
export interface PublishNoteRequest {
  targets: SauTarget[];
  /** 定时发布 "YYYY-MM-DD HH:mm"（可选）. */
  schedule?: string;
}

export interface PublishVideoRequest {
  targets: SauTarget[];
  /** 视频文件绝对路径；空则取文章 extra.videoPath. */
  videoPath?: string;
  /** 定时发布 "YYYY-MM-DD HH:mm"（可选）. */
  schedule?: string;
}
export interface PublishVideoResponse {
  records: MediaPublishRecord[];
  article: MediaArticle;
}

export interface StudioAiTaskRequest {
  kind: StudioAiTaskKind;
  articleId?: string | null;
  input?: {
    /** topics: 方向/领域；write: 补充要求；revise: 修改意见. */
    note?: string;
    /** write: 文章类型（对应工作台 writer 技能）. */
    articleType?: string;
    /** write: 目标字数档位（如 "1500-2000"）. */
    wordCount?: string;
    /** 绑定账号 id（写作按人设写）. */
    accountId?: string;
    /** topics: 用户勾选的优先参考文章（AI 优先围绕它们深挖出题）. */
    picked?: Array<{ title: string; url?: string; account?: string; readNum?: number | null }>;
    /** topics: 选题目标平台 id（如 'xiaohongshu'）——引用链接只准该平台站内链接，
     *  站外来源（新闻/公众号）只写来源名、url 留空（2026-07-18 用户拍板：小红书选题必须全部来自小红书）. */
    sourcePlatform?: string;
  };
}
export interface StudioAiTaskResponse {
  projectId: string;
  conversationId: string;
  /** Composed step prompt — the web starts the run via POST /api/runs. */
  prompt: string;
  title: string;
}

/** 音色设计（2026-07-19 用户拍板「界面功能支持音色设计,这很重要」）。
 *  双通道：qwen=千问 qwen3-tts-instruct（描述→指令控制音色,即设即听,无需预训练）;
 *  volc=火山 openspeech voice_design（正牌音色设计,产出可复用 speaker_id,
 *  需语音技术 X-Api-Key + 已购音色位）。 */
export interface VoiceDesignRequest {
  /** 默认 'qwen'。 */
  provider?: 'qwen' | 'volc';
  /** 音色描述提示词，如「年轻女性,声音温柔,语速中等偏慢」。 */
  prompt: string;
  /** 试听文本。 */
  text: string;
  /** qwen：基底音色（默认 Ethan）；volc：已购 speaker_id（S_ 开头，必填）。 */
  voice?: string;
}
export interface VoiceDesignResponse {
  provider: 'qwen' | 'volc';
  /** 试听音频 URL（远端直链，短期有效，试听后可下载保存）。 */
  audioUrl: string;
  /** volc：训练出的音色代号（后续 TTS 直接用）。 */
  speakerId?: string;
  /** qwen：复用参数——配音时同 voice+instructions 即同款声音。 */
  voice?: string;
  prompt?: string;
}

/** 已保存的音色预设（音色设计的产物，配音步选用）。 */
export interface VoicePreset {
  id: string;
  name: string;
  provider: 'qwen' | 'volc';
  /** qwen：基底音色（Ethan/Cherry…）。 */
  voice?: string;
  /** qwen：音色描述指令（instructions）。 */
  prompt?: string;
  /** volc：voice_design 训练出的音色代号（S_ 开头）。 */
  speakerId?: string;
  createdAt: number;
}

/** 浏览器注入发布可用的平台（桌面端 webview 注入器白名单）。 */
export type StudioHandoffPlatform = 'zhihu' | 'weibo' | 'xiaohongshu' | 'douyin' | 'kuaishou' | 'bilibili' | 'tencent';

export type StudioHandoffStatus = 'pending' | 'claimed' | 'running' | 'done' | 'error';

/** 浏览器注入发布派发 job：CLI `od studio handoff` → daemon 总线 →
 *  桌面端 web 认领执行（webview 注入），进度/终态回写到 job。 */
export interface StudioHandoffJob {
  id: string;
  platform: StudioHandoffPlatform;
  articleId: string;
  /** 文章所属创作台平台（articleId 的查询键，如 zhihu/weibo/note/short-video）。 */
  articlePlatform: string;
  /** 目标账号名；空 = 桌面端按账号中心该平台第一个绑定账号解析。 */
  account?: string;
  /** true = 填稿后真实点击平台「发布/发送」直发；false = 只填到发送前一步。 */
  autoPublish: boolean;
  status: StudioHandoffStatus;
  /** 注入进度行（追加式；wait 按 since 游标取增量）。 */
  progress: string[];
  /** 终态说明（done=成功详情 / error=失败原因+人工接手指引）。 */
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateStudioHandoffRequest {
  platform: StudioHandoffPlatform;
  articleId: string;
  account?: string;
  autoPublish?: boolean;
}

export interface StudioHandoffJobResponse {
  job: StudioHandoffJob;
}

/** wait 长轮询响应：progress 为自 `since` 起的增量，cursor 是下次 since。 */
export interface StudioHandoffWaitResponse {
  job: StudioHandoffJob;
  cursor: number;
}

export interface StudioHandoffCompleteRequest {
  ok: boolean;
  detail: string;
}

// ── 内置浏览器采集（爆款雷达用；在应用内标签 webview 里抓，不弹独立窗口）──
//
// CLI/引擎 POST /api/media-studio/collect 建 job → daemon 总线 SSE 广播给桌面端 web
// → web 在【应用内标签】打开各平台搜索页、executeJavaScript 抓真实爆款卡片 →
// progress 回写进度 → complete 回传采集到的条目 JSON → 调用方 wait 长轮询取。
// 登录态在桌面端 webview 分区里（daemon 够不着），所以采集必须跑在桌面端标签。
export type StudioCollectPlatform = 'xiaohongshu' | 'douyin' | 'bilibili' | 'kuaishou';

export type StudioCollectStatus = 'pending' | 'claimed' | 'running' | 'done' | 'error';

/** 采集到的一条作品（统一扁平字段，喂引擎 --collect-file）。 */
export interface StudioCollectItem {
  platform: StudioCollectPlatform;
  content_id?: string;
  title: string;
  url?: string;
  author?: string;
  likes?: string | number;
  comments?: string | number;
  collects?: string | number;
  plays?: string | number;
}

/** 某平台的采集结果（web 抓完每平台回写一段）。 */
export interface StudioCollectPlatformResult {
  platform: StudioCollectPlatform;
  items: StudioCollectItem[];
  needsLogin: boolean;
  note?: string;
}

/** 排序：hot=最多播放/热度(找爆款默认)，latest=最新，comprehensive=综合。 */
export type StudioCollectOrder = 'hot' | 'latest' | 'comprehensive';

export interface StudioCollectJob {
  id: string;
  keyword: string;
  platforms: StudioCollectPlatform[];
  /** 每平台滚动次数、每平台取多少条（web 采集参数）。 */
  scrolls: number;
  per: number;
  /** 排序（找爆款默认 hot）。 */
  order: StudioCollectOrder;
  /** 时间窗 key：1d/7d/30d/90d/180d/365d/all（搜索参数里过滤）。 */
  timeWindow: string;
  /** 分页平台(如B站)翻几页；无限滚动平台按 scrolls 滚动。 */
  pages: number;
  status: StudioCollectStatus;
  progress: string[];
  /** 各平台采集结果（complete 时或逐平台回填）。 */
  results: StudioCollectPlatformResult[];
  detail?: string;
  createdAt: number;
  updatedAt: number;
}

export interface CreateStudioCollectRequest {
  keyword: string;
  platforms?: StudioCollectPlatform[];
  scrolls?: number;
  per?: number;
  order?: StudioCollectOrder;
  timeWindow?: string;
  pages?: number;
}

export interface StudioCollectJobResponse {
  job: StudioCollectJob;
}

export interface StudioCollectWaitResponse {
  job: StudioCollectJob;
  cursor: number;
}

/** web 采集完回写：某平台一段结果（needsLogin 时 items 空）。 */
export interface StudioCollectResultRequest {
  results: StudioCollectPlatformResult[];
  ok: boolean;
  detail?: string;
}

/** 生图风格模板(公众号/图文笔记等创作台共用下拉)。
 *  id 与 daemon `composeStylePrompt` 的风格前缀表一一对应——加新风格两边同步。
 *  标注「带文字」的风格允许模型在画面里写字,其余默认禁文字(防模型乱写中文)。 */
export interface ImageStylePreset {
  id: string;
  label: string;
  /** 该风格的画风提示词(生图时动态注入;前端预览与 daemon 实发同源,单一来源)。none 为空串。 */
  prompt: string;
  /** 禁模型自写文字(非「带文字」风格默认禁,防乱码中文)。 */
  noText?: boolean;
  /** 该风格专属负面词(如纪实风的反精致清单)。 */
  extraNegative?: string;
}

/** 生图最终提示词的两段包装(前端预览与 daemon 组装共用,保证所见即所发)。 */
export const IMAGE_STYLE_WRAP = {
  styleHead: '【画风要求,以此为准,忽略下文一切画风描述】',
  contentHead: '【画面内容】',
} as const;

export const IMAGE_STYLE_PRESETS: ReadonlyArray<ImageStylePreset> = [
  {
    id: 'whiteboard', label: '白板手绘（默认）',
    prompt: 'Whiteboard illustration style, hand-drawn with colored markers, clean white background, ' +
      'sketch-like diagrams and text, professional but casual, minimalist line art. ',
  },
  {
    id: 'candid', label: '真实抓拍（纪实）',
    prompt: '真实抓拍照片,纪录片摄影,活动纪实摄影质感。人物状态自然,不看镜头,不摆拍,神情放松专注于手上的事。' +
      '自然光线,普通人真实皮肤纹理,物品有真实使用痕迹、摆放随意不刻意。' +
      '轻微噪点,轻微虚焦,构图略微不完美,生活现场感。不是商业广告,不是摆拍写真。',
    noText: true,
    extraNegative: '，广告大片感，商业海报，杂志封面感，过度精致，完美布光，棚拍感，网红摆拍，人物看镜头，' +
      '夸张笑容，模特脸，精修皮肤，磨皮，物品摆放整整齐齐，豪华酒店感，廉价培训班感，' +
      '过度虚化，梦幻滤镜，塑料质感，卡通风，插画风，3D渲染，二维码，错误手部，多余手指，脸部变形',
  },
  {
    id: 'bigtext', label: '大字报封面（带文字）',
    prompt: 'Bold typographic cover design, one short punchy Chinese headline as the dominant visual element, ' +
      'solid or soft-gradient background, high contrast colors, viral social media cover style, ' +
      'text must be large, sharp and accurate. ',
  },
  {
    id: 'photo-film', label: '胶片实拍',
    prompt: 'Authentic film photography, Fujifilm color palette, natural window light, candid lifestyle scene, ' +
      'subtle grain, shallow depth of field, thoughtful composition. ',
    noText: true,
  },
  {
    id: 'photo-magazine', label: '杂志大片',
    prompt: 'High-end editorial magazine photography, studio lighting, generous negative space, ' +
      'refined muted color grading, premium fashion aesthetic. ',
    noText: true,
  },
  {
    id: 'minimal', label: '极简高级',
    prompt: 'Minimalist poster design, large negative space, restrained low-saturation palette, ' +
      'clean geometric composition, premium understated aesthetic. ',
    noText: true,
  },
  {
    id: 'flat-info', label: '扁平信息图',
    prompt: 'Flat vector infographic illustration, iconified elements, clear sections on a tidy grid, ' +
      'modern business style, crisp edges, harmonious duotone palette, icons only. ',
    noText: true,
  },
  {
    id: 'threed', label: '3D 立体（C4D）',
    prompt: 'Cute 3D render in C4D style, soft studio lighting, rounded glossy materials, ' +
      'pastel fresh colors, octane quality, centered hero object. ',
    noText: true,
  },
  {
    id: 'guochao', label: '国潮新中式',
    prompt: 'China-chic guochao illustration, new Chinese style, vermilion red, indigo blue and gold accents, ' +
      'auspicious cloud patterns, traditional motifs with modern flat design. ',
    noText: true,
  },
  {
    id: 'journal', label: '手账拼贴',
    prompt: 'Cozy scrapbook journal collage, washi tape, stickers, polaroid photo frames, ' +
      'handwritten note vibes, warm paper texture, playful layout. ',
  },
  {
    id: 'watercolor', label: '水彩清新',
    prompt: 'Fresh watercolor painting, translucent washes, soft blooming edges, airy negative space, light clean colors. ',
    noText: true,
  },
  {
    id: 'cute', label: '可爱 Q 版',
    prompt: 'Adorable chibi cartoon style, big head small body, rounded shapes, soft candy color palette, ' +
      'expressive kawaii faces, sticker-like. ',
    noText: true,
  },
  {
    id: 'oil', label: '油画质感',
    prompt: 'Classical oil painting, visible impasto brushstrokes, Rembrandt lighting, rich deep tones, ' +
      'fine art gallery quality. ',
    noText: true,
  },
  { id: 'none', label: '不用模板（纯提示词）', prompt: '' },
];
// 2026-07-17 用户拍板移除:暖插画(illustrated)/纯净插画(clean)/赛博霓虹(cyber)。
// daemon composeStylePrompt 仍保留 illustrated/clean 的兼容分支(老稿/旧偏好可能还带)。

/** 画风词清洗:选了内置风格时,把描述里混入的画风词剥掉(老稿的图集建议/配图标注里
 *  常有 AI 写死的"扁平插画风"之类,和所选风格打架)。只剥「××风/风格/画风/感」后缀形态
 *  与少量固定短语,不伤内容名词("水彩颜料小碗"不受影响);none 风格不清洗(用户全权)。 */
export function stripStyleWords(description: string): string {
  return description
    .replace(/(扁平插画|白板手绘|手绘插画|扁平|插画|手绘|水彩|油画|素描|卡通|漫画|Q版|3D渲染|3D|三维|C4D|赛博朋克|霓虹|胶片|摄影|写实|极简|国潮|水墨|像素|波普|孟菲斯)(风格|画风|风)/g, '')
    .replace(/(插画感|手绘感|卡通感|3D感|渲染感)/g, '')
    .replace(/^[,，、:：;；.。\s]+/, '')
    .replace(/[,，、]{2,}/g, '，')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** 组装最终生图提示词(前端预览与 daemon 实发共用,所见即所发;含画风词清洗)。 */
export function composeImagePrompt(styleId: string, description: string): string {
  const preset = IMAGE_STYLE_PRESETS.find((s) => s.id === styleId);
  const stylePrompt = preset?.prompt ?? '';
  if (!stylePrompt) return description;
  const cleaned = stripStyleWords(description) || description;
  return `${IMAGE_STYLE_WRAP.styleHead}${stylePrompt}\n${IMAGE_STYLE_WRAP.contentHead}${cleaned}`;
}

/** 生图比例选项(图文笔记台等)。默认 3:4(小红书竖图)。 */
export const IMAGE_RATIO_OPTIONS: ReadonlyArray<{ id: string; label: string }> = [
  { id: '3:4', label: '3:4 竖图（默认）' },
  { id: '4:3', label: '4:3 横图' },
  { id: '1:1', label: '1:1 方图' },
  { id: '9:16', label: '9:16 全屏竖' },
  { id: '16:9', label: '16:9 宽屏' },
];
