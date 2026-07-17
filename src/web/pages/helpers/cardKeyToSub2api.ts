import {
  convertChatGptSessionSources,
  parseJwtPayload,
} from './chatGptSessionConverter.js';

export type ConversionIssue = {
  line: number;
  message: string;
};

export type CardKeyConversionResult = {
  output: Record<string, unknown>;
  inputAccounts: number;
  outputAccounts: number;
  duplicateAccounts: number;
  issues: ConversionIssue[];
};

export function extractJwtClientId(accessToken: unknown): string {
  const clientId = parseJwtPayload(accessToken)?.client_id;
  return typeof clientId === 'string' ? clientId : '';
}

/**
 * Backward-compatible entry point for existing callers. The shared Session
 * converter also accepts the older line-delimited card-key export envelope.
 */
export function convertCardKeyExport(raw: string, strict = false): CardKeyConversionResult {
  const result = convertChatGptSessionSources(
    [{ text: raw, sourceName: 'card-key-export.txt' }],
    { format: 'sub2api' },
  );
  const issues = result.issues.map((issue) => ({
    line: 0,
    message: `${issue.path}: ${issue.reason}`,
  }));
  if (strict && issues.length) throw new Error(issues[0].message);

  return {
    output: result.output as Record<string, unknown>,
    inputAccounts: result.inputAccounts,
    outputAccounts: result.outputAccounts,
    duplicateAccounts: 0,
    issues,
  };
}
