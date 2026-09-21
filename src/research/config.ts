import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { PROJECT_ROOT } from '../config.js';

export const RESEARCH_VERSION = 'research-2026-09-21.1';
const schema = z.strictObject({
  enabled: z.boolean(), intervalSec: z.number().int().min(30),
  maxPerStratum: z.number().int().min(1).max(10), maxPending: z.number().int().min(1).max(100),
  maxPerBatch: z.number().int().min(1).max(4), maxWalletRefresh: z.number().int().min(0).max(4),
  maxSnapshotTrades: z.number().int().min(100).max(20000), maxSnapshotWallets: z.number().int().min(1).max(200),
  windowMinutes: z.number().int().min(30).max(60),
  activeWithinSec: z.number().int().min(30).max(300).default(120),
  maxOutcomeBatch: z.number().int().min(2).max(16).default(8),
  minIndependentTokens: z.number().int().min(20), minPerCell: z.number().int().min(20),
  baselineCoverage: z.number().min(.95).max(1), outcomeCoverage: z.number().min(.9).max(1),
});
export type ResearchConfig = z.infer<typeof schema>;
export function loadResearchConfig(path = join(PROJECT_ROOT, 'research.json')) {
  const config = schema.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { config, version: createHash('sha256').update(JSON.stringify(config)).digest('hex').slice(0, 12) };
}
