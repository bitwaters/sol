import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { parse as parseJsonc, printParseErrorCode, type ParseError } from 'jsonc-parser';
import { config as loadDotenv } from 'dotenv';
import { z } from 'zod';

/** 项目根目录（src/.. 或 dist/..） */
export const PROJECT_ROOT = fileURLToPath(new URL('..', import.meta.url));

/** 规则版本：影响信号计算逻辑时手动递增（写入 signal_evaluations.rules_version） */
export const RULES_VERSION = 'live-2026-09-14.2';

const rangeSchema = z.strictObject({
  min: z.number().nullable(),
  max: z.number().nullable(),
});


const configSchema = z
  .strictObject({
    chain: z.literal('sol'),
    signal: z.strictObject({
      windowMinutes: z.number().int().positive(),
      minDistinctWallets: z.number().int().min(1),
      strongWallets: z.number().int().min(1),
      requireOpenAction: z.boolean(),
      requireAtLeastOneSmartMoney: z.boolean(),
      cooldownMinutes: z.number().int().nonnegative(),
      clusterMerge: z.boolean(),
    }),
    tradeFilter: z.strictObject({
      sides: z.array(z.literal('buy')).min(1),
      actions: z.array(z.enum(['open', 'add'])).min(1),
      minTradeAmountUsd: z.number().nonnegative(),
      netInflowUsd: rangeSchema,
      walletCount: z.strictObject({ max: z.number().int().positive().nullable() }),
    }),
    signalValidation: z.strictObject({
      prePushRecheck: z.literal(true),
      fastFlipMinutes: z.number().nonnegative(),
      fastFlipSellRatio: z.number().min(0).max(1),
      dropFullyExitedWallets: z.literal(true),
      minValidWallets: z.number().int().min(1),
      minVerifiableWallets: z.number().int().min(1),
      minConsensusHoldingRatio: z.number().min(0).max(1),
      positionDustRatio: z.number().min(0).max(1),
      signalTtlSeconds: z.number().int().positive(),
      warnPriceAboveEntry: z.number().positive(),
      blockPriceAboveEntry: z.number().positive(),
      postPushExitAlert: z.strictObject({
        enabled: z.boolean(),
        actions: z.array(z.literal('close')).min(1),
        minWallets: z.number().int().min(1),
      }),
    }),
    tokenFilter: z.strictObject({
      ageMinutes: rangeSchema,
      marketCapUsd: rangeSchema,
      holderCount: rangeSchema,
      liquidityUsd: rangeSchema,
      maxTop10HolderRate: z.number().min(0).max(1),
      maxBundlerRate: z.number().min(0).max(1),
      maxInsiderRate: z.number().min(0).max(1),
      maxEntrapmentRate: z.number().min(0).max(1),
      maxBotDegenRate: z.number().min(0).max(1),
      maxSniperCount: z.number().int().nonnegative(),
      maxFreshWalletRate: z.number().min(0).max(1),
      maxDevTeamHoldRate: z.number().min(0).max(1),
      excludeHoneypot: z.boolean(),
      requireRenouncedMint: z.boolean(),
      requireRenouncedFreeze: z.boolean(),
      requireSocial: z.boolean(),
    }),
    walletFilter: z.strictObject({
      excludeTags: z.array(z.string()),
      minWalletAgeDays: z.number().nonnegative(),
      minObservedBuys: z.number().int().nonnegative(),
      cluster: z.strictObject({
        sameFunder: z.boolean(),
        creationTimeDeltaMinutes: z.number().nonnegative(),
        maxHops: z.literal(1),
        excludeFunderLabels: z.array(z.string()),
      }),
    }),
    exitAlerts: z.strictObject({
      enabled: z.boolean(),
      actions: z.array(z.literal('close')).min(1),
      minWallets: z.number().int().min(1),
    }),
    polling: z.strictObject({
      smartmoney: z.strictObject({
        intervalMs: z.number().int().positive(),
        limit: z.number().int().min(1).max(200),
      }),
      kol: z.strictObject({
        intervalMs: z.number().int().positive(),
        limit: z.number().int().min(1).max(200),
      }),
      followWallet: z.strictObject({
        intervalMs: z.number().int().positive(),
        limit: z.number().int().min(1).max(100),
      }),
    }),
    push: z.strictObject({
      language: z.literal('zh'),
      maxPerMinute: z.number().int().positive(),
      editThrottleSec: z.number().int().nonnegative(),
      stopEditAfterMinutes: z.number().int().nonnegative(),
      links: z.array(z.string()).min(1),
      buyButton: z.string(),
      quietHours: z.strictObject({
        start: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        end: z.string().regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/),
        minWallets: z.number().int().min(1),
      }),
    }),
    retention: z.strictObject({ tradesDays: z.number().int().positive() }),
  })
  .superRefine((cfg, ctx) => {
    const issue = (path: (string | number)[], message: string) =>
      ctx.addIssue({ code: z.ZodIssueCode.custom, path, message });

    if (cfg.signal.strongWallets < cfg.signal.minDistinctWallets) {
      issue(['signal', 'strongWallets'], 'strongWallets 必须 >= minDistinctWallets');
    }
    if (cfg.signalValidation.minVerifiableWallets > cfg.signalValidation.minValidWallets) {
      issue(
        ['signalValidation', 'minVerifiableWallets'],
        'minVerifiableWallets 必须 <= minValidWallets',
      );
    }
    if (cfg.signalValidation.warnPriceAboveEntry >= cfg.signalValidation.blockPriceAboveEntry) {
      issue(
        ['signalValidation', 'warnPriceAboveEntry'],
        'warnPriceAboveEntry 必须 < blockPriceAboveEntry',
      );
    }
    if (
      cfg.signalValidation.postPushExitAlert.enabled &&
      cfg.signalValidation.postPushExitAlert.minWallets < 1
    ) {
      issue(['signalValidation', 'postPushExitAlert', 'minWallets'], '必须 >= 1');
    }
    for (const [key, range] of Object.entries(cfg.tokenFilter)) {
      if (range && typeof range === 'object' && 'min' in range && 'max' in range) {
        const { min, max } = range as { min: number | null; max: number | null };
        if (min !== null && max !== null && min > max) {
          issue(['tokenFilter', key], `${key}.min 必须 <= ${key}.max`);
        }
      }
    }
    const ni = cfg.tradeFilter.netInflowUsd;
    if (ni.min !== null && ni.max !== null && ni.min > ni.max) {
      issue(['tradeFilter', 'netInflowUsd'], 'netInflowUsd.min 必须 <= max');
    }
  });

