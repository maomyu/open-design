// 飞书数据中心 · 应用内镜像的单一事实源 schema。
//
// 这 10 张表结构从引擎 `bakuan-engine/src/feishu/tables.py` 的 TABLES 逐张搬来,
// 字段名【中文 = 飞书列名】三处同名(本地存储 fields_json 的 key、HTTP/CLI 载荷的
// key、飞书列名),1:1 不做英文映射——最省坑、写飞书时字段直接对得上。
//
// 这一份被 web(渲染列/表单)、daemon(本地库字段校验)、datacenter.py(推飞书字段
// 映射)共用,改表结构只改这里。契约层保持纯 TS(无 Node/浏览器/SQLite 依赖)。

export type DatacenterFieldType =
  | 'text'
  | 'number'
  | 'single_select'
  | 'multi_select'
  | 'checkbox'
  | 'datetime'
  | 'user'
  | 'attachment'
  | 'link'
  | 'auto_number'
  | 'formula';

export interface DatacenterField {
  /** 字段名 = 飞书列名(canonical key;本地/API/飞书三处同名)。 */
  name: string;
  type: DatacenterFieldType;
  /** 单/多选建议项(可选;飞书写新值会自动补选项,故非强制,仅供 UI 下拉提示)。 */
  options?: readonly string[];
  /**
   * UI 只读:系统生成或引擎产出的列(auto_number/formula/统计数)。用户表单不出编辑控件,
   * 推飞书时也不带(飞书 auto_number/formula 只读)。
   */
  readonly?: boolean;
}

/** 飞书里的分组:前台=常用直接看填,后台=折叠·高级。 */
export type DatacenterStage = 'front' | 'back';

/**
 * 维护归属:
 *  - `user`  你手填维护(App 为主 → 改完推飞书,引擎照读)。第一期做全增删改。
 *  - `engine` 引擎产出(采集/AI 生成的结果)。第一期只读展示,编辑/回填留第二期。
 */
export type DatacenterOwner = 'user' | 'engine';

export interface DatacenterTable {
  /** 稳定英文表键:HTTP 路径段 + 本地 table_key + CLI --table。永不改。 */
  key: string;
  /** 飞书表名(中文):推飞书时定位表。 */
  feishuName: string;
  /** UI 标题(可含 emoji)。 */
  label: string;
  stage: DatacenterStage;
  owner: DatacenterOwner;
  desc: string;
  /** 使用说明:这张表干嘛的 + 怎么填/怎么产生数据 + 和界面功能怎么联动(UI 信息框展示)。 */
  usage: string;
  /** 主字段(列表主列 + 飞书关联卡片显示的那一列)。 */
  primaryField: string;
  fields: readonly DatacenterField[];
}

const T = (name: string, type: DatacenterFieldType, extra?: Omit<DatacenterField, 'name' | 'type'>): DatacenterField => ({
  name,
  type,
  ...extra,
});

/** 客户真实平台列表(与飞书字段选项一致,见 convert_field_types.py PLAT)。 */
const PLAT = ['抖音', '小红书', 'B站', '快手', '公众号', '视频号'];

