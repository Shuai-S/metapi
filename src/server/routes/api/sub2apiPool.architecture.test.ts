import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function readSource(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), 'utf8');
}

describe('Sub2API pool route architecture boundaries', () => {
  it('keeps persistence, encryption, and remote protocol ownership in the service', () => {
    const routeSource = readSource('./sub2apiPool.ts');
    expect(routeSource).toContain("from '../../services/sub2apiPoolService.js'");
    expect(routeSource).not.toMatch(/from ['"](?:undici|node:crypto|drizzle-orm)['"]/);
    expect(routeSource).not.toContain("from '../../db/");
    expect(routeSource).not.toContain('x-api-key');
    expect(routeSource).not.toContain('Idempotency-Key');
  });
});
