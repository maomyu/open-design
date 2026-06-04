// Self-improving agent loop ("调教").
//
// The product principle: users are good at JUDGING outputs ("this copy
// isn't punchy enough") and bad at WRITING prompts. So instead of asking
// them to edit the prompt, we capture their reaction to OUTPUTS and turn
// it into durable memory that the existing memory injection feeds back
// into every future run.
//
// Three mechanisms, one store (the daemon memory system):
//   1. Feedback → preference    (this file's LearningFeedbackRequest)
//   2. Approved output → sample (LearningSampleRequest)
//   3. Sedimentation/recall     (reuses composeMemoryBody injection)

// A short, human label identifying which agent/workflow the learning is
// about (e.g. a plugin id or title). Used to scope the memory entry's name
// so different agents' preferences read apart. Optional — global when absent.
export type LearningContext = string;

// Curated, content-oriented reason chips the UI offers. The daemon maps each
// known reason to concrete guidance (the expertise the user lacks); unknown
// strings pass through verbatim. `rating` lets a positive reaction reinforce
// the current style instead of changing it.
export interface LearningFeedbackRequest {
  /** Which agent/workflow this is about (plugin id / title). */
  context?: LearningContext;
  /** The output the user is reacting to (optional — improves the recorded note). */
  targetText?: string;
  /** Selected reason chips (e.g. "不够吸引人", "太长了"). */
  reasons: string[];
  /** Free-text refinement the user typed (optional). */
  note?: string;
  /** Overall direction. 'bad' adjusts; 'good' reinforces. */
  rating: 'good' | 'bad';
}

export interface LearningFeedbackResponse {
  /** The memory entry id that was written/updated. */
  memoryId: string;
  /** The preference line(s) that will now be injected into future runs. */
  preference: string;
}

// Remember a concrete good output as a few-shot style sample.
export interface LearningSampleRequest {
  context?: LearningContext;
  /** Short label for the sample (e.g. the topic / title). */
  title?: string;
  /** The output text to remember as a style exemplar. */
  content: string;
}

export interface LearningSampleResponse {
  memoryId: string;
}

// What the agent has learned so far for a context — for the UI "已学到" panel
// and the `od learning list` command.
export interface LearningItem {
  memoryId: string;
  kind: 'preference' | 'sample';
  name: string;
  description: string;
  updatedAt: number;
}

export interface LearningListResponse {
  context?: LearningContext;
  items: LearningItem[];
}
