import { describe, expect, it, vi } from 'vitest';
import { runProtocolLogin } from './protocolLoginService.js';
import { setProtocolLoginBrowserAdapter } from './types.js';

describe('protocol login service', () => {
  it('keeps the flow ordered, generates TOTP on demand, and closes the context', async () => {
    const steps: string[] = [];
    const close = vi.fn(async () => undefined);
    const adapter = {
      login: vi.fn(async ({ totpCodeProvider, report }: any) => {
        expect(totpCodeProvider()).toMatch(/^\d{6}$/);
        report('chatgpt_login', '登录完成');
        return { session: { close }, email: 'user@example.com' };
      }),
      selectWorkspace: vi.fn(async ({ report }: any) => report('workspace_selected', '工作区已选择')),
      rebindTotp: vi.fn(async ({ report }: any) => {
        report('mfa_rebind', 'TOTP 已换绑');
        return { secret: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } };
      }),
      verifySession: vi.fn(async () => undefined),
      exchangeOAuth: vi.fn(async () => ({
        accessToken: 'access-token',
        refreshToken: 'refresh-token',
        email: 'user@example.com',
      })),
    };
    setProtocolLoginBrowserAdapter(adapter);
    try {
      const result = await runProtocolLogin({
        credentialLine: 'user@example.com---password---JBSWY3DPEHPK3PXP',
        report: (step) => steps.push(step),
      });
      expect(result.newTotpSecret).toBe('JBSWY3DPEHPK3PXP');
      expect(result.sub2api.accounts[0]?.credentials.refresh_token).toBe('refresh-token');
      expect(adapter.login).toHaveBeenCalledOnce();
      expect(adapter.selectWorkspace).toHaveBeenCalledOnce();
      expect(adapter.rebindTotp).toHaveBeenCalledOnce();
      expect(adapter.verifySession).toHaveBeenCalledOnce();
      expect(adapter.exchangeOAuth).toHaveBeenCalledOnce();
      expect(close).toHaveBeenCalledOnce();
      expect(steps).toContain('export_ready');
    } finally {
      setProtocolLoginBrowserAdapter(null);
    }
  });

  it('closes the isolated session when a later step fails', async () => {
    const close = vi.fn(async () => undefined);
    setProtocolLoginBrowserAdapter({
      login: async () => ({ session: { close } }),
      selectWorkspace: async () => { throw new Error('email verification required'); },
      rebindTotp: async () => ({ secret: { secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30 } }),
      verifySession: async () => undefined,
      exchangeOAuth: async () => ({ accessToken: 'access-token' }),
    });
    try {
      await expect(runProtocolLogin({
        credentialLine: 'user@example.com---password---JBSWY3DPEHPK3PXP',
      })).rejects.toThrow('email verification required');
      expect(close).toHaveBeenCalledOnce();
    } finally {
      setProtocolLoginBrowserAdapter(null);
    }
  });
});

