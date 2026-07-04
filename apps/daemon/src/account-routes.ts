// Platform-level self-media account routes (账号中心).
//
// Accounts belong to PLATFORMS, not plugins: the same 抖音号 must serve every
// plugin that targets 抖音 (the 抖音发布 entry, the 短视频工作流 matrix, …).
// Profiles live in app-config `platformAccounts[platformId][]`; legacy
// per-plugin rows (wechat-mp-publish) are merged in at read time by
// `platformAccountsForPlatform`. Credential VALUES never leave the daemon —
// views carry per-key presence flags only.
//
//   GET    /api/accounts                        — every platform's accounts
//   PUT    /api/accounts/:platform              — create/update one profile
//   DELETE /api/accounts/:platform/:accountId   — delete one profile

import type { Express } from 'express';
import {
  MEDIA_PLATFORMS,
  mediaPlatformDef,
  type AccountProfileView,
  type PlatformAccountsResponse,
  type UpsertAccountProfileResponse,
} from '@open-design/contracts';
import type { RouteDeps } from './server-context.js';
import {
  readAppConfig,
  writeAppConfig,
  validatePluginAccounts,
  platformAccountsForPlatform,
  type AppConfigPrefs,
  type PluginAccountRecord,
} from './app-config.js';
export interface RegisterAccountRoutesDeps extends RouteDeps<'http' | 'paths'> {}

// Whether saving an account under `name` would collide with a DIFFERENT
// existing profile. Names are the resolver's match key (see
// resolvePlatformAccountCredentials), so uniqueness is a hard rule — a
// duplicate name would make credential resolution ambiguous and could publish
// to the wrong account. Updating a profile keeps its own name without
// conflict.
export function accountNameConflicts(
  list: ReadonlyArray<{ id: string; name: string }>,
  name: string,
  excludeId: string | null,
): boolean {
  return list.some((a) => a.name === name && a.id !== excludeId);
}

// The credential keys an account on this platform may carry (from the central
// platform definition; empty for sau-login platforms).
export function platformCredentialKeys(platformId: string): string[] {
  return (mediaPlatformDef(platformId)?.credentialKeys ?? []).map((k) => k.name);
}

export function accountToView(rec: PluginAccountRecord, credentialKeys: string[]): AccountProfileView {
  const credentials: Record<string, boolean> = {};
  for (const key of credentialKeys) {
    const v = rec.credentials?.[key];
    credentials[key] = typeof v === 'string' && v.length > 0;
  }
  return { id: rec.id, name: rec.name, style: rec.style ?? {}, credentials };
}

function slugAccountId(name: string): string {
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/(^[-._]+|[-._]+$)/g, '');
  return base || 'account';
}

export type UpsertOutcome =
  | { ok: true; account: PluginAccountRecord }
  | { ok: false; status: number; code: string; message: string };

// Create/update one platform account. Shared by the platform routes AND the
// legacy per-plugin facade (plugin-edit-routes) so both surfaces write the
// SAME store with the SAME rules (unique names, declared credential keys only,
// blank credential = keep, empty persona/samples = clear).
export async function upsertPlatformAccount(
  dataDir: string,
  platformId: string,
  body: {
    id?: unknown;
    name?: unknown;
    style?: { persona?: unknown; samples?: unknown };
    credentials?: unknown;
  },
): Promise<UpsertOutcome> {
  if (!mediaPlatformDef(platformId)) {
    return { ok: false, status: 404, code: 'PLATFORM_UNKNOWN', message: `unknown platform "${platformId}"` };
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) return { ok: false, status: 400, code: 'BAD_REQUEST', message: 'name is required' };

  const credentialKeySet = new Set(platformCredentialKeys(platformId));
  const cfg = await readAppConfig(dataDir);
  const all = { ...(validatePluginAccounts(cfg.platformAccounts) ?? {}) };
  // Merge-view (incl. legacy rows) for conflict checks + update targets, so an
  // old wechat account can be edited in place and lands in the new store.
  const list = platformAccountsForPlatform(cfg, platformId);

  const wantedId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : '';
  if (accountNameConflicts(list, name, wantedId || null)) {
    return { ok: false, status: 400, code: 'ACCOUNT_NAME_TAKEN', message: `an account named "${name}" already exists on this platform` };
  }
  const idx = wantedId ? list.findIndex((a) => a.id === wantedId) : -1;
  let accountId = wantedId || slugAccountId(name);
  if (idx < 0) {
    let n = 2;
    const taken = new Set(list.map((a) => a.id));
    const baseId = accountId;
    while (taken.has(accountId)) accountId = `${baseId}-${n++}`;
  }

  const prev: PluginAccountRecord = idx >= 0 ? list[idx]! : { id: accountId, name };
  const nextCreds: Record<string, string> = { ...(prev.credentials ?? {}) };
  if (body.credentials && typeof body.credentials === 'object' && !Array.isArray(body.credentials)) {
    for (const [k, v] of Object.entries(body.credentials as Record<string, unknown>)) {
      if (!credentialKeySet.has(k) || typeof v !== 'string') continue;
      const trimmed = v.trim();
      if (trimmed) nextCreds[k] = trimmed;
      else delete nextCreds[k];
    }
  }
  const style: { persona?: string; samples?: string[] } = { ...(prev.style ?? {}) };
  if (body.style && typeof body.style === 'object') {
    if (typeof body.style.persona === 'string') {
      const p = body.style.persona.trim();
      if (p) style.persona = p; else delete style.persona;
    }
    if (Array.isArray(body.style.samples)) {
      const samples = body.style.samples.filter(
        (s): s is string => typeof s === 'string' && s.trim().length > 0,
      );
      if (samples.length > 0) style.samples = samples; else delete style.samples;
    }
  }

  const rec: PluginAccountRecord = { id: accountId, name };
  if (Object.keys(style).length > 0) rec.style = style;
  if (Object.keys(nextCreds).length > 0) rec.credentials = nextCreds;

  // Writing rewrites the platform's full (merged) list into the NEW store —
  // this is also the lazy migration moment for legacy per-plugin rows.
  const nextList = [...list.filter((a) => a.id !== accountId)];
  if (idx >= 0) nextList.splice(idx, 0, rec); else nextList.push(rec);
  all[platformId] = nextList;
  await writeAppConfig(dataDir, { platformAccounts: all });
  return { ok: true, account: rec };
}

