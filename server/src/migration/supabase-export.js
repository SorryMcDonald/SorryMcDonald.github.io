import { createHash } from 'node:crypto';

function parseLines(input) { return Array.isArray(input) ? input : String(input ?? '').split(/\r?\n/).filter(Boolean); }

export function inspectSupabaseExport(input) {
  const lines = parseLines(input); const users = new Map(); let validLines = 0; let invalidLines = 0;
  for (const line of lines) {
    try {
      const value = typeof line === 'string' ? JSON.parse(line) : line; validLines += 1;
      const userId = value.user_id ?? value.uid ?? value.id; if (!userId) continue;
      const chips = Math.max(0, Number(value.chips ?? value.beans ?? value.balance ?? 0) || 0);
      const existing = users.get(userId) ?? { legacyUserId: userId, maxBalance: 0, sourceRows: 0 };
      existing.maxBalance = Math.max(existing.maxBalance, chips); existing.sourceRows += 1; users.set(userId, existing);
    } catch { invalidLines += 1; }
  }
  const source = lines.join('\n'); return { lineCount: lines.length, validLines, invalidLines, userCount: users.size, sourceSha256: createHash('sha256').update(source).digest('hex'), users: [...users.values()] };
}

export function redactedMigrationReport(report) { return { lineCount: report.lineCount, validLines: report.validLines, invalidLines: report.invalidLines, userCount: report.userCount, sourceSha256: report.sourceSha256, users: report.users.map((user) => ({ legacyUserId: `${String(user.legacyUserId).slice(0, 4)}…`, maxBalance: user.maxBalance, sourceRows: user.sourceRows })) }; }
