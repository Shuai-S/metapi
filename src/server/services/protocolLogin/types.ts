import type { ParsedTotpSecret, ProtocolLoginCredential } from './totp.js';

export type ProtocolLoginStep =
  | 'proxy_check'
  | 'isolated_context_created'
  | 'chatgpt_login'
  | 'workspace_selected'
  | 'mfa_rebind'
  | 'new_factor_verified'
  | 'oauth_exchange'
  | 'export_ready';

export type ProtocolLoginStepReporter = (step: ProtocolLoginStep, message: string) => void;

export type ProtocolLoginBrowserSession = {
  close: () => Promise<void>;
};

export type ProtocolLoginAuthenticatedSession = {
  session: ProtocolLoginBrowserSession;
  accountId?: string;
  email?: string;
  workspaceId?: string;
  planType?: string;
};

export type ProtocolLoginMfaResult = {
  secret: ParsedTotpSecret;
};

export type ProtocolLoginOAuthResult = {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  email?: string;
  workspaceId?: string;
  planType?: string;
  expiresAt?: string;
};

export type ProtocolLoginBrowserAdapter = {
  login(input: {
    credential: ProtocolLoginCredential;
    totpCodeProvider: () => string;
    proxyUrl?: string;
    report: ProtocolLoginStepReporter;
  }): Promise<ProtocolLoginAuthenticatedSession>;
  selectWorkspace(input: {
    authenticated: ProtocolLoginAuthenticatedSession;
    report: ProtocolLoginStepReporter;
  }): Promise<void>;
  rebindTotp(input: {
    authenticated: ProtocolLoginAuthenticatedSession;
    report: ProtocolLoginStepReporter;
  }): Promise<ProtocolLoginMfaResult>;
  verifySession(input: {
    authenticated: ProtocolLoginAuthenticatedSession;
    report: ProtocolLoginStepReporter;
  }): Promise<void>;
  exchangeOAuth(input: {
    authenticated: ProtocolLoginAuthenticatedSession;
    report: ProtocolLoginStepReporter;
  }): Promise<ProtocolLoginOAuthResult>;
};

export class ProtocolLoginAdapterUnavailableError extends Error {
  constructor() {
    super('Protocol login browser adapter is not configured');
    this.name = 'ProtocolLoginAdapterUnavailableError';
  }
}

let browserAdapter: ProtocolLoginBrowserAdapter | null = null;

export function setProtocolLoginBrowserAdapter(adapter: ProtocolLoginBrowserAdapter | null): void {
  browserAdapter = adapter;
}

export function getProtocolLoginBrowserAdapter(): ProtocolLoginBrowserAdapter {
  if (!browserAdapter) throw new ProtocolLoginAdapterUnavailableError();
  return browserAdapter;
}

