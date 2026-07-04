// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
  type InstalledPluginRecord,
  type SkillSummary,
} from '@open-design/contracts';
import { HomeView } from '../../src/components/HomeView';

const SKILL: SkillSummary = {
  id: 'prototype-lab',
  name: 'Prototype Lab',
  description: 'Create a focused prototype.',
  triggers: ['prototype', 'flow'],
  mode: 'prototype',
  previewType: 'html',
  designSystemRequired: false,
  defaultFor: [],
  upstream: null,
  hasBody: true,
  examplePrompt: 'Design a focused onboarding prototype.',
  aggregatesExamples: false,
};

const DECK_SKILL: SkillSummary = {
  ...SKILL,
  id: 'deck-lab',
  name: 'Deck Lab',
  description: 'Create a focused slide deck.',
  triggers: ['deck', 'slides'],
  mode: 'deck',
  examplePrompt: 'Design a focused investor deck.',
};

const WEB_PROTOTYPE_PLUGIN = makePlugin('example-web-prototype', 'Web Prototype');

// The tab strip below the composer is gone; creation types are picked by
// typing a `#` token in the composer and choosing from the picker.
async function pickTypeChip(id: string) {
  const input = (await screen.findByTestId('home-hero-input')) as HTMLTextAreaElement;
  const base = input.value.trim();
  fireEvent.change(input, { target: { value: base ? `${base} #` : '#' } });
  const option = (await screen.findByTestId(
    `home-hero-option-type-${id}`,
  )) as HTMLButtonElement;
  await waitFor(() => expect(option.disabled).toBe(false));
  fireEvent.mouseDown(option);
}

