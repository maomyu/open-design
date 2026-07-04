// Account profiles — a plugin (e.g. 公众号发布) drives several named accounts,
// each with its own credentials + writing persona. These specs pin the
// DETERMINISTIC credential chain approved in the 2026-07-04 design doc
// (公众号多账号凭证 — 确定性调用与单一事实源): which account's AppID/Secret a
// run uses is decided mechanically by the daemon from the chosen account —
// never by the model — and per-account credential keys have exactly ONE
// legitimate source (the account profile; plugin-level config and the
// workbench .env are stripped).

import { describe, expect, it } from 'vitest';

import {
  validatePluginAccounts,
  resolvePlatformAccountCredentials,
  platformAccountsForPlatform,
  applyExclusiveCredentialRule,
  accountCredentialKeysFromManifest,
  accountPlatformFromManifest,
  type AppConfigPrefs,
} from '../src/app-config.js';
import { renderAccountRosterBlock } from '../src/plugins/stage-prompts.js';
import { accountNameConflicts } from '../src/plugin-edit-routes.js';
import { hydrateDynamicInputOptions } from '../src/plugins/apply.js';

const CRED_KEYS = ['WECHAT_APPID', 'WECHAT_SECRET', 'WECHAT_AUTHOR'];

const PREFS: AppConfigPrefs = {
  platformAccounts: {
    'wechat-mp': [
      { id: 'bao-kao', name: '报考日记', credentials: { WECHAT_APPID: 'appid1', WECHAT_SECRET: 's1' } },
      { id: 'kao-yan', name: '考研日记', credentials: { WECHAT_APPID: 'appid2', WECHAT_SECRET: 's2', WECHAT_AUTHOR: '小王' } },
    ],
  },
};

describe('validatePluginAccounts', () => {
  it('keeps well-formed profiles and drops malformed ones', () => {
    const out = validatePluginAccounts({
      'wechat-mp-publish': [
        { id: 'main', name: '报考日记', style: { persona: '口语化', samples: ['一', ''] }, credentials: { WECHAT_APPID: 'x' } },
        { id: '', name: 'no-id' },          // dropped: bad id
        { id: 'dup', name: '' },            // dropped: no name
        { id: 'main', name: 'dup-id' },     // dropped: duplicate id
      ],
      __proto__: [{ id: 'evil', name: 'evil' }], // prototype-pollution guard
    });
    expect(out).toBeTruthy();
    const list = out!['wechat-mp-publish']!;
    expect(list.map((a) => a.id)).toEqual(['main']);
    expect(list[0]!.style?.samples).toEqual(['一']); // blank sample filtered
    expect((out as Record<string, unknown>).evil).toBeUndefined();
  });
});

describe('resolvePlatformAccountCredentials (deterministic chooser)', () => {
  it('spec ①: a chosen account resolves to ITS values under standard key names', () => {
    const env = resolvePlatformAccountCredentials(PREFS, 'wechat-mp', '报考日记', CRED_KEYS);
    expect(env).toEqual({ WECHAT_APPID: 'appid1', WECHAT_SECRET: 's1' });
    // No suffixed variants exist anymore — the model has nothing to splice.
    expect(Object.keys(env).some((k) => k.includes('__'))).toBe(false);
  });

  it('spec ②: no account chosen + multiple configured → resolves NOTHING', () => {
    expect(resolvePlatformAccountCredentials(PREFS, 'wechat-mp', null, CRED_KEYS)).toEqual({});
    expect(resolvePlatformAccountCredentials(PREFS, 'wechat-mp', '', CRED_KEYS)).toEqual({});
  });

  it('single configured account is used when none was chosen (auto-default)', () => {
    const single: AppConfigPrefs = {
      platformAccounts: { p: [{ id: 'only', name: '唯一号', credentials: { WECHAT_APPID: 'a' } }] },
    };
    expect(resolvePlatformAccountCredentials(single, 'p', null, CRED_KEYS)).toEqual({ WECHAT_APPID: 'a' });
  });

  it('spec ④: an unknown or ambiguous account name resolves NOTHING (never guess)', () => {
    expect(resolvePlatformAccountCredentials(PREFS, 'wechat-mp', '不存在的号', CRED_KEYS)).toEqual({});
    // Legacy duplicate-name data (bypassed the save gate) is ambiguous → refuse.
    const dup: AppConfigPrefs = {
      platformAccounts: { p: [
        { id: 'a1', name: '同名', credentials: { WECHAT_APPID: '1' } },
        { id: 'a2', name: '同名', credentials: { WECHAT_APPID: '2' } },
      ] },
    };
    expect(resolvePlatformAccountCredentials(dup, 'p', '同名', CRED_KEYS)).toEqual({});
  });

  it('spec ⑤: an account missing a key injects only what it has — no fallback', () => {
    const env = resolvePlatformAccountCredentials(PREFS, 'wechat-mp', '报考日记', CRED_KEYS);
    expect(env.WECHAT_AUTHOR).toBeUndefined(); // absent, not '' and not a default
  });
});

