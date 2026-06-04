// Workflow-mode step rail.
//
// When the active plugin declares `od.workflow.stages`, this renders a
// horizontal rail of those stages above the composer and lights up progress
// derived from the agent's latest TodoWrite snapshot (see
// ./workflow/deriveProgress). It is the visible half of "workflow mode":
// the explicit graph (declared stages) + shared state (TodoWrite) made
// legible. Human gates themselves render through the existing
// AskUserQuestionCard in the chat log; this rail just shows where we are.

import { useMemo } from 'react';
import { resolveLocalizedText, type AppliedPluginSnapshot } from '@open-design/contracts';
import type { AgentEvent } from '../types';
import { useI18n } from '../i18n';
import { latestTodoWriteInputFromMessages, parseTodoWriteInput } from '../runtime/todos';
import { deriveWorkflowProgress } from './workflow/deriveProgress';
import { Icon } from './Icon';
import './WorkflowRail.css';

interface Props {
  snapshot: AppliedPluginSnapshot | null | undefined;
  messages: ReadonlyArray<{ events?: AgentEvent[] | undefined }> | undefined;
}

export function WorkflowRail({ snapshot, messages }: Props) {
  const { locale } = useI18n();
  const stages = snapshot?.workflow?.stages ?? [];

  const statuses = useMemo(() => {
    if (stages.length === 0) return [];
    const todos = parseTodoWriteInput(latestTodoWriteInputFromMessages(messages));
    return deriveWorkflowProgress(
      stages.map((s) => ({ id: s.id, title: s.title })),
      todos,
    );
  }, [stages, messages]);

  if (stages.length === 0) return null;

  return (
    <div className="workflow-rail" role="list" aria-label="Workflow stages" data-testid="workflow-rail">
      {stages.map((stage, i) => {
        const status = statuses[i] ?? 'pending';
        const title =
          resolveLocalizedText(stage.title_i18n, locale) || stage.title || stage.id;
        const gated = (stage.gate ?? 'none') === 'confirm' || (stage.gate ?? 'none') === 'choice';
        return (
          <div
            key={stage.id}
            role="listitem"
            className={`workflow-rail__step is-${status}`}
            data-stage-id={stage.id}
            aria-current={status === 'active' ? 'step' : undefined}
          >
            <span className="workflow-rail__dot" aria-hidden>
              {status === 'done' ? <Icon name="check" size={12} /> : i + 1}
            </span>
            <span className="workflow-rail__label">{title}</span>
            {gated ? (
              <span className="workflow-rail__gate" title="人工确认" aria-hidden>
                <Icon name="bell" size={11} />
              </span>
            ) : null}
            {i < stages.length - 1 ? <span className="workflow-rail__sep" aria-hidden /> : null}
          </div>
        );
      })}
    </div>
  );
}