export const DATACENTER_TABLES: readonly DatacenterTable[] = [
  // ── 前台 5 ──────────────────────────────────────────────
  {
    key: 'monitor',
    feishuName: '监控配置库',
    label: '🎯 监控配置库',
    stage: 'front',
    owner: 'user',
    desc: '关键词库 + 竞品账号库;日常配置入口,引擎按此采集',
    usage:
      '【干嘛的】告诉引擎「盯哪些关键词/竞品账号」去各平台采集爆款。【怎么填】点「新建」:类型选关键词或竞品账号、填词/账号、选主题分类和平台、设优先级和时间窗、最低阈值(播放/阅读下限)、勾是否启用。【界面联动】你在创作台「采集选题/搜爆款」时,引擎就按这里启用的关键词去抓,结果进「爆款内容原始库/今日选题池」。改完自动同步飞书。',
    primaryField: '关键词/账号',
    fields: [
      T('记录ID', 'auto_number', { readonly: true }),
      T('类型', 'single_select', { options: ['关键词', '竞品账号'] }),
      T('关键词/账号', 'text'),
      T('主题分类', 'single_select', { options: ['婚恋观点', '约会', '自卑心态', '方法教程', '聊天技巧', '情感修复'] }),
      T('平台', 'multi_select', { options: PLAT }),
      T('优先级', 'single_select', { options: ['P0', 'P1', 'P2'] }),
      T('时间窗', 'single_select', { options: ['1d', '7d', '30d', '180d'] }),
      T('最低阈值', 'number'),
      T('是否启用', 'checkbox'),
      T('备注', 'text'),
    ],
  },
  {
    key: 'material',
    feishuName: '我的素材库',
    label: '📚 我的素材库',
    stage: 'front',
    owner: 'user',
    desc: '口播素材 + 封面参考;创作 RAG 召回来源',
    usage:
      '【干嘛的】你的人设/观点/金句/案例/封面参考的仓库,AI 创作时会召回这里的素材,让文案贴合你本人。【怎么填】点「新建」:选素材类型、填标题和原始内容、打主题标签和目标人群、勾是否可召回。【界面联动】创作台 AI 写文案/脚本时,勾选了「可召回」的素材会被喂给 AI 当背景资料(人设/口径/金句)。改完自动同步飞书。',
    primaryField: '素材标题',
    fields: [
      T('素材ID', 'auto_number', { readonly: true }),
      T('素材类型', 'single_select', { options: ['观点', '金句', '案例', '方法', '封面参考'] }),
      T('素材标题', 'text'),
      T('原始内容', 'text'),
      T('主题标签', 'multi_select', { options: ['脱单', '相亲', '男性成长', '社恐', '异地恋', '挽回'] }),
      T('目标人群', 'multi_select', { options: ['母胎单身男', '大龄单身男', '情感受挫男'] }),
      T('情绪强度', 'number'),
      T('参考封面', 'attachment'),
      T('版式标签', 'multi_select', { options: ['大字标题', '人像封面', '对比图', '纯色底'] }),
      T('是否可召回', 'checkbox'),
      T('更新时间', 'datetime'),
    ],
  },
  {
    key: 'topic',
    feishuName: '今日爆款选题池',
    label: '🔥 今日爆款选题池',
    stage: 'front',
    owner: 'engine',
    desc: '当日判定的爆款选题 + 评分 + 榜单 + 推荐承接',
    usage:
      '【干嘛的】引擎从原始库里筛出、打好分的「今天值得做的选题」。【怎么产生】不用手填——你在创作台「采集选题/搜爆款」时,引擎采集+评分后自动写进来(这里从飞书拉取只读展示)。【界面联动】本表是飞书存档视图,创作台的「候选选题」是本地另一份:①自动监控(监控配置库里启用的关键词/账号)采到的爆款会自动进创作台候选,直接点「去创作」即可;②你在创作台点「真抓爆款」采的,列在搜索结果里、勾选后点「存为候选」进候选表。想更新本表就去多采几个关键词。',
    primaryField: '评分理由',
    fields: [
      T('选题ID', 'auto_number', { readonly: true }),
      T('来源内容', 'link'),
      T('流量爆款分', 'number'),
      T('精准意向分', 'number'),
      T('内容类型', 'single_select', { options: ['双高型', '流量型', '意向型', '普通型'] }),
      T('推荐优先级', 'single_select', { options: ['S', 'A', 'B', 'C'] }),
      T('所属榜单', 'multi_select', { options: ['流量爆款榜', '精准意向榜', '双高榜', '低粉爆款榜'] }),
      T('评分理由', 'text'),
      T('高频用户问题', 'text'),
      T('推荐承接服务', 'text'),
    ],
  },
  {
    key: 'draft',
    feishuName: '成品内容审核库',
    label: '📝 成品内容审核库',
    stage: 'front',
    owner: 'engine',
    desc: '脚本 + 封面成品;人工审核入口',
    usage:
      '【干嘛的】引擎/AI 生成的脚本+封面成品,供你人工审核。【怎么产生】创作台「AI 创作」生成脚本、存草稿后点「标记完成」时写进来(从飞书拉取只读展示)。【界面联动】审核状态可在飞书里改(待审核/已通过/重新生成);「已通过」的才进入发布流程。',
    primaryField: '平台标题',
    fields: [
      T('成品ID', 'auto_number', { readonly: true }),
      T('关联选题', 'link'),
      T('平台版本', 'single_select', { options: PLAT }),
      T('平台标题', 'text'),
      T('封面标题候选', 'text'),
      T('60秒脚本', 'text'),
      T('90秒脚本', 'text'),
      T('标签', 'text'),
      T('简介', 'text'),
      T('评论引导', 'text'),
      T('封面成品', 'attachment'),
      T('原创性检查', 'text'),
      T('生成版本', 'number'),
      T('审核状态', 'single_select', { options: ['待审核', '已通过', '重新生成', '已重生成'] }),
      T('修改意见', 'text'),
    ],
  },
  {
    key: 'review',
    feishuName: '发布复盘库',
    label: '📈 发布复盘库',
    stage: 'front',
    owner: 'engine',
    desc: '发布后数据回流 + 运行日志/成本',
    usage:
      '【干嘛的】发布之后回填的效果数据(24h/72h/7d)+ 复盘结论 + 成本记录。【怎么产生】发布后在创作台点「复盘」时写进来(从飞书拉取只读展示);也含失败任务记录。【界面联动】「是否进正例库」勾上的会当成好案例反哺后续创作;复盘结论帮你迭代选题方向。',
    primaryField: '复盘结论',
    fields: [
      T('记录ID', 'auto_number', { readonly: true }),
      T('关联成品', 'link'),
      T('平台', 'single_select', { options: PLAT }),
      T('发布时间', 'datetime'),
      T('发布链接', 'text'),
      T('24h/72h/7d数据', 'text'),
      T('复盘结论', 'text'),
      T('是否进正例库', 'checkbox'),
      T('模型/接口成本', 'number'),
      T('错误摘要', 'text'),
      T('日志路径', 'text'),
    ],
  },
  // ── 后台 5 ──────────────────────────────────────────────
  {
    key: 'raw',
    feishuName: '爆款内容原始库',
    label: '🗃️ 爆款内容原始库',
    stage: 'back',
    owner: 'engine',
    desc: '各平台原始抓取 + 多期快照 + 去重指纹',
    usage:
      '【干嘛的】引擎从各平台抓来的原始爆款内容底库(带原文/播放/点赞等)。【怎么产生】你在创作台「采集选题/搜爆款」时,引擎按监控配置库的关键词去抓,写进这里(从飞书拉取只读展示)。【界面联动】它是选题池的上游——原始内容评分后才进选题池;想要更多素材就多采集。',
    primaryField: '标题',
    fields: [
      T('标题', 'text'),
      T('内容唯一ID', 'text'),
      T('平台', 'single_select', { options: PLAT }),
      T('内容类型', 'single_select', { options: ['视频', '图文', '文章'] }),
      T('原始链接', 'text'),
      T('原视频文案', 'text'),
      T('作者', 'text'),
      T('粉丝数', 'number'),
      T('发布时间', 'datetime'),
      T('首次抓取', 'datetime'),
      T('最近更新', 'datetime'),
      T('播放/阅读', 'number'),
      T('点赞', 'number'),
      T('评论', 'number'),
      T('收藏/投币', 'number'),
      T('转发', 'number'),
      T('数据快照JSON', 'text'),
      T('去重指纹', 'text'),
      T('命中规则', 'multi_select', {
        options: ['绝对热度', '低粉高表现', '账号异常·观察', '账号异常·A级', '账号异常·S级', '关键词头部', '快速起量', '公众号高阅读', '视频号高互动', '竞品账号监控', '单链接手动'],
      }),
      T('爆款总分', 'number'),
      T('爆款等级', 'single_select', { options: ['S', 'A', 'B', 'C'] }),
      T('处理状态', 'single_select', { options: ['待转写', '已处理', '失败'] }),
      T('失败原因', 'text'),
    ],
  },
  {
    key: 'breakdown',
    feishuName: '爆点拆解库',
    label: '🧩 爆点拆解库',
    stage: 'back',
    owner: 'engine',
    desc: 'AI 结构化拆解结果',
    usage:
      '【干嘛的】AI 把爆款拆成「钩子/核心矛盾/痛点/可借鉴结构」等,给你的创作当参考。【怎么产生】引擎对采集到的爆款做 AI 拆解时写进来(从飞书拉取只读展示)。【界面联动】创作台生成脚本时会参考这里的拆解结论,帮你复用爆款的结构套路。',
    primaryField: '核心矛盾',
    fields: [
      T('拆解ID', 'auto_number', { readonly: true }),
      T('关联内容', 'link'),
      T('选题类型', 'single_select', { options: ['痛点', '方法', '观点', '案例', '情感共鸣'] }),
      T('前3秒钩子', 'text'),
      T('核心矛盾', 'text'),
      T('用户痛点', 'text'),
      T('情绪点', 'multi_select', { options: ['共鸣', '希望', '焦虑', '愤怒', '认同', '好奇'] }),
      T('争议点', 'text'),
      T('内容结构', 'text'),
      T('可借鉴结构', 'text'),
      T('不应复制元素', 'text'),
      T('转化机会', 'text'),
      T('原视频文案', 'text'),
      T('评分明细JSON', 'text'),
      T('模型/Prompt版本', 'text'),
    ],
  },
  {
    key: 'style',
    feishuName: '风格画像库',
    label: '🎨 风格画像库',
    stage: 'back',
    owner: 'user',
    desc: '客户口播风格,控脚本语气',
    usage:
      '【干嘛的】定义你的口播风格(句长/语气/常用词/禁用词/CTA),让 AI 写的脚本像你本人说话。【怎么填】点「新建」:填风格版本、句长偏好、语气强度、常用结构/词、禁用表达、目标受众、CTA规则,勾「是否生效」(生效的那条控当前脚本语气)。【界面联动】创作台 AI 生成脚本时按这里的风格来;不满意就改这里再重生成。',
    primaryField: '风格版本',
    fields: [
      T('风格版本', 'text'),
      T('参考稿范围', 'link'),
      T('句长偏好', 'text'),
      T('语气强度', 'number'),
      T('常用结构', 'text'),
      T('常用词', 'text'),
      T('禁用表达', 'text'),
      T('目标受众', 'text'),
      T('CTA规则', 'text'),
      T('典型正例', 'link'),
      T('典型反例', 'link'),
      T('是否生效', 'checkbox'),
    ],
  },
  {
    key: 'prompt',
    feishuName: 'Prompt与模型策略库',
    label: '⚙️ Prompt 与模型策略库',
    stage: 'back',
    owner: 'user',
    desc: '各任务 Prompt 与模型路由,可在此改',
    usage:
      '【干嘛的】各 AI 任务(爆点拆解/意图评估/脚本生成)用的 Prompt 和模型,可在这里调。【怎么填】点「新建」:选任务类型、填 Prompt 正文和系统角色、选默认/备用模型、设温度和最大Token、勾是否启用。【界面联动】引擎跑对应任务时读这里启用的 Prompt——想调 AI 的产出风格/质量,改这里的 Prompt 正文即可,不用改代码。',
    primaryField: '任务类型',
    fields: [
      T('任务类型', 'single_select', { options: ['爆点拆解', '意图评估', '脚本生成'] }),
      T('Prompt版本', 'text'),
      T('Prompt正文', 'text'),
      T('系统角色', 'text'),
      T('默认模型', 'single_select', { options: ['deepseek-chat', 'deepseek-reasoner'] }),
      T('备用模型', 'single_select', { options: ['deepseek-chat', 'deepseek-reasoner'] }),
      T('温度/参数', 'text'),
      T('最大Token', 'number'),
      T('是否启用', 'checkbox'),
      T('备注', 'text'),
    ],
  },
  {
    key: 'config',
    feishuName: '系统配置表',
    label: '🔧 系统配置表',
    stage: 'back',
    owner: 'user',
    desc: '全局阈值/频率/TopK/默认模型',
    usage:
      '【干嘛的】引擎的全局参数(采集/评分阈值、检测频率、选题 TopK、默认模型档)。【怎么填】点「新建」:选配置项、填当前值和单位、勾是否启用。【界面联动】引擎跑采集/评分时读这些阈值——不懂就别乱动,默认值已调好;要放宽/收紧采集口径再调对应项。',
    primaryField: '配置项',
    fields: [
      T('配置ID', 'auto_number', { readonly: true }),
      T('配置项', 'single_select', {
        options: ['低粉最低点赞', '低粉赞粉比', '低粉粉丝上限', '账号异常观察倍数', '账号异常A倍数', '账号异常S倍数', '关键词头部比例', '快速起量窗口', '检测频率', 'TopK', '默认模型.high'],
      }),
      T('平台', 'multi_select', { options: PLAT }),
      T('当前值', 'text'),
      T('单位', 'text'),
      T('是否启用', 'checkbox'),
      T('修改人', 'user'),
      T('修改时间', 'datetime'),
    ],
  },
];

