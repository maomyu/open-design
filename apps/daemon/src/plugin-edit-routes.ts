import path from 'node:path';
import { promises as fsp } from 'node:fs';
import type { Express } from 'express';
import { resolveLocalizedText } from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import {
  getInstalledPlugin,
  resolvePluginFolder,
  upsertInstalledPlugin,
} from './plugins/registry.js';

export interface RegisterPluginEditRoutesDeps extends RouteDeps<'db' | 'http'> {}

/**
 * Direct plugin editing. The plugin IS the asset: its prompts are files
 * (SKILL.md body + the kickoff query in open-design.json). The operator edits
 * them in place, then we re-register the folder so the next run picks up the
 * change ("发布"). SKILL.md is read fresh at prompt-compose time, so its edits
 * are live immediately; manifest edits (query/workflow) need the re-register.
 *
 *   GET /api/plugins/:id/source  — read the editable prompts
 *   PUT /api/plugins/:id/source  — write + re-register
 */
export function registerPluginEditRoutes(app: Express, ctx: RegisterPluginEditRoutesDeps) {
  const { db } = ctx;
  const { sendApiError } = ctx.http;

  app.get('/api/plugins/:id/source', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id);
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const fsPath = (plugin as { fsPath: string }).fsPath;
      let skill = '';
      try {
        skill = await fsp.readFile(path.join(fsPath, 'SKILL.md'), 'utf8');
      } catch {
        skill = '';
      }
      const q = (plugin as { manifest?: { od?: { useCase?: { query?: unknown } } } })
        .manifest?.od?.useCase?.query;
      const query =
        resolveLocalizedText(q as never, 'zh-CN') || (typeof q === 'string' ? q : '');
      const sourceKind = (plugin as { sourceKind?: string }).sourceKind;
      const editable = sourceKind === 'bundled' || sourceKind === 'user';
      res.json({ id, skill, query, editable });
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_SOURCE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.put('/api/plugins/:id/source', async (req, res) => {
    try {
      const id = req.params.id;
      const plugin = getInstalledPlugin(db, id) as
        | { fsPath: string; sourceKind: string; source: string; trust: string }
        | null;
      if (!plugin) return sendApiError(res, 404, 'PLUGIN_NOT_FOUND', 'plugin not found');
      const fsPath = plugin.fsPath;
      const body = (req.body ?? {}) as { skill?: unknown; query?: unknown };

      if (typeof body.skill === 'string') {
        await fsp.writeFile(path.join(fsPath, 'SKILL.md'), body.skill, 'utf8');
      }

      if (typeof body.query === 'string') {
        const manifestPath = path.join(fsPath, 'open-design.json');
        const raw = await fsp.readFile(manifestPath, 'utf8');
        const json = JSON.parse(raw) as {
          od?: { useCase?: { query?: unknown } };
        };
        json.od = json.od ?? {};
        json.od.useCase = json.od.useCase ?? {};
        const existing = json.od.useCase.query;
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
          // Keep the localized map; update the operator's locale (zh-CN).
          (existing as Record<string, string>)['zh-CN'] = body.query;
        } else {
          json.od.useCase.query = body.query;
        }
        await fsp.writeFile(manifestPath, JSON.stringify(json, null, 2) + '\n', 'utf8');
      }

      // Re-register the folder so the edited manifest goes live.
      const resolved = await resolvePluginFolder({
        folder: fsPath,
        folderId: id,
        sourceKind: plugin.sourceKind as never,
        source: plugin.source,
        trust: plugin.trust as never,
      });
      if (!resolved.ok) {
        return sendApiError(res, 400, 'PLUGIN_REPARSE_FAILED', resolved.errors.join('; '));
      }
      upsertInstalledPlugin(db, resolved.record);
      res.json({ id, published: true });
    } catch (err) {
      sendApiError(res, 500, 'PLUGIN_SOURCE_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