export async function deletePlatformAccount(
  dataDir: string,
  platformId: string,
  accountId: string,
): Promise<void> {
  const cfg = await readAppConfig(dataDir);
  const all = { ...(validatePluginAccounts(cfg.platformAccounts) ?? {}) };
  // Persist the merged view minus the target so a delete also "migrates" any
  // remaining legacy rows into the new store (and the legacy row can't
  // resurrect the deleted account through the read-time merge).
  const remaining = platformAccountsForPlatform(cfg, platformId).filter((a) => a.id !== accountId);
  if (remaining.length > 0) all[platformId] = remaining;
  else delete all[platformId];
  const legacy = { ...(validatePluginAccounts(cfg.pluginAccounts) ?? {}) };
  let legacyChanged = false;
  for (const [pluginId, list] of Object.entries(legacy)) {
    const filtered = list.filter((a) => a.id !== accountId);
    if (filtered.length !== list.length) {
      legacyChanged = true;
      if (filtered.length > 0) legacy[pluginId] = filtered;
      else delete legacy[pluginId];
    }
  }
  await writeAppConfig(dataDir, {
    platformAccounts: all,
    ...(legacyChanged ? { pluginAccounts: legacy } : {}),
  });
}

export function listPlatformAccounts(prefs: AppConfigPrefs): PlatformAccountsResponse {
  return {
    platforms: MEDIA_PLATFORMS.map((p) => ({
      id: p.id,
      accounts: platformAccountsForPlatform(prefs, p.id).map((a) =>
        accountToView(a, platformCredentialKeys(p.id)),
      ),
    })),
  };
}

export function registerAccountRoutes(app: Express, ctx: RegisterAccountRoutesDeps) {
  const { sendApiError } = ctx.http;
  const { RUNTIME_DATA_DIR } = ctx.paths;

  app.get('/api/accounts', async (_req, res) => {
    try {
      const cfg = await readAppConfig(RUNTIME_DATA_DIR);
      res.json(listPlatformAccounts(cfg));
    } catch (err) {
      sendApiError(res, 500, 'ACCOUNTS_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.put('/api/accounts/:platform', async (req, res) => {
    try {
      const platformId = req.params.platform;
      const outcome = await upsertPlatformAccount(
        RUNTIME_DATA_DIR,
        platformId,
        (req.body ?? {}) as Parameters<typeof upsertPlatformAccount>[2],
      );
      if (!outcome.ok) return sendApiError(res, outcome.status, outcome.code, outcome.message);
      const response: UpsertAccountProfileResponse = {
        id: platformId,
        saved: true,
        account: accountToView(outcome.account, platformCredentialKeys(platformId)),
      };
      res.json(response);
    } catch (err) {
      sendApiError(res, 500, 'ACCOUNT_SAVE_FAILED', String((err as Error)?.message ?? err));
    }
  });

  app.delete('/api/accounts/:platform/:accountId', async (req, res) => {
    try {
      await deletePlatformAccount(RUNTIME_DATA_DIR, req.params.platform, req.params.accountId);
      res.json({ id: req.params.platform, deleted: true });
    } catch (err) {
      sendApiError(res, 500, 'ACCOUNT_DELETE_FAILED', String((err as Error)?.message ?? err));
    }
  });
}