describe('applyExclusiveCredentialRule (spec ③: strip every non-account source)', () => {
  it('removes plugin-level/.env values for credential keys, then lays in the account values', () => {
    const merged = {
      WECHAT_APPID: 'from-plugin-config',   // editor plugin-level value
      WECHAT_SECRET: 'from-workbench-env',  // .env fallback value
      DAJIALA_API_KEY: 'stays',             // non-credential key — untouched
    };
    const out = applyExclusiveCredentialRule(merged, CRED_KEYS, { WECHAT_APPID: 'appid1' });
    expect(out.WECHAT_APPID).toBe('appid1');
    expect('WECHAT_SECRET' in out).toBe(false); // stripped, NOT left over
    expect(out.DAJIALA_API_KEY).toBe('stays');
  });

  it('with no resolvable account the credential keys are ABSENT from the env', () => {
    const out = applyExclusiveCredentialRule(
      { WECHAT_APPID: 'x', WECHAT_SECRET: 'y', OTHER: 'z' },
      CRED_KEYS,
      {},
    );
    expect('WECHAT_APPID' in out).toBe(false);
    expect('WECHAT_SECRET' in out).toBe(false);
    expect(out.OTHER).toBe('z');
  });
});

describe('accountCredentialKeysFromManifest', () => {
  it('reads od.accounts.credentialKeys, deduped; empty when undeclared', () => {
    expect(accountCredentialKeysFromManifest({
      od: { accounts: { credentialKeys: ['WECHAT_APPID', 'WECHAT_APPID', 'WECHAT_SECRET'] } },
    })).toEqual(['WECHAT_APPID', 'WECHAT_SECRET']);
    expect(accountCredentialKeysFromManifest({ od: {} })).toEqual([]);
  });
});

describe('accountNameConflicts (spec ④ save gate)', () => {
  const list = [
    { id: 'a1', name: '报考日记' },
    { id: 'a2', name: '考研日记' },
  ];
  it('rejects a new account reusing an existing name', () => {
    expect(accountNameConflicts(list, '报考日记', null)).toBe(true);
  });
  it('lets an account keep its own name on update, but not steal another', () => {
    expect(accountNameConflicts(list, '报考日记', 'a1')).toBe(false);
    expect(accountNameConflicts(list, '考研日记', 'a1')).toBe(true);
  });
  it('allows a fresh name', () => {
    expect(accountNameConflicts(list, '新号', null)).toBe(false);
  });
});

describe('renderAccountRosterBlock', () => {
  const manifest = { od: { accounts: { credentialKeys: ['WECHAT_APPID', 'WECHAT_SECRET'] } } };

  it('returns empty for plugins without account support', () => {
    expect(renderAccountRosterBlock({ od: {} }, [])).toBe('');
  });

  it('prompts to create an account when none configured', () => {
    const block = renderAccountRosterBlock(manifest, []);
    expect(block).toContain('账号（前置）');
    expect(block).toContain('先建一个账号');
  });

  it('lists persona/samples and declares creds as system-injected (no env mechanics)', () => {
    const block = renderAccountRosterBlock(manifest, [
      { id: 'bao-kao', name: '报考日记', style: { persona: '口语化亲切', samples: ['范文正文……'] } },
    ]);
    expect(block).toContain('第 0 步必须先定');
    expect(block).toContain('绝不复问'); // input-first: composer pick is never re-asked
    expect(block).toContain('账号「报考日记」');
    expect(block).toContain('口语化亲切');
    expect(block).toContain('范文正文……');
    // Credential delivery is the daemon's job now — the model gets no env-var
    // splicing instructions and no suffixed variable names.
    expect(block).toContain('自动注入');
    expect(block).not.toContain('__');
    expect(block).toContain('AskUserQuestion');
  });
});

