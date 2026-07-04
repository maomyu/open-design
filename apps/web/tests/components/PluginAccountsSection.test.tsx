// @vitest-environment jsdom
//
// Account-profiles editor UX contract: the credential form speaks HUMAN — it
// reuses the od.config declarations (label/description/secret) instead of
// showing raw env-var names; non-secret keys are plain text inputs; and the
// section auto-expands on first run (no accounts yet) so the setup entry
// point is discoverable.

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PluginAccountsSection } from '../../src/components/PluginAccountsSection';

// Stateful stub: PUT /accounts stores the profile (echoing what a real daemon
// does — presence flags only, never values), later GETs list it. `failPut`
// simulates a rejected save (duplicate name) so the error path is testable.
function stubFetch(opts: { failPut?: boolean } = {}) {
  const saved: Array<{ id: string; name: string; style: object; credentials: Record<string, boolean> }> = [];
  const putBodies: unknown[] = [];
  const fetchMock = vi.fn<typeof fetch>(async (url, init) => {
    const u = String(url);
    if (u.endsWith('/accounts') && init?.method === 'PUT') {
      if (opts.failPut) {
        return new Response(
          JSON.stringify({ error: 'ACCOUNT_NAME_TAKEN', message: 'an account named "报考日记" already exists for this plugin' }),
          { status: 400, headers: { 'content-type': 'application/json' } },
        );
      }
      const body = JSON.parse(String(init.body)) as {
        name: string; style?: object; credentials?: Record<string, string>;
      };
      putBodies.push(body);
      const account = {
        id: 'acc-1',
        name: body.name,
        style: body.style ?? {},
        credentials: {
          WECHAT_APPID: Boolean(body.credentials?.WECHAT_APPID),
          WECHAT_AUTHOR: Boolean(body.credentials?.WECHAT_AUTHOR),
        },
      };
      saved.push(account);
      return new Response(
        JSON.stringify({ id: 'wechat-mp-publish', saved: true, account }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/accounts')) {
      return new Response(
        JSON.stringify({
          id: 'wechat-mp-publish',
          credentialKeys: ['WECHAT_APPID', 'WECHAT_AUTHOR'],
          accounts: [...saved],
          editable: true,
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    if (u.endsWith('/config')) {
      return new Response(
        JSON.stringify({
          id: 'wechat-mp-publish',
          editable: true,
          keys: [
            {
              name: 'WECHAT_APPID',
              label: '公众号 AppID',
              description: '已认证服务号的 AppID(发草稿必需)。',
              required: true,
              secret: true,
              set: false,
            },
            { name: 'WECHAT_AUTHOR', label: '作者名', secret: false, set: false },
          ],
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    throw new Error(`unexpected fetch ${u}`);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, putBodies };
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('PluginAccountsSection', () => {
  it('auto-expands on first run and renders credential fields with human labels', async () => {
    stubFetch();
    render(<PluginAccountsSection pluginId="wechat-mp-publish" editable />);

    // Auto-expanded: the empty-state guidance is visible without clicking the header.
    const addButton = await screen.findByRole('button', { name: /add account|加账号/i });
    fireEvent.click(addButton);

    await waitFor(() => {
      // Human label leads; the raw env-var name rides along as a small tag.
      expect(screen.getByText('公众号 AppID')).toBeTruthy();
      expect(screen.getByText('WECHAT_APPID')).toBeTruthy();
      // The od.config description surfaces so the operator knows what to paste.
      expect(screen.getByText(/发草稿必需/)).toBeTruthy();
    });

    // Secret key → password input; non-secret (作者名) → plain text input.
    const inputs = screen.getByTestId('plugin-account-form').querySelectorAll('input');
    const types = [...inputs].map((el) => el.getAttribute('type'));
    expect(types).toContain('password');
    expect(screen.getByText('作者名')).toBeTruthy();
    const authorField = screen.getByText('作者名').closest('label')!;
    expect(authorField.querySelector('input')!.getAttribute('type')).toBe('text');
  });

  // The user's core flow: adding a NEW account means typing that account's own
  // AppID/Secret right in the add form; saving must actually persist them
  // (PUT carries the credentials) and the list must reflect 已配置.
  it('saves a new account WITH its own credentials and shows them as configured', async () => {
    const { putBodies } = stubFetch();
    render(<PluginAccountsSection pluginId="wechat-mp-publish" editable />);

    fireEvent.click(await screen.findByRole('button', { name: /add account|加账号/i }));
    const form = await screen.findByTestId('plugin-account-form');

    // Fill name + this account's own AppID.
    const nameField = screen.getByText(/account name|账号名/i).closest('label')!;
    fireEvent.change(nameField.querySelector('input')!, { target: { value: '报考日记' } });
    const appidField = screen.getByText('公众号 AppID').closest('label')!;
    fireEvent.change(appidField.querySelector('input')!, { target: { value: 'wx_new_appid' } });

    fireEvent.click(screen.getByRole('button', { name: /save account|保存账号/i }));

    // The PUT body carries the typed credentials — the save is REAL.
    await waitFor(() => {
      expect(putBodies.length).toBe(1);
      expect(putBodies[0]).toMatchObject({
        name: '报考日记',
        credentials: { WECHAT_APPID: 'wx_new_appid' },
      });
    });
    // Form closes; the refreshed list shows the account with 已配置 on AppID.
    await waitFor(() => {
      expect(screen.queryByTestId('plugin-account-form')).toBeNull();
      expect(screen.getByTestId('plugin-account-acc-1')).toBeTruthy();
    });
    expect(form).toBeTruthy();
  });

  it('shows the daemon reason inline when a save is rejected (no silent no-op)', async () => {
    stubFetch({ failPut: true });
    render(<PluginAccountsSection pluginId="wechat-mp-publish" editable />);

    fireEvent.click(await screen.findByRole('button', { name: /add account|加账号/i }));
    const nameField = (await screen.findByText(/account name|账号名/i)).closest('label')!;
    fireEvent.change(nameField.querySelector('input')!, { target: { value: '报考日记' } });
    fireEvent.click(screen.getByRole('button', { name: /save account|保存账号/i }));

    const error = await screen.findByTestId('plugin-account-save-error');
    expect(error.textContent).toContain('already exists');
    // The form stays open so the operator can correct and retry.
    expect(screen.getByTestId('plugin-account-form')).toBeTruthy();
  });
});
