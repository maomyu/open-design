import type { Express } from 'express';
import type { RouteDeps } from './server-context.js';
import {
  recordLearningFeedback,
  recordLearningSample,
  listLearning,
} from './learning.js';

export interface RegisterLearningRoutesDeps extends RouteDeps<'http' | 'paths'> {}

/**
 * Self-improving agent loop ("调教"). Turns a user's reaction to an OUTPUT
 * into durable memory the existing memory injection feeds back into future
 * runs. See apps/daemon/src/learning.ts and the contract for rationale.
 *
 *   POST /api/learning/feedback  — mechanism 1 (reaction → preference memory)
 *   POST /api/learning/sample    — mechanism 2 (approved output → style sample)
 *   GET  /api/learning           — what the agent has learned (per context)
 */
export function registerLearningRoutes(app: Express, ctx: RegisterLearningRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.post('/api/learning/feedback', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (body.rating !== 'good' && body.rating !== 'bad') {
        return sendApiError(res, 400, 'BAD_REQUEST', 'rating must be "good" or "bad"');
      }
      const out = await recordLearningFeedback(RUNTIME_DATA_DIR, {
        ...(typeof body.context === 'string' ? { context: body.context } : {}),
        ...(typeof body.targetText === 'string' ? { targetText: body.targetText } : {}),
        reasons: Array.isArray(body.reasons)
          ? body.reasons.filter((r): r is string => typeof r === 'string')
          : [],
        ...(typeof body.note === 'string' ? { note: body.note } : {}),
        rating: body.rating,
      });
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'LEARNING_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.post('/api/learning/sample', async (req, res) => {
    try {
      const body = (req.body ?? {}) as Record<string, unknown>;
      if (typeof body.content !== 'string' || body.content.trim().length === 0) {
        return sendApiError(res, 400, 'BAD_REQUEST', 'content is required');
      }
      const out = await recordLearningSample(RUNTIME_DATA_DIR, {
        ...(typeof body.context === 'string' ? { context: body.context } : {}),
        ...(typeof body.title === 'string' ? { title: body.title } : {}),
        content: body.content,
      });
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'LEARNING_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.get('/api/learning', async (req, res) => {
    try {
      const context = typeof req.query.context === 'string' ? req.query.context : undefined;
      const out = await listLearning(RUNTIME_DATA_DIR, context);
      res.json(out);
    } catch (err) {
      sendApiError(res, 500, 'LEARNING_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
