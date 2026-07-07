// 创作台 AI 任务折叠实时面板 — 复用既有 run 机制（streamViaDaemon →
// POST /api/runs + SSE + cancel），以浓缩视图展示 agent 实时动作：
// 工具调用一行一条、正文文字滚动最后几行、可随时中止。任务结束回调
// onFinished 让创作台刷新数据（agent 通过 od studio CLI 已把产物落库）。
import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';
import type { AgentEvent, ChatMessage } from '../../types';
import { Icon } from '../Icon';
import { loadConfig } from '../../state/config';
import { streamViaDaemon } from '../../providers/daemon';
import { saveMessage } from '../../state/projects';
import styles from './MediaStudio.module.css';

const c = (key: string): string => (styles as Record<string, string | undefined>)[key] ?? '';

export interface StudioAiTask {
  projectId: string;
  conversationId: string;
  prompt: string;
  title: string;
  /** Monotonic id so re-triggering the same task restarts the panel. */
  seq: number;
}

export type StudioAiOutcome = 'done' | 'error' | 'stopped';

interface Props {
  task: StudioAiTask | null;
  /** Fires after the run ends — refresh store-backed data; outcome drives the toast. */
  onFinished: (outcome: StudioAiOutcome) => void;
  onDismiss: () => void;
  /** Mirrors running state up so the View can render a cross-tab global bar. */
  onRunningChange?: (running: boolean) => void;
  /** 提示词约定 agent 输出「【进度】…」标记行——解析后上报给全局状态条。 */
  onStageChange?: (stage: string) => void;
}

export interface StudioAiPanelHandle {
  cancel: () => void;
}

type PanelStatus = 'running' | 'done' | 'error' | 'stopped';

function describeEvent(ev: AgentEvent): string | null {
  if (ev.kind === 'tool_use') {
    const input = ev.input as Record<string, unknown> | null;
    const cmd = typeof input?.command === 'string' ? input.command : '';
    if (ev.name.toLowerCase() === 'bash' && cmd) return `$ ${cmd.slice(0, 120)}`;
    return `⚙ ${ev.name}`;
  }
  if (ev.kind === 'status' && ev.label) return `· ${ev.label}${ev.detail ? ` ${ev.detail.slice(0, 80)}` : ''}`;
  return null;
}

