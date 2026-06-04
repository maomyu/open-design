// Pure mapping from declared workflow stages + the agent's latest TodoWrite
// snapshot to a per-stage runtime status, for the WorkflowRail step rail.
//
// The agent is told (plugin-block "Workflow protocol" + the plugin SKILL.md)
// to seed TodoWrite with one todo per declared stage, using the stage title
// as the todo content. Real agents drift, so the match is tolerant: exact /
// trimmed / either-direction-substring on title OR id, then a positional
// fallback when todo and stage counts line up. If nothing matches, every
// stage is `pending` (the rail still renders, just unhighlighted).

import type { TodoItem } from '../../runtime/todos';

export type DerivedStageStatus = 'pending' | 'active' | 'done';

export interface WorkflowStageLike {
  id: string;
  title?: string | undefined;
}

function norm(value: string | undefined): string {
  return (value ?? '').trim().toLowerCase();
}

function todoMatchesStage(todoContent: string, stage: WorkflowStageLike): boolean {
  const c = norm(todoContent);
  if (!c) return false;
  for (const key of [stage.title, stage.id]) {
    const k = norm(key);
    if (!k) continue;
    if (c === k || c.includes(k) || k.includes(c)) return true;
  }
  return false;
}

function statusFromTodo(status: TodoItem['status']): DerivedStageStatus {
  if (status === 'completed') return 'done';
  if (status === 'in_progress' || status === 'stopped') return 'active';
  return 'pending';
}

export function deriveWorkflowProgress(
  stages: ReadonlyArray<WorkflowStageLike>,
  todos: ReadonlyArray<TodoItem>,
): DerivedStageStatus[] {
  const result: DerivedStageStatus[] = stages.map(() => 'pending');
  if (stages.length === 0) return result;

  let matchedAny = false;
  stages.forEach((stage, i) => {
    const todo = todos.find((t) => todoMatchesStage(t.content, stage));
    if (todo) {
      matchedAny = true;
      result[i] = statusFromTodo(todo.status);
    }
  });

  // Positional fallback: the agent wrote todos but with wording the matcher
  // could not align, and the counts line up. Trust the order.
  if (!matchedAny && todos.length === stages.length) {
    todos.forEach((todo, i) => {
      result[i] = statusFromTodo(todo.status);
    });
    matchedAny = todos.length > 0;
  }

  // Ensure the rail always shows a current step: if nothing is explicitly
  // active but progress has started, mark the first pending stage after the
  // last done stage as active.
  if (matchedAny && !result.includes('active')) {
    const firstPending = result.indexOf('pending');
    if (firstPending !== -1 && result.slice(0, firstPending).some((s) => s === 'done')) {
      result[firstPending] = 'active';
    }
  }

  return result;
}
