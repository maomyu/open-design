// @vitest-environment jsdom
//
// 自媒体 hub + 账号中心 smoke contracts: the hub renders one entry per
// platform (fixed order) and activates the entry plugin via onUsePlugin; the
// accounts page renders every platform section and saves a platform-level
// account through PUT /api/accounts/:platform.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MEDIA_PLATFORMS, type InstalledPluginRecord } from '@open-design/contracts';
import { MediaHubView } from '../../src/components/MediaHubView';
import { AccountsView } from '../../src/components/AccountsView';

function plugin(id: string, title: string): InstalledPluginRecord {
  return {
    id,
    title,
    version: '0.1.0',
    sourceKind: 'bundled',
    source: `/tmp/${id}`,
    trust: 'bundled',
    capabilitiesGranted: ['prompt:inject'],
    fsPath: `/tmp/${id}`,
    installedAt: 0,
    updatedAt: 0,
    manifest: { name: id, title, version: '0.1.0', description: `${title} 描述` },
  };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('MediaHubView', () => {
  it('renders one entry per platform and activates the entry plugin on 开始', async () => {
    const plugins = [
      plugin('wechat-mp-publish', '公众号发布'),
      plugin('douyin-publish', '抖音发布'),
      plugin('short-video-copy', '短视频工作流'),
    ];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL) => {
      if (String(url).includes('/api/plugins')) {
        return new Response(JSON.stringify({ plugins }), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    }));
    const onUsePlugin = vi.fn();

    render(<MediaHubView onUsePlugin={onUsePlugin} />);

    // Every platform gets a card, in the MEDIA_PLATFORMS order.
    for (const p of MEDIA_PLATFORMS) {
      expect(await screen.findByTestId(`media-hub-${p.id}`)).toBeTruthy();
    }
    // Registered entry → enabled and wired to onUsePlugin.
    fireEvent.click(screen.getByTestId('media-hub-use-douyin'));
    expect(onUsePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'douyin-publish' }),
      'use',
    );
    // Missing entry (xiaohongshu not registered in this fixture) → disabled.
    expect(
      (screen.getByTestId('media-hub-use-xiaohongshu') as HTMLButtonElement).disabled,
    ).toBe(true);
    // The matrix card activates the short-video workflow.
    fireEvent.click(screen.getByTestId('media-hub-use-matrix'));
    expect(onUsePlugin).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'short-video-copy' }),
      'use',
    );
  });
});

describe('AccountsView', () => {
  it('renders every platform section and saves a platform-level account', async () => {
    const putBodies: Array<{ url: string; body: unknown }> = [];
    vi.stubGlobal('fetch', vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      if (u === '/api/accounts' && (!init || !init.method)) {
        return new Response(
          JSON.stringify({ platforms: MEDIA_PLATFORMS.map((p) => ({ id: p.id, accounts: [] })) }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.startsWith('/api/accounts/') && init?.method === 'PUT') {
        putBodies.push({ url: u, body: JSON.parse(String(init.body)) });
        return new Response(
          JSON.stringify({ id: u.split('/').pop(), saved: true, account: { id: 'a1', name: '主号', style: {}, credentials: {} } }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch ${u}`);
    }));

    render(<AccountsView />);

    for (const p of MEDIA_PLATFORMS) {
      expect(await screen.findByTestId(`accounts-platform-${p.id}`)).toBeTruthy();
    }
    // sau-login platform: add an account by name (no credential inputs).
    fireEvent.click(screen.getByTestId('accounts-add-douyin'));
    const form = await screen.findByTestId('accounts-form-douyin');
    fireEvent.change(form.querySelector('input')!, { target: { value: '主号' } });
    expect(form.querySelectorAll('input[type="password"]').length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /save account|保存账号/i }));

    await waitFor(() => {
      expect(putBodies.length).toBe(1);
      expect(putBodies[0]!.url).toBe('/api/accounts/douyin');
      expect(putBodies[0]!.body).toMatchObject({ name: '主号' });
    });
  });
});
