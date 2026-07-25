// 本地 CLI 一键安装(设置执行模式 / 首次引导自动装默认 Kimi)。
// daemon 侧按【服务端硬编码白名单】执行官方安装脚本;客户端只传 agentId、轮询任务进度。

export interface AgentInstallJob {
  id: string;
  agentId: string;
  status: 'running' | 'done' | 'error';
  /** 安装脚本 stdout/stderr 的裁剪行(尾部 ≤200 行,每行 ≤300 字符)。 */
  lines: string[];
  detail: string | null;
  startedAt: number;
}

/** GET /api/agents/install-support — 当前平台支持一键安装的 agent id 列表。 */
export interface AgentInstallSupportResponse {
  ids: string[];
  platform: string;
}

/** POST /api/agents/:agentId/install 与 GET /api/agents/install-jobs/:id 的响应。 */
export interface AgentInstallJobResponse {
  job: AgentInstallJob;
}