const envSchema = z.object({
  GMGN_API_KEY: z.string().min(1, 'GMGN_API_KEY 必填（见 .env.example）'),
  GMGN_PRIVATE_KEY: z.string().optional(),
  GMGN_PROXY: z.url().refine((url) => ['http:', 'https:'].includes(new URL(url).protocol), 'GMGN_PROXY 仅支持 HTTP/HTTPS 代理').optional(),
  GMGN_RATE_LIMIT_PER_SEC: z.coerce.number().positive().finite().default(20),
  TG_BOT_TOKEN: z.string().optional(),
  TG_CHAT_ID: z.string().optional(),
  TG_ADMIN_IDS: z.string().optional(),
  TG_ALERT_CHAT_ID: z.string().optional(),
  DRY_RUN: z.enum(['0', '1']).default('0'),
});

export type AppConfig = z.infer<typeof configSchema>;
export type Env = z.infer<typeof envSchema>;

export interface LoadedConfig {
  config: AppConfig;
  configVersion: string;
  rulesVersion: string;
  env: Env;
  dryRun: boolean;
}

export interface LoadConfigOptions {
  /** 项目根目录，默认 PROJECT_ROOT */
  root?: string;
  /** 跳过 .env 加载（测试用） */
  skipDotenv?: boolean;
  /** 覆盖环境变量（测试用） */
  env?: Record<string, string | undefined>;
}

export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const root = options.root ?? PROJECT_ROOT;
  const configPath = `${root}/config.jsonc`;

  if (!options.skipDotenv) {
    loadDotenv({ path: `${root}/.env`, quiet: true });
  }

  const raw = readFileSync(configPath, 'utf8');
  const errors: ParseError[] = [];
  const parsed: unknown = parseJsonc(raw, errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length > 0) {
    const detail = errors
      .map((e) => `${printParseErrorCode(e.error)}@offset ${e.offset}`)
      .join(', ');
    throw new Error(`config.jsonc 解析失败: ${detail}`);
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const detail = result.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`config.jsonc 校验失败:\n${detail}`);
  }

  const envSource = options.env ?? process.env;
  const envResult = envSchema.safeParse(envSource);
  if (!envResult.success) {
    const detail = envResult.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('\n');
    throw new Error(`环境变量校验失败:\n${detail}`);
  }

  const configVersion = createHash('sha256').update(raw).digest('hex').slice(0, 12);

  return {
    config: result.data,
    configVersion,
    rulesVersion: RULES_VERSION,
    env: envResult.data,
    dryRun: envResult.data.DRY_RUN === '1',
  };
}
