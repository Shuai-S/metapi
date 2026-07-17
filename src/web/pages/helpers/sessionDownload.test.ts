import { describe, expect, it } from 'vitest';
import { convertChatGptSessionSources } from './chatGptSessionConverter.js';
import { buildSessionDownload } from './sessionDownload.js';

const now = new Date(2026, 5, 15, 12, 0, 0);
const session = (email: string) => ({
  user: { email },
  account: { id: `account-${email}` },
  accessToken: `access-${email}`,
});

describe('Session conversion downloads', () => {
  it('packages multiple CPA accounts as a ZIP archive', async () => {
    const result = convertChatGptSessionSources([{
      sourceName: 'sessions.json',
      text: JSON.stringify([session('one@example.com'), session('two@example.com')]),
    }], { format: 'cpa', now });
    const download = buildSessionDownload(result, now);
    expect(download.fileName).toBe('cpa-batch.2026-06-15_12-00-00.zip');
    expect(download.blob.type).toBe('application/zip');
    const signature = Array.from(new Uint8Array(await download.blob.arrayBuffer()).slice(0, 4));
    expect(signature).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('downloads other formats as JSON', () => {
    const result = convertChatGptSessionSources([{
      sourceName: 'session.json',
      text: JSON.stringify(session('one@example.com')),
    }], { format: 'sub2api', now });
    const download = buildSessionDownload(result, now);
    expect(download.fileName).toBe('one@example.sub2api.2026-06-15_12-00-00.json');
    expect(download.blob.type).toBe('application/json;charset=utf-8');
  });
});