export const StudioAiPanel = forwardRef<StudioAiPanelHandle, Props>(function StudioAiPanel(
  { task, onFinished, onDismiss, onRunningChange, onStageChange }: Props,
  ref,
): JSX.Element | null {
  const [expanded, setExpanded] = useState(true);
  const [status, setStatus] = useState<PanelStatus>('running');
  const [lines, setLines] = useState<string[]>([]);
  const [tail, setTail] = useState('');
  const cancelRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement | null>(null);
  const statusRef = useRef<PanelStatus>('running');

  const markStatus = (next: PanelStatus | ((s: PanelStatus) => PanelStatus)): void => {
    setStatus((prev) => {
      const value = typeof next === 'function' ? next(prev) : next;
      statusRef.current = value;
      return value;
    });
  };

  const cancelRun = (): void => {
    cancelRef.current?.abort();
    markStatus('stopped');
  };

  useImperativeHandle(ref, () => ({ cancel: cancelRun }));

  useEffect(() => {
    onRunningChange?.(task != null && status === 'running');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.seq, status]);

  useEffect(() => {
    if (!task) return;
    markStatus('running');
    setLines([]);
    setTail('');
    setExpanded(true);
    onStageChange?.('');
    const abort = new AbortController();
    const cancel = new AbortController();
    cancelRef.current = cancel;
    let text = '';
    const push = (line: string) => setLines((prev) => [...prev.slice(-60), line]);

    const cfg = loadConfig();
    // 持久化过程：用户提示词 + 助手占位消息先落库，daemon 在 run 结束时把
    // 完整产出（文本+事件）写进占位——中断/刷新后到「公众号创作台」项目里
    // 都能回看，不再死无对证。
    const userMessage: ChatMessage = {
      id: `studio-user-${task.seq}-${Date.now()}`,
      role: 'user',
      content: task.prompt,
      createdAt: Date.now(),
    };
    const assistantMessage: ChatMessage = {
      id: `studio-assistant-${task.seq}-${Date.now()}`,
      role: 'assistant',
      content: '',
      createdAt: Date.now(),
    };
    void saveMessage(task.projectId, task.conversationId, userMessage);
    void saveMessage(task.projectId, task.conversationId, assistantMessage);
    void streamViaDaemon({
      agentId: cfg.agentId || '',
      history: [
        {
          id: userMessage.id,
          role: 'user',
          content: task.prompt,
        },
      ],
      signal: abort.signal,
      cancelSignal: cancel.signal,
      projectId: task.projectId,
      conversationId: task.conversationId,
      assistantMessageId: assistantMessage.id,
      // 创作台任务无人值守：CLI 层直接禁掉提问工具，模型物理上没法停下来问。
      disallowedTools: ['AskUserQuestion'],
      locale: 'zh-CN',
      handlers: {
        onDelta: (chunk) => {
          text += chunk;
          setTail(text.slice(-400));
          // 阶段标记：取文本流里最后一个「【进度】…」行上报。
          const stages = text.match(/【进度】[^\n【]{1,60}/g);
          if (stages && stages.length > 0) {
            onStageChange?.(stages[stages.length - 1]!.replace('【进度】', '').trim());
          }
        },
        onDone: () => {
          const wasStopped = statusRef.current === 'stopped';
          markStatus((s) => (s === 'stopped' ? s : 'done'));
          onFinished(wasStopped ? 'stopped' : 'done');
        },
        onError: (err) => {
          const wasStopped = statusRef.current === 'stopped';
          markStatus((s) => (s === 'stopped' ? s : 'error'));
          push(`✗ ${err.message}`);
          onFinished(wasStopped ? 'stopped' : 'error');
        },
        onAgentEvent: (ev) => {
          const line = describeEvent(ev);
          if (line) push(line);
        },
      },
    });
    return () => {
      abort.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.seq]);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines, tail]);

  if (!task) return null;

  const statusText =
    status === 'running' ? '执行中…' : status === 'done' ? '已完成' : status === 'stopped' ? '已中止' : '出错了';

  return (
    <div className={c('aiPanel')} data-testid="studio-ai-panel">
      {/* 头部是 div 而不是 button：里面还有「中止/收起」真按钮，button 不能嵌 button */}
      <div
        className={c('aiPanelHead')}
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') setExpanded((v) => !v);
        }}
      >
        <span className={`${c('aiDot')} ${status === 'running' ? c('aiDotLive') : status === 'done' ? c('aiDotOk') : c('aiDotErr')}`} />
        <strong>{task.title}</strong>
        <span className={c('aiStatus')}>{statusText}</span>
        <span className={c('headSpacer')} />
        {status === 'running' ? (
          <button
            type="button"
            className={`${c('btn')} ${c('btnDanger')}`}
            onClick={(e) => {
              e.stopPropagation();
              cancelRun();
            }}
          >
            中止
          </button>
        ) : (
          <button
            type="button"
            className={c('btn')}
            onClick={(e) => {
              e.stopPropagation();
              onDismiss();
            }}
          >
            收起
          </button>
        )}
        <Icon name={expanded ? 'chevron-down' : 'chevron-right'} size={14} />
      </div>
      {expanded ? (
        <div className={c('aiPanelBody')} ref={logRef}>
          {lines.map((line, i) => (
            <div key={`${i}-${line.slice(0, 24)}`} className={c('aiLine')}>
              {line}
            </div>
          ))}
          {tail ? <div className={c('aiTail')}>{tail}</div> : null}
          {lines.length === 0 && !tail ? <div className={c('aiLine')}>正在启动智能体…</div> : null}
        </div>
      ) : null}
    </div>
  );
});
