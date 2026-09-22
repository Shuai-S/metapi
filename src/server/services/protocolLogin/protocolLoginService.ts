import { generateTotp, parseProtocolLoginCredential, type ProtocolLoginCredential } from './totp.js';
import {
  getProtocolLoginBrowserAdapter,
  type ProtocolLoginOAuthResult,
  type ProtocolLoginStepReporter,
} from './types.js';
import {
  buildSub2ApiV027ImportDocument,
  type Sub2ApiV027ExportOptions,
  type Sub2ApiV027ImportDocument,
} from './sub2apiExport.js';

export type ProtocolLoginRunOptions = {
  credentialLine: string;
  proxyUrl?: string;
  exportOptions?: Sub2ApiV027ExportOptions;
  report?: ProtocolLoginStepReporter;
};

export type ProtocolLoginRunResult = {
  account: string;
  email?: string;
  newTotpSecret: string;
  oauth: ProtocolLoginOAuthResult;
  sub2api: Sub2ApiV027ImportDocument;
};

function noopReport(): void {}

function reportStep(
  report: ProtocolLoginStepReporter,
  step: Parameters<ProtocolLoginStepReporter>[0],
  message: string,
): void {
  report(step, message);
}

export async function runProtocolLogin(options: ProtocolLoginRunOptions): Promise<ProtocolLoginRunResult> {
  const credential: ProtocolLoginCredential = parseProtocolLoginCredential(options.credentialLine);
  const report = options.report || noopReport;
  const adapter = getProtocolLoginBrowserAdapter();

  const authenticated = await adapter.login({
    credential,
    proxyUrl: options.proxyUrl,
    totpCodeProvider: () => generateTotp(credential.totp),
    report,
  });

  try {
    reportStep(report, 'workspace_selected', '正在选择默认工作区');
    await adapter.selectWorkspace({ authenticated, report });

    reportStep(report, 'mfa_rebind', '正在换绑 TOTP');
    const mfa = await adapter.rebindTotp({ authenticated, report });
    const verificationCode = generateTotp(mfa.secret);
    if (!/^\d{6,8}$/.test(verificationCode)) {
      throw new Error('新 TOTP 密钥无法生成有效验证码');
    }
    reportStep(report, 'new_factor_verified', '新 TOTP 已生成并通过本地格式校验');

    await adapter.verifySession({ authenticated, report });
    reportStep(report, 'oauth_exchange', '正在提取 OAuth 凭据');
    const oauth = await adapter.exchangeOAuth({ authenticated, report });
    const sub2api = buildSub2ApiV027ImportDocument(oauth, options.exportOptions);
    reportStep(report, 'export_ready', 'Sub2API v0.2.7 JSON 已生成');

    return {
      account: credential.username,
      email: oauth.email || authenticated.email,
      newTotpSecret: mfa.secret.secret,
      oauth,
      sub2api,
    };
  } finally {
    await authenticated.session.close();
  }
}

