// @vitest-environment jsdom
//
// 账号中心 smoke contract: the accounts page renders every platform section
// and saves a platform-level account through PUT /api/accounts/:platform.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MEDIA_PLATFORMS } from '@open-design/contracts';
import { AccountsView } from '../../src/components/AccountsView';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
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
