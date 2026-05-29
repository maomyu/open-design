// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { IntegrationsView } from '../../src/components/IntegrationsView';
import type { AppConfig } from '../../src/types';
import type { SkillSummary } from '@open-design/contracts';

const originalFetch = globalThis.fetch;

const TEST_CONFIG: AppConfig = {
  mode: 'daemon',
  apiKey: '',
  baseUrl: '',
  model: '',
  agentId: null,
  skillId: null,
  designSystemId: null,
  disabledSkills: [],
};

function makeSkill(overrides: Partial<SkillSummary>): SkillSummary {
  return {
    id: 'skill',
    name: 'Skill',
    description: 'A skill',
    triggers: [],
    mode: 'prototype',
    previewType: 'html',
    designSystemRequired: true,
    defaultFor: [],
    upstream: null,
    hasBody: true,
    examplePrompt: '',
    aggregatesExamples: false,
    source: 'built-in',
    ...overrides,
  };
}

function mockSkillsFetch(skills: SkillSummary[]) {
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input.toString();
    if (url === '/api/skills' && (!init || init.method === undefined)) {
      return new Response(JSON.stringify({ skills }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({}), { status: 404 });
  }) as typeof fetch;
}

function renderSkillsTab(skills: SkillSummary[]) {
  const onPersistConfig = vi.fn();
  const onPersistComposioKey = vi.fn();
  mockSkillsFetch(skills);
  render(
    <IntegrationsView
      config={TEST_CONFIG}
      initialTab="skills"
      onPersistComposioKey={onPersistComposioKey}
      onPersistConfig={onPersistConfig}
    />,
  );
  return { onPersistConfig };
}

describe('IntegrationsView skills tab', () => {
  afterEach(() => {
    cleanup();
    globalThis.fetch = originalFetch;
  });

  it('surfaces functional skills instead of the coming-soon placeholder', async () => {
    renderSkillsTab([
      makeSkill({ id: 'alpha-skill', name: 'alpha-skill' }),
      makeSkill({ id: 'beta-skill', name: 'beta-skill' }),
    ]);

    await waitFor(() => {
      expect(screen.getByText('alpha-skill')).toBeTruthy();
      expect(screen.getByText('beta-skill')).toBeTruthy();
    });

    // The migrated tab renders the real registry, not the placeholder copy.
    expect(screen.queryByText('Skills integrations')).toBeNull();
  });

  it('persists disabled skills through onPersistConfig when a row is toggled off', async () => {
    const { onPersistConfig } = renderSkillsTab([
      makeSkill({ id: 'alpha-skill', name: 'alpha-skill' }),
    ]);

    await waitFor(() => {
      expect(screen.getByText('alpha-skill')).toBeTruthy();
    });

    const toggle = screen.getByTitle('Toggle');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(onPersistConfig).toHaveBeenCalledWith(
        expect.objectContaining({ disabledSkills: ['alpha-skill'] }),
      );
    });
  });
});