describe('hydrateDynamicInputOptions', () => {
  it('fills optionsFrom:"accounts" selects and REQUIRES a pick with 2+ accounts (spec ⑥)', () => {
    const fields = [
      { name: 'account', type: 'select' as const, optionsFrom: 'accounts' as const },
      { name: 'skin', type: 'select' as const, options: ['kaiti'] },
    ];
    const out = hydrateDynamicInputOptions(fields, ['报考日记', '考研日记']);
    expect(out[0]!.options).toEqual(['报考日记', '考研日记']);
    expect(out[0]!.required).toBe(true); // validateInputs enforces this server-side → 422
    expect(out[0]!.default).toBeUndefined();
    expect(out[1]).toBe(fields[1]); // static fields pass through untouched
  });

  it('defaults the field when exactly one account exists; empty+optional when none', () => {
    const field = { name: 'account', type: 'select' as const, optionsFrom: 'accounts' as const };
    expect(hydrateDynamicInputOptions([field], ['报考日记'])[0]).toMatchObject({
      options: ['报考日记'],
      default: '报考日记',
    });
    const none = hydrateDynamicInputOptions([field], undefined)[0]!;
    expect(none.options).toEqual([]);
    expect(none.required).not.toBe(true);
  });
});

// End-to-end composition against the REAL bundled wechat manifest — the exact
// three calls the run-spawn site (server.ts) makes. Proves "调用时按选定账号的
// 配置读": the final env's WECHAT_* keys come from the chosen account profile,
// while plugin-level config and workbench .env contributions are stripped.
describe('run-spawn credential composition (real wechat manifest)', () => {
  it('reads the chosen account values and strips every other source', async () => {
    const { readFile } = await import('node:fs/promises');
    const manifest = JSON.parse(await readFile(
      new URL('../../../plugins/_official/content/wechat-mp-publish/open-design.json', import.meta.url),
      'utf8',
    )) as unknown;

    const credKeys = accountCredentialKeysFromManifest(manifest);
    expect(credKeys).toEqual(['WECHAT_APPID', 'WECHAT_SECRET', 'WECHAT_AUTHOR']);

    // What the spawn site merges BEFORE the exclusive rule: workbench .env
    // leftovers + editor plugin-level values + unrelated API keys.
    const merged = {
      WECHAT_APPID: 'stale-env-appid',
      WECHAT_SECRET: 'plugin-level-secret',
      DAJIALA_API_KEY: 'dajiala-ok',
    };
    const env = applyExclusiveCredentialRule(
      merged,
      credKeys,
      resolvePlatformAccountCredentials(PREFS, 'wechat-mp', '考研日记', credKeys),
    );
    // The chosen account's own values — and ONLY those — win.
    expect(env.WECHAT_APPID).toBe('appid2');
    expect(env.WECHAT_SECRET).toBe('s2');
    expect(env.WECHAT_AUTHOR).toBe('小王');
    // Non-credential keys pass through untouched.
    expect(env.DAJIALA_API_KEY).toBe('dajiala-ok');
    // Nothing suffixed, nothing stale.
    expect(Object.keys(env).some((k) => k.includes('__'))).toBe(false);
    expect(Object.values(env)).not.toContain('stale-env-appid');
    expect(Object.values(env)).not.toContain('plugin-level-secret');
  });
});

describe('platformAccountsForPlatform (read-time legacy migration)', () => {
  it('merges legacy wechat-mp-publish rows into the wechat-mp platform, platform rows winning', () => {
    const prefs: AppConfigPrefs = {
      pluginAccounts: {
        'wechat-mp-publish': [
          { id: 'legacy-1', name: '老号', credentials: { WECHAT_APPID: 'legacy' } },
          { id: 'shared', name: '同ID旧版' },
        ],
      },
      platformAccounts: {
        'wechat-mp': [{ id: 'shared', name: '同ID新版' }],
      },
    };
    const list = platformAccountsForPlatform(prefs, 'wechat-mp');
    expect(list.map((a) => a.id).sort()).toEqual(['legacy-1', 'shared']);
    expect(list.find((a) => a.id === 'shared')!.name).toBe('同ID新版'); // platform wins
    // Other platforms don't inherit wechat legacy rows.
    expect(platformAccountsForPlatform(prefs, 'douyin')).toEqual([]);
  });
});
