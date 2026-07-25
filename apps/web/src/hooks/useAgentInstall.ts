// 本地 CLI 一键安装的共享状态机(设置「执行模式」和首次引导都用这一份)。
//
// 为什么抽出来:安装入口有两个——设置对话框(SettingsDialog)和首次引导页(EntryShell 的
// od://app/onboarding)。两处各写一份轮询/去重/自动装默认 CLI 的逻辑,必然走偏:2026-07-25
// 的 Windows 实测就撞上了——「首装无 CLI 自动装 Kimi」当时只写在 SettingsDialog 的 welcome
// 模式里,而那个模式的开关(settingsWelcome)从来没有被置过 true,等于死代码;真正的首次引导页
// 连一键安装按钮都没有,用户开箱看到的还是「请自行安装 …… 然后点重新扫描」。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  fetchAgentInstallJob,
  fetchAgentInstallSupport,
  startAgentInstall,
} from '../providers/registry';

export interface AgentInstallState {
  jobId: string;
  status: 'running' | 'done' | 'error';
  lastLine: string;
  detail: string | null;
}

/** 本地没有任何可用 CLI 时自动安装的默认 CLI(用户 2026-07-25 定稿:默认 Kimi)。 */
export const DEFAULT_AGENT_ID = 'kimi';

export interface UseAgentInstallOptions {
  /** 已检测到的 agents——用来判断「一个可用的都没有」。 */
  agents: Array<{ id: string; available: boolean }>;
  /** 检测是否还在进行中:没扫完就判空会误触发自动安装。 */
  agentsLoading: boolean;
  /** 开启后:检测完成且没有任何可用 CLI → 自动装默认的那个(整个组件生命周期只试一次)。 */
  autoInstallDefault?: boolean;
  /** 某个 CLI 装成功(且已被检测确认)后回调——通常用来重新拉 agents 列表、选中它。 */
  onInstalled?: (agentId: string) => void;
}

export function useAgentInstall(opts: UseAgentInstallOptions): {
  /** 当前平台支持一键安装的 agent id(服务端硬编码白名单)。 */
  support: string[];
  installs: Record<string, AgentInstallState>;
  begin: (agentId: string) => Promise<void>;
  /** 是否正在自动安装默认 CLI——首次引导要据此显示「正在为你安装…」而不是「没检测到」。 */
  autoInstalling: boolean;
} {
  const { agents, agentsLoading, autoInstallDefault = false, onInstalled } = opts;
  const [support, setSupport] = useState<string[]>([]);
  const [installs, setInstalls] = useState<Record<string, AgentInstallState>>({});
  const autoTriedRef = useRef(false);
  // onInstalled 每次渲染都是新函数,放进轮询 effect 的依赖会让定时器反复重建;用 ref 取最新的。
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  useEffect(() => {
    void fetchAgentInstallSupport().then((s) => { if (s) setSupport(s.ids); });
  }, []);

  const begin = useCallback(async (agentId: string) => {
    setInstalls((m) => ({ ...m, [agentId]: { jobId: '', status: 'running', lastLine: '', detail: null } }));
    const job = await startAgentInstall(agentId);
    if ('error' in job) {
      setInstalls((m) => ({ ...m, [agentId]: { jobId: '', status: 'error', lastLine: '', detail: job.error } }));
      return;
    }
    setInstalls((m) => ({
      ...m,
      [agentId]: { jobId: job.id, status: job.status, lastLine: job.lines[job.lines.length - 1] ?? '', detail: job.detail },
    }));
  }, []);

  // 轮询进行中的安装;装成(服务端已用 detectAgents 复检确认)后回调给调用方。
  useEffect(() => {
    const running = Object.entries(installs).filter(([, st]) => st.status === 'running' && st.jobId);
    if (running.length === 0) return;
    const timer = window.setInterval(() => {
      for (const [agentId, st] of running) {
        void fetchAgentInstallJob(st.jobId).then((job) => {
          if (!job) return;
          setInstalls((m) => {
            const prev = m[agentId];
            const lastLine = job.lines[job.lines.length - 1] ?? '';
            if (prev && prev.status === job.status && prev.lastLine === lastLine) return m;
            return { ...m, [agentId]: { jobId: job.id, status: job.status, lastLine, detail: job.detail } };
          });
          if (job.status === 'done') onInstalledRef.current?.(agentId);
        });
      }
    }, 1500);
    return () => window.clearInterval(timer);
  }, [installs]);

  // 检测完成且一个可用的都没有 → 自动装默认 CLI。只试一次:失败了让用户自己点重试,
  // 免得网络不通时无限重装。
  useEffect(() => {
    if (!autoInstallDefault || agentsLoading || autoTriedRef.current) return;
    if (agents.some((a) => a.available)) return;
    if (!support.includes(DEFAULT_AGENT_ID)) return;
    autoTriedRef.current = true;
    void begin(DEFAULT_AGENT_ID);
  }, [autoInstallDefault, agentsLoading, agents, support, begin]);

  return {
    support,
    installs,
    begin,
    autoInstalling: installs[DEFAULT_AGENT_ID]?.status === 'running' && autoTriedRef.current,
  };
}
