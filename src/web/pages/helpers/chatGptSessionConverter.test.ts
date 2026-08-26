import { describe, expect, it } from 'vitest';
import {
  convertChatGptSessionSources,
  parseJwtPayload,
  SESSION_OUTPUT_FORMATS,
  SUB2API_CODEX_FINGERPRINT_MODES,
  type Sub2ApiCodexFingerprintMode,
  type SessionOutputFormat,
} from './chatGptSessionConverter.js';

function token(payload: object) {
  const encode = (value: object) => btoa(JSON.stringify(value))
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
  return `${encode({ alg: 'none' })}.${encode(payload)}.signature`;
}

const now = new Date('2026-06-15T12:00:00.000Z');
const expiresAt = '2026-08-06T14:29:36.000Z';
const accessToken = token({
  exp: Math.floor(Date.parse(expiresAt) / 1000),
  email: 'token@example.com',
  'https://api.openai.com/auth': {
    chatgpt_account_id: 'account-1',
    chatgpt_user_id: 'user-1',
    chatgpt_plan_type: 'plus',
  },
});
const session = {
  user: { id: 'user-1', email: 'mark@example.com' },
  account: { id: 'account-1', planType: 'plus' },
  accessToken,
  refreshToken: 'refresh-1',
};

function convert(format: SessionOutputFormat, value: unknown = session) {
  return convertChatGptSessionSources(
    [{ text: JSON.stringify(value), sourceName: 'session.json' }],
    { format, now },
  );
}