function makePlugin(id: string, title: string): InstalledPluginRecord {
  return {
    id,
    title,
    version: '1.0.0',
    sourceKind: 'bundled',
    source: `/tmp/${id}`,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: {
      name: id,
      title,
      version: '1.0.0',
      description: `${title} fixture`,
      tags: ['fixture'],
      od: {
        kind: 'scenario',
        taskKind: 'new-generation',
        // The mention picker only surfaces INVOKABLE bundled plugins
        // (featured or kind=skill); mark fixtures featured so they stay
        // visible to these picker specs.
        featured: true,
        useCase: {
          query: `Hydrated query from ${title}`,
        },
      },
    },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('HomeView context picker', () => {
  it('stages pasted files on Home and submits them as first-turn context', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();
    const file = new File(['brief'], 'brief.pdf', { type: 'application/pdf' });

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    expect(screen.getByTestId('home-hero-attach')).toBeTruthy();
    fireEvent.paste(input, {
      clipboardData: {
        items: [
          {
            kind: 'file',
            getAsFile: () => file,
          },
        ],
      },
    });

    await waitFor(() => expect(screen.getByText('brief.pdf')).toBeTruthy());
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '',
      pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
      attachments: [file],
    }));
  });

  it('activates the @-picked plugin like "Use": renders its brief with fillable input placeholders', async () => {
    // A plugin whose kickoff query has editable input placeholders — the whole
    // point of "回显": {{tone}} fills from its default, {{topic}} stays a
    // fillable slot the operator can type into.
    const writer: InstalledPluginRecord = {
      id: 'writer-plugin',
      title: 'Writer Plugin',
      version: '1.0.0',
      sourceKind: 'user',
      source: '/tmp/writer',
      trust: 'trusted',
      capabilitiesGranted: ['prompt:inject'],
      fsPath: '/tmp/writer',
      installedAt: 0,
      updatedAt: 0,
      manifest: {
        name: 'writer-plugin',
        title: 'Writer Plugin',
        version: '1.0.0',
        od: {
          kind: 'skill',
          taskKind: 'new-generation',
          featured: true,
          useCase: { query: 'Write about {{topic}} in a {{tone}} tone.' },
          inputs: [
            { name: 'topic', label: 'Topic', type: 'string' },
            { name: 'tone', label: 'Tone', type: 'string', default: 'friendly' },
          ],
        },
      },
    };
    const applied = { query: 'Write about {{topic}} in a {{tone}} tone.', inputs: writer.manifest!.od!.inputs };
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      const u = String(url);
      if (u === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [writer] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      if (u.includes('/apply')) {
        return new Response(JSON.stringify(applied), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    fireEvent.change(input, { target: { value: '@writer' } });
    fireEvent.mouseDown(await screen.findByRole('option', { name: /writer plugin/i }));

    // The composer is replaced with the rendered brief: {{tone}} filled from its
    // default, {{topic}} left as a fillable placeholder. The @token is gone.
    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe('Write about {{topic}} in a friendly tone.');
    });
    expect((input as HTMLTextAreaElement).value).not.toContain('@writer');
    // The plugin is now ACTIVE (its query template drives the editable overlay),
    // so it applied through the daemon rather than being a silent context chip.
    await waitFor(() => {
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/apply'))).toBe(true);
    });
  });

  it('binds a selected home skill to the created project payload', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    fireEvent.change(input, { target: { value: '@proto' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /prototype lab/i }));

    await waitFor(() => {
      expect((input as HTMLTextAreaElement).value).toBe('@Prototype Lab');
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      prompt: '@Prototype Lab',
      pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
      skillId: SKILL.id,
      projectKind: 'prototype',
    }));
  });

  it('clears an active type chip when the user picks a skill (#2972)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[DECK_SKILL, SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    await pickTypeChip('prototype');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-type-chip').textContent).toContain('Prototype');
    });

    const input = screen.getByTestId('home-hero-input');
    fireEvent.change(input, { target: { value: '@deck' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /deck lab/i }));

    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
      expect(screen.queryByTestId('home-hero-active-type-chip')).toBeNull();
    });

    fireEvent.click(screen.getByTestId('home-hero-submit'));

    expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: DEFAULT_UNSELECTED_SCENARIO_PLUGIN_ID,
      skillId: DECK_SKILL.id,
      projectKind: 'deck',
    }));
    expect(onSubmit.mock.calls[0]?.[0]?.pluginId).not.toBe('example-web-prototype');
  });

  it('clears an active skill when the user picks a type chip (#2972)', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (url) => {
      if (typeof url === 'string' && url === '/api/plugins') {
        return new Response(JSON.stringify({ plugins: [WEB_PROTOTYPE_PLUGIN] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url.includes('/apply')) {
        return new Response(JSON.stringify({
          appliedPlugin: {
            snapshotId: 'snap-web-prototype',
            pluginId: 'example-web-prototype',
            pluginVersion: '1.0.0',
            inputs: {},
          },
          contextItems: [],
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      if (typeof url === 'string' && url === '/api/mcp/servers') {
        return new Response(JSON.stringify({ servers: [], templates: [] }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
    const onSubmit = vi.fn();

    render(
      <HomeView
        projects={[]}
        skills={[SKILL]}
        onSubmit={onSubmit}
        onOpenProject={() => undefined}
        onViewAllProjects={() => undefined}
      />,
    );

    const input = await screen.findByTestId('home-hero-input');
    fireEvent.change(input, { target: { value: '@proto' } });
    fireEvent.mouseDown(screen.getByRole('option', { name: /prototype lab/i }));
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-skill')).toBeTruthy();
    });

    await pickTypeChip('prototype');
    await waitFor(() => {
      expect(screen.getByTestId('home-hero-active-type-chip').textContent).toContain('Prototype');
      expect(screen.queryByTestId('home-hero-active-skill')).toBeNull();
    });

    fireEvent.change(input, { target: { value: 'Build a pricing-page prototype.' } });
    fireEvent.click(screen.getByTestId('home-hero-submit'));

    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      pluginId: 'example-web-prototype',
      skillId: null,
      projectKind: 'prototype',
    })));
  });
});