export const DATACENTER_TABLE_KEYS = DATACENTER_TABLES.map((t) => t.key);

export function datacenterTableByKey(key: string): DatacenterTable | undefined {
  return DATACENTER_TABLES.find((t) => t.key === key);
}

/** 同步态:仅本地 / 已推飞书 / 推飞书失败。 */
export type DatacenterSyncState = 'local' | 'synced' | 'error';

/** 应用内一条数据中心记录(本地为主,fields 用中文字段名做 key)。 */
export interface DatacenterRecord {
  /** 本地稳定 id(与飞书 record_id 无关)。 */
  id: string;
  tableKey: string;
  /** 字段值:{ 中文字段名: 值 }。值类型随字段:text→string、number→number、checkbox→boolean、multi_select→string[]。 */
  fields: Record<string, unknown>;
  /** 飞书 record_id(推成功后回写,幂等 update 用)。 */
  feishuRecordId?: string;
  syncState: DatacenterSyncState;
  syncError?: string;
  updatedAt: number;
}

export interface DatacenterTablesResponse {
  tables: readonly DatacenterTable[];
}

export interface DatacenterRecordListResponse {
  records: DatacenterRecord[];
}

export interface DatacenterRecordResponse {
  record: DatacenterRecord;
}

/** 新建/更新一条记录:只带字段值,同步飞书由服务端在写本地后异步做。 */
export interface UpsertDatacenterRecordRequest {
  fields: Record<string, unknown>;
}

/** 手动「同步到飞书」的结果(单条或整表)。 */
export interface DatacenterSyncResponse {
  ok: boolean;
  synced: number;
  failed: number;
  error?: string;
}