describe('ChatGPT Session converter', () => {
  it('finds nested sessions and builds the sub2api import document', () => {
    const result = convert('sub2api', { payload: { sessions: [session] } });
    const output = result.output as any;
    expect(result.inputAccounts).toBe(1);
    expect(result.outputAccounts).toBe(1);
    expect(result.issues).toEqual([]);
    expect(output.exported_at).toBe(now.toISOString());
    expect(output.accounts[0]).toMatchObject({
      name: 'mark@example.com',
      platform: 'openai',
      type: 'oauth',
      priority: 10001,
      credentials: {
        access_token: accessToken,
        chatgpt_user_id: 'user-1',
        email: 'mark@example.com',
        expires_at: expiresAt,
        refresh_token: 'refresh-1',
      },
      extra: {
        email_key: 'mark_example_com',
        source: 'chatgpt_web_session',
      },
    });
  });

  it('preserves identity fields from an existing sub2api export', () => {
    const exportedAccessToken = token({
      exp: Math.floor(Date.parse(expiresAt) / 1000),
    });
    const result = convert('sub2api', {
      type: 'sub2api-data',
      version: 1,
      accounts: [{
        name: 'exported@example.com',
        credentials: {
          access_token: exportedAccessToken,
          account_id: 'workspace-from-credentials',
          chatgpt_user_id: 'user-from-credentials',
          email: 'exported@example.com',
        },
      }],
    });

    expect((result.output as any).accounts[0].credentials).toMatchObject({
      account_id: 'workspace-from-credentials',
      chatgpt_account_id: 'workspace-from-credentials',
      chatgpt_user_id: 'user-from-credentials',
      email: 'exported@example.com',
    });
  });

  it('applies configured models and account scheduling fields to sub2api output', () => {
    const result = convertChatGptSessionSources(
      [{ text: JSON.stringify(session), sourceName: 'session.json' }],
      {
        format: 'sub2api',
        now,
        sub2apiAccountSettings: {
          models: ['codex-auto-review', 'gpt-5.4', 'gpt-5.4', '  gpt-5.5  '],
          concurrency: 5,
          rateMultiplier: 0,
          priority: 10,
          importGroup: '  codex-pool  ',
        },
      },
    );
    expect((result.output as any).accounts[0]).toMatchObject({
      group: 'codex-pool',
      concurrency: 5,
      priority: 10,
      rate_multiplier: 0,
      credentials: {
        model_mapping: {
          'codex-auto-review': 'codex-auto-review',
          'gpt-5.4': 'gpt-5.4',
          'gpt-5.5': 'gpt-5.5',
        },
      },
    });
    expect(result.converted[0]).toMatchObject({
      accountOutputPriority: 10,
      sub2apiPriority: 10001,
    });
  });

  it.each([
    ['off', undefined],
    ['device', 'device'],
    ['session', 'session'],
    ['full', 'full'],
  ] satisfies Array<[Sub2ApiCodexFingerprintMode, string | undefined]>)(
    'maps the %s Codex fingerprint mode to sub2api extra',
    (codexFingerprintMode, expected) => {
      const result = convertChatGptSessionSources(
        [{ text: JSON.stringify(session), sourceName: 'session.json' }],
        {
          format: 'sub2api',
          now,
          sub2apiAccountSettings: { codexFingerprintMode },
        },
      );
      const account = (result.output as any).accounts[0];

      expect(SUB2API_CODEX_FINGERPRINT_MODES).toContain(codexFingerprintMode);
      if (expected === undefined) {
        expect(account.extra).not.toHaveProperty('codex_fingerprint_mode');
      } else {
        expect(account.extra.codex_fingerprint_mode).toBe(expected);
      }
      expect(account.extra).not.toHaveProperty('codex_fingerprint_seed');
    },
  );

  it('omits missing and invalid Codex fingerprint modes at runtime', () => {
    const missing = convertChatGptSessionSources(
      [{ text: JSON.stringify(session), sourceName: 'session.json' }],
      { format: 'sub2api', now },
    );
    const invalid = convertChatGptSessionSources(
      [{ text: JSON.stringify(session), sourceName: 'session.json' }],
      {
        format: 'sub2api',
        now,
        sub2apiAccountSettings: {
          codexFingerprintMode: 'unexpected' as Sub2ApiCodexFingerprintMode,
        },
      },
    );

    expect((missing.output as any).accounts[0].extra)
      .not.toHaveProperty('codex_fingerprint_mode');
    expect((invalid.output as any).accounts[0].extra)
      .not.toHaveProperty('codex_fingerprint_mode');
  });

  it('applies the selected Codex fingerprint mode to every sub2api account', () => {
    const second = {
      ...session,
      user: { id: 'user-2', email: 'two@example.com' },
      account: { id: 'account-2', planType: 'plus' },
    };
    const result = convertChatGptSessionSources(
      [{ text: JSON.stringify([session, second]), sourceName: 'sessions.json' }],
      {
        format: 'sub2api',
        now,
        sub2apiAccountSettings: { codexFingerprintMode: 'session' },
      },
    );

    expect((result.output as any).accounts.map(
      (account: any) => account.extra.codex_fingerprint_mode,
    )).toEqual(['session', 'session']);
    expect(JSON.stringify(result.output)).not.toContain('codex_fingerprint_seed');
  });

  it('applies the import group to every sub2api account and omits blank groups', () => {
    const second = {
      ...session,
      user: { id: 'user-2', email: 'two@example.com' },
      account: { id: 'account-2', planType: 'plus' },
    };
    const grouped = convertChatGptSessionSources(
      [{ text: JSON.stringify([session, second]), sourceName: 'sessions.json' }],
      {
        format: 'sub2api',
        now,
        sub2apiAccountSettings: { importGroup: 'batch-a' },
      },
    );
    expect((grouped.output as any).accounts.map((account: any) => account.group)).toEqual([
      'batch-a',
      'batch-a',
    ]);

    const ungrouped = convertChatGptSessionSources(
      [{ text: JSON.stringify(session), sourceName: 'session.json' }],
      {
        format: 'sub2api',
        now,
        sub2apiAccountSettings: { importGroup: '   ' },
      },
    );
    expect((ungrouped.output as any).accounts[0]).not.toHaveProperty('group');
  });

  it('builds each supported output contract from the same normalized session', () => {
    expect(SESSION_OUTPUT_FORMATS).toEqual([
      'sub2api', 'cpa', 'cockpit', '9router', 'axonhub', 'codexmanager',
    ]);
    expect(convert('cpa').output).toMatchObject({
      type: 'codex',
      email: 'mark@example.com',
      priority: 9999,
      access_token: accessToken,
      refresh_token: 'refresh-1',
    });
    expect(convert('cockpit').output).toMatchObject({
      type: 'codex', account_id: 'account-1', access_token: accessToken,
    });
    expect(convert('9router').output).toMatchObject({
      provider: 'codex', authType: 'oauth', id: 'account-1', isActive: true,
    });
    expect(convert('axonhub').output).toMatchObject({
      auth_mode: 'chatgpt', tokens: { access_token: accessToken, refresh_token: 'refresh-1' },
    });
    expect(convert('codexmanager').output).toMatchObject({
      priority: 10001,
      tokens: { access_token: accessToken, refresh_token: 'refresh-1', account_id: 'account-1' },
      meta: { label: 'mark@example.com' },
    });
  });

  it('creates a synthetic CPA id token when the source has an account id but no id token', () => {
    const output = convert('cpa').output as any;
    expect(output.id_token_synthetic).toBe(true);
    expect(parseJwtPayload(output.id_token)).toMatchObject({
      email: 'mark@example.com',
      'https://api.openai.com/auth': {
        chatgpt_account_id: 'account-1',
        chatgpt_user_id: 'user-1',
        chatgpt_plan_type: 'plus',
      },
    });
  });

  it('parses banner-prefixed and concatenated JSON documents', () => {
    const second = { ...session, user: { id: 'user-2', email: 'two@example.com' } };
    const result = convertChatGptSessionSources([{
      sourceName: 'card-key.txt',
      text: `卡密导出\n${JSON.stringify(session)}\n${JSON.stringify(second)}`,
    }], { format: 'sub2api', now });
    expect(result.outputAccounts).toBe(2);
    expect(result.converted.map((item) => item.email)).toEqual(['mark@example.com', 'two@example.com']);
  });

  it('sets the effective expiry to 24 hours after conversion when refresh is requested', () => {
    const result = convertChatGptSessionSources(
      [{ sourceName: 'session.json', text: JSON.stringify(session) }],
      { format: 'sub2api', now, forceRefreshAfterImport: true },
    );
    expect(result.converted[0].effectiveExpiresAt).toBe('2026-06-16T12:00:00.000Z');
    expect((result.output as any).accounts[0].credentials.expires_at).toBe('2026-06-16T12:00:00.000Z');
  });

  it('reports invalid documents without producing output', () => {
    const result = convertChatGptSessionSources(
      [{ sourceName: 'broken.json', text: '{nope' }],
      { format: 'sub2api', now },
    );
    expect(result.outputAccounts).toBe(0);
    expect(result.outputText).toBe('');
    expect(result.issues[0]).toMatchObject({ sourceName: 'broken.json', path: '$' });
  });
});
