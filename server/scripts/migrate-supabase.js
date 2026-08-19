import { readFile, writeFile } from 'node:fs/promises';
import { inspectSupabaseExport, redactedMigrationReport } from '../src/migration/supabase-export.js';

const args = new Set(process.argv.slice(2)); const source = process.env.MIGRATION_INPUT ?? process.argv.find((arg) => !arg.startsWith('-') && arg.endsWith('.jsonl'));
const report = source ? redactedMigrationReport(inspectSupabaseExport(await readFile(source, 'utf8'))) : { lineCount: 0, validLines: 0, invalidLines: 0, userCount: 0, sourceSha256: null, users: [] };
const output = process.argv.includes('--report') ? process.argv[process.argv.indexOf('--report') + 1] : null;
if (output) await writeFile(output, `${JSON.stringify({ dryRun: !args.has('--apply'), sourceConfigured: Boolean(source), ...report }, null, 2)}\n`, 'utf8'); else console.log(JSON.stringify({ dryRun: !args.has('--apply'), sourceConfigured: Boolean(source), ...report }, null, 2));
