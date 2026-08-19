import { describe, expect, it } from 'vitest';
import { inspectSupabaseExport } from '../src/migration/supabase-export.js';
import { issueLegacyClaim, mergeLegacyBalance, verifyLegacyClaim } from '../src/migration/claim.js';

describe('legacy migration safeguards', () => {
  it('reports line/hash metadata and picks the maximum balance', () => {
    const report = inspectSupabaseExport('{"user_id":"u1","chips":20}\n{"user_id":"u1","chips":80}\n');
    expect(report.lineCount).toBe(2); expect(report.userCount).toBe(1); expect(report.users[0].maxBalance).toBe(80); expect(report.sourceSha256).toMatch(/^[a-f0-9]{64}$/);
  });
  it('signs a short-lived claim for the matching legacy subject and email', () => {
    const token = issueLegacyClaim({ legacyUserId: 'old', email: 'A@example.com', secret: 'secret', now: 100 });
    expect(verifyLegacyClaim(token, { legacyUserId: 'old', email: 'a@example.com', secret: 'secret', now: 200 })).toHaveProperty('sub', 'old');
    expect(verifyLegacyClaim(token, { legacyUserId: 'other', email: 'a@example.com', secret: 'secret', now: 200 })).toBe(false);
  });
  it('merges a legacy balance only once', () => { const user = { beans: 10 }; mergeLegacyBalance(user, { maxBalance: 90 }); mergeLegacyBalance(user, { maxBalance: 90, migrationApplied: true }); expect(user.beans).toBe(100); });
});
