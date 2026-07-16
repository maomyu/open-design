// 飞书数据中心·监控配置库 + 系统配置表 的界面 DTO（块3）。daemon 端点透传引擎
// scripts/datacenter.py 的 JSON，web 增删改列表用这些形状。平台标签只用飞书表认的 6 个中文
// （引擎 pipeline._PLAT_CN 只认这些；知乎/微博不在监控表内）。

export const MONITOR_PLATFORM_LABELS = ['抖音', '小红书', 'B站', '快手', '公众号', '视频号'] as const;
export type MonitorPlatformLabel = (typeof MONITOR_PLATFORM_LABELS)[number];

export const MONITOR_TIME_WINDOWS = ['1d', '7d', '30d', '180d'] as const;
export const MONITOR_PRIORITIES = ['P0', 'P1', 'P2'] as const;
export const MONITOR_CATEGORIES = [
  '婚恋观点', '约会', '自卑心态', '方法教程', '聊天技巧', '情感修复',
] as const;

/** 监控配置库一行（引擎定时任务据此跑；是否启用=true 才生效）。 */
export interface MonitorConfigRow {
  recordId?: string;
  /** 关键词 | 竞品账号（引擎据此分流 run_keyword / run_account）。 */
  type: '关键词' | '竞品账号';
  /** 关键词文本 或 竞品账号名/主页链接。 */
  keyword: string;
  /** 主题分类（仅归类，引擎不读）。 */
  category?: string;
  /** 中文平台标签数组（MONITOR_PLATFORM_LABELS 的子集）。 */
  platforms: string[];
  priority?: string;
  /** 竞品账号监控用（1d/7d/30d/180d）。 */
  timeWindow?: string;
  /** 关键词监控用：最低点赞/热度门槛。 */
  minThreshold?: number;
  enabled: boolean;
  note?: string;
}

/** 系统配置表一行（引擎启动读，热更新阈值/频率/模型；配置项须匹配 config_sync._MAP）。 */
export interface SystemConfigRow {
  recordId?: string;
  item: string;
  value: string;
  unit?: string;
  enabled: boolean;
}

/** 系统配置项枚举（对应引擎 config_sync._MAP + 特例；界面下拉用）。 */
export const SYSTEM_CONFIG_ITEMS = [
  '低粉最低点赞', '低粉赞粉比', '低粉粉丝上限', '账号异常观察倍数', '账号异常A倍数',
  '账号异常S倍数', '关键词头部比例', '快速起量窗口', '检测频率', 'TopK', '默认模型.high',
] as const;

export interface MonitorConfigListResponse {
  rows: MonitorConfigRow[];
}
export interface SystemConfigListResponse {
  rows: SystemConfigRow[];
}
export interface MonitorConfigMutateResponse {
  ok: boolean;
  recordId?: string | null;
}
