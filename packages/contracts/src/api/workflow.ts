// Workflow mode — runtime progress contract.
//
// The plugin manifest declares the explicit stage graph (see
// `WorkflowStage` / `PluginWorkflow` in `../plugins/manifest.ts`). This
// module carries the *runtime* shapes the web step rail and the CLI read
// to render progress. v1 derives progress from the agent's latest
// TodoWrite snapshot (no new daemon table), so these stay pure types.

import type { WorkflowStage } from '../plugins/manifest.js';

export type WorkflowStageStatus = 'pending' | 'active' | 'done';

// One row in the rendered step rail: the declared stage plus its derived
// runtime status.
export interface WorkflowStageProgress {
  /** Matches `WorkflowStage.id`. */
  stageId: string;
  status: WorkflowStageStatus;
}

export interface WorkflowProgress {
  stages: WorkflowStageProgress[];
  /** Index into `stages` of the first non-done stage, or `stages.length` when complete. */
  activeIndex: number;
}

// CLI / API shape for `od workflow stages <pluginId>`.
export interface WorkflowStagesResponse {
  pluginId: string;
  stages: WorkflowStage[];
}

export type { WorkflowStage } from '../plugins/manifest.js';
