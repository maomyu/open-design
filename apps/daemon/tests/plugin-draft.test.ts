import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildDraftManifest,
  parsePluginDraftJson,
  slugifyPluginName,
  validatePluginDraft,
} from '../src/plugin-draft-routes.js';
import { resolvePluginFolder } from '../src/plugins/registry.js';
import { deriveInputsFromQuery } from '../src/plugin-edit-routes.js';

const STAGES = [
  {
    id: 'topic',
    title: '选题',
    gate: 'confirm' as const,
    prompt: '给 5 个选题,按命中率排序。',
    modes: [
      { id: 'ai-suggest', label: 'AI 建议', prompt: '坦诚说明是 AI 建议。' },
    ],
    skills: ['trend-scraper'],
  },
  {
    id: 'review',
    title: '复盘',
    gate: 'none' as const,
    prompt: '汇总产出,给下一步建议。',
    modes: [],
    skills: [],
  },
];

const VALID_DRAFT = {
  name: 'xhs-weekly-pipeline',
  title: '小红书周更流水线',
  description: '母婴账号每周图文选题到发布的流水线。',
  query: '当一个小红书周更总控,先确认账号定位,再走选题→文案→复盘。',
  skill: '# 协作协议\n\n用 TodoWrite 维护步骤条;关键决策用 AskUserQuestion。',
  stages: STAGES,
};

describe('parsePluginDraftJson', () => {
  it('parses a fenced JSON draft and coerces stages', () => {
    const parsed = parsePluginDraftJson('```json\n' + JSON.stringify(VALID_DRAFT) + '\n```');
    expect(parsed?.name).toBe('xhs-weekly-pipeline');
    expect(parsed?.stages).toHaveLength(2);
    expect(parsed?.stages?.[0]).toMatchObject({ id: 'topic', gate: 'confirm' });
    expect(parsed?.stages?.[0]?.modes).toHaveLength(1);
  });

  it('drops invalid gate values to none and skips id-less stages', () => {
    const parsed = parsePluginDraftJson(
      JSON.stringify({
        ...VALID_DRAFT,
        stages: [
          { id: 'a', title: 'A', gate: 'pause', prompt: 'p', modes: [] },
          { title: 'no-id', gate: 'confirm', prompt: 'p', modes: [] },
        ],
      }),
    );
    expect(parsed?.stages).toHaveLength(1);
    expect(parsed?.stages?.[0]?.gate).toBe('none');
  });

  it('returns null for unparseable text', () => {
    expect(parsePluginDraftJson('nope')).toBeNull();
  });
});

describe('slugifyPluginName', () => {
  it('normalizes to the manifest id charset', () => {
    expect(slugifyPluginName('My Cool Plugin!')).toBe('my-cool-plugin');
    expect(slugifyPluginName('xhs.weekly_v2')).toBe('xhs.weekly_v2');
  });
  it('returns empty for unusable values', () => {
    expect(slugifyPluginName('---')).toBe('');
    expect(slugifyPluginName(42)).toBe('');
  });
});

describe('validatePluginDraft', () => {
  it('passes a complete draft with no diagnostics', () => {
    expect(validatePluginDraft(VALID_DRAFT)).toEqual([]);
  });

  it('errors on each missing required field', () => {
    const codes = validatePluginDraft({}).map((d) => d.code);
    expect(codes).toEqual(
      expect.arrayContaining(['NAME_REQUIRED', 'TITLE_REQUIRED', 'QUERY_REQUIRED', 'SKILL_REQUIRED']),
    );
  });

  it('errors on an invalid plugin id', () => {
    const codes = validatePluginDraft({ ...VALID_DRAFT, name: 'Bad Name' }).map((d) => d.code);
    expect(codes).toContain('NAME_INVALID');
  });

  it('warns on missing stages and empty stage prompts', () => {
    expect(validatePluginDraft({ ...VALID_DRAFT, stages: [] }).map((d) => d.code)).toContain('NO_STAGES');
    const diags = validatePluginDraft({
      ...VALID_DRAFT,
      stages: [{ id: 'x', title: 'X', gate: 'none' as const, prompt: '', modes: [], skills: [] }],
    });
    const empty = diags.find((d) => d.code === 'STAGE_PROMPT_EMPTY');
    expect(empty?.severity).toBe('warning');
  });
});

describe('deriveInputsFromQuery / buildDraftManifest inputs', () => {
  it('derives one string input per unique {{placeholder}}, skipping declared ones', () => {
    expect(deriveInputsFromQuery('写{{topic}}，语气{{tone}}，再谈{{topic}}')).toEqual([
      { name: 'topic', label: 'topic', type: 'string' },
      { name: 'tone', label: 'tone', type: 'string' },
    ]);
    expect(deriveInputsFromQuery('写{{topic}}', [{ name: 'topic' }])).toEqual([]);
    expect(deriveInputsFromQuery('no placeholders here')).toEqual([]);
  });

  it('gives a created user plugin od.inputs for its query placeholders (fillable slots)', () => {
    const m = buildDraftManifest({
      ...VALID_DRAFT,
      query: '写一段关于{{topic}}的文案，风格{{tone}}',
    }) as { od?: { inputs?: unknown } };
    expect(m.od?.inputs).toEqual([
      { name: 'topic', label: 'topic', type: 'string' },
      { name: 'tone', label: 'tone', type: 'string' },
    ]);
  });

  it('omits od.inputs when the query has no placeholders', () => {
    const m = buildDraftManifest(VALID_DRAFT) as { od?: { inputs?: unknown } };
    expect(m.od?.inputs).toBeUndefined();
  });
});

describe('buildDraftManifest → registry round-trip', () => {
  let folder = '';
  afterEach(async () => {
    if (folder) await rm(folder, { recursive: true, force: true });
    folder = '';
  });

  // The invariant the save route depends on: a manifest we build from a
  // valid draft MUST pass the registry's zod parse and register as an
  // editable user plugin (sourceKind 'user' is what the plugin editor's
  // `editable` flag keys on).
  it('produces a folder resolvePluginFolder accepts with sourceKind user', async () => {
    folder = await mkdtemp(path.join(os.tmpdir(), 'od-plugin-draft-'));
    await writeFile(path.join(folder, 'SKILL.md'), VALID_DRAFT.skill + '\n', 'utf8');
    await writeFile(
      path.join(folder, 'open-design.json'),
      JSON.stringify(buildDraftManifest(VALID_DRAFT), null, 2) + '\n',
      'utf8',
    );
    const resolved = await resolvePluginFolder({
      folder,
      folderId: VALID_DRAFT.name,
      sourceKind: 'user',
      source: `draft:${VALID_DRAFT.name}`,
      trust: 'trusted',
    });
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.record.id).toBe('xhs-weekly-pipeline');
    expect(resolved.record.sourceKind).toBe('user');
    const manifest = resolved.record.manifest as {
      od?: { workflow?: { stages?: Array<{ id: string; gate?: string; modes?: unknown[] }> }; useCase?: { query?: string } };
    };
    expect(manifest.od?.useCase?.query).toBe(VALID_DRAFT.query);
    expect(manifest.od?.workflow?.stages?.map((s) => s.id)).toEqual(['topic', 'review']);
    // Mode-less stages must not carry an empty modes array (keeps the
    // manifest minimal; the editor re-adds modes on demand).
    expect(manifest.od?.workflow?.stages?.[1]?.modes).toBeUndefined();
    // Stage-bound skills persist as refs; skill-less stages stay minimal.
    const stagesRaw = manifest.od?.workflow?.stages as Array<{ skills?: unknown }> | undefined;
    expect(stagesRaw?.[0]?.skills).toEqual([{ ref: 'trend-scraper' }]);
    expect(stagesRaw?.[1]?.skills).toBeUndefined();
  });
});
