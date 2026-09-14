import { captureDelivery } from './research/delivery.js';
import { loadResearchConfig } from './research/config.js';
import { reserveResearch, collectResearch } from './research/collector.js';
import { evaluateResearchOutcomes } from './research/outcomes.js';
import { repairBaselines } from './backtest/repair.js';
import { EvaluationScheduler } from './signal/scheduler.js';
import { runtimeMetrics } from './ops/metrics.js';
import { evaluateOutcomes } from './backtest/evaluate.js';
import { sendDailyReport } from './backtest/report.js';
import { backupDatabase, sendOpsAlerts } from './ops/alerts.js';
import { ProxyAgent, setGlobalDispatcher } from 'undici';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig, PROJECT_ROOT } from './config.js';
import { loadCexBlacklist } from './enrich/wallet.js';
import { OpenApiClient } from './gmgn/OpenApiClient.js';
import { archiveAndPrune } from './ingest/archive.js';
import { backfillFollow } from './ingest/backfill.js';
import { GmgnGateway } from './ingest/gateway.js';
import { BanGate, TokenBucket } from './ingest/limiter.js';
import { extractFollowNextToken, Poller } from './ingest/poller.js';
import type { NormalizedTrade } from './ingest/normalize.js';
import { createLogger } from './logger.js';
import { evaluateToken, revalidateSignalForSend, runCandidateMaintenance } from './signal/candidate.js';
import { applyIngestedTrades } from './signal/ingest.js';
import { createBot, grammySender, registerBotCommands } from './telegram/bot.js';
import { runExitMonitor } from './telegram/exit-monitor.js';
import { Pusher } from './telegram/pusher.js';
import { getKv, openDatabase, setKv, type Db } from './store/db.js';

const log = createLogger({ module: 'main' });

async function main(): Promise<void> {
  const loaded = loadConfig();
  const { config, env, dryRun } = loaded;
  const research = loadResearchConfig();
  log.info('配置加载完成', {
    configVersion: loaded.configVersion,
    rulesVersion: loaded.rulesVersion,
    dryRun,
    followEnabled: Boolean(env.GMGN_PRIVATE_KEY),
  });

  const dataDir = join(PROJECT_ROOT, 'data');
  mkdirSync(dataDir, { recursive: true });
  const db = openDatabase({ path: join(dataDir, 'meme.sqlite') });
  setKv(db, 'service_started_at', Math.floor(Date.now() / 1000));
  setKv(db, 'runtime_metrics', null);
  setKv(db, 'enabled_sources', ['smartmoney', 'kol', ...(env.GMGN_PRIVATE_KEY ? ['follow'] : [])]);

  const ratePerSecond = env.GMGN_RATE_LIMIT_PER_SEC;
  if (env.GMGN_PROXY) setGlobalDispatcher(new ProxyAgent(env.GMGN_PROXY));
  const client = new OpenApiClient({
    apiKey: env.GMGN_API_KEY,
    privateKeyPem: env.GMGN_PRIVATE_KEY?.replace(/\\n/g, '\n'),
    host: 'https://openapi.gmgn.ai',
    autoRetryOnRateLimit: false,
  });
  const gateway = new GmgnGateway({
    client,
    limiter: new TokenBucket({ ratePerSecond, capacity: 5 }),
    banGate: new BanGate(),
    logger: log,
  });

  const blacklist = loadCexBlacklist(join(PROJECT_ROOT, 'data', 'cex-blacklist.json'));
  const engineDeps = {
    db,
    config,
    gateway,
    logger: log.child({ module: 'engine' }),
    configVersion: loaded.configVersion,
    rulesVersion: loaded.rulesVersion,
    blacklist,
  };

  // 成交流入库回调：应用持仓周期 + 调度候选评估
  const evaluationScheduler = new EvaluationScheduler({
    concurrency: 2,
    delayMs: 250,
    run: async (token) => {
      const result = await evaluateToken(engineDeps, token);
      runtimeMetrics.observe(`evaluation.result.${result.status}`, 0);
    },
    onError: (token, error) => log.error('候选评估失败', { token, error }),
  });
  const scheduleEvaluation = (token: string): void => evaluationScheduler.schedule(token);

  const onTrades = (trades: NormalizedTrade[]): void => {
    let observationStartedAt = getKv<number>(db, 'observation_started_at');
    if (observationStartedAt === null) {
      observationStartedAt = Math.floor(Date.now() / 1000);
      setKv(db, 'observation_started_at', observationStartedAt);
    }
    applyIngestedTrades(db, trades, config.signalValidation.positionDustRatio, log);
    for (const token of new Set(trades.map((t) => t.baseAddress))) scheduleEvaluation(token);
  };

  const pollers: Poller[] = [
    new Poller({
      source: 'smartmoney',
      intervalMs: config.polling.smartmoney.intervalMs,
      limit: config.polling.smartmoney.limit,
      fetchPage: ({ limit }) => gateway.fetchSmartmoney(limit),
      db,
      logger: log.child({ source: 'smartmoney' }),
      onTrades: (_source, trades) => onTrades(trades),
    }),
    new Poller({
      source: 'kol',
      intervalMs: config.polling.kol.intervalMs,
      limit: config.polling.kol.limit,
      fetchPage: ({ limit }) => gateway.fetchKol(limit),
      db,
      logger: log.child({ source: 'kol' }),
      onTrades: (_source, trades) => onTrades(trades),
    }),
  ];

  if (env.GMGN_PRIVATE_KEY) {
    pollers.push(
      new Poller({
        source: 'follow',
        intervalMs: config.polling.followWallet.intervalMs,
        limit: config.polling.followWallet.limit,
        fetchPage: ({ limit, nextPageToken }) =>
          gateway.fetchFollowWallet({
            limit,
            ...(nextPageToken ? { nextPageToken } : {}),
          }),
        extractNextToken: extractFollowNextToken,
        paginate: true,
        db,
        logger: log.child({ source: 'follow' }),
        onTrades: (_source, trades) => onTrades(trades),
      }),
    );
  } else {
    log.warn('未配置 GMGN_PRIVATE_KEY，follow-wallet 源已禁用（其余源正常运行）');
  }

  for (const poller of pollers) poller.start();

  // 回补循环：每 60s 尝试一次 follow 缺口回补
  const backfillTimer = setInterval(() => {
    void backfillFollow({
      db,
      logger: log.child({ source: 'backfill' }),
      dustRatio: config.signalValidation.positionDustRatio,
      onTrades,
      fetchFollowPage: ({ limit, nextPageToken }) =>
        gateway.fetchFollowWallet({ limit, ...(nextPageToken ? { nextPageToken } : {}) }),
    }).catch((err: unknown) => log.error('回补失败', { error: err }));
  }, 60_000);

  // 归档与保留清理：启动后 10s 首次执行，之后每 6h 一次（归档校验通过才清理）
  const archiveDir = join(dataDir, 'archive');
  const runArchive = (): void => {
    try {
      const result = archiveAndPrune(db, {
        archiveDir,
        retentionDays: config.retention.tradesDays,
        logger: log.child({ module: 'archive' }),
      });
      if (result.days > 0) {
        log.info('归档任务完成', {
          days: result.days,
          archivedTrades: result.archivedTrades,
          deletedTrades: result.deletedTrades,
          files: result.files,
        });
      }
    } catch (err) {
      log.error('归档任务失败', { error: err });
    }
  };
  const archiveStartupTimer = setTimeout(runArchive, 10_000);
  const archiveTimer = setInterval(runArchive, 6 * 3600_000);
  const shutdownHooks: Array<() => void> = [];
  const metricsTimer = setInterval(() => {
    const snapshot = { timestamp: Math.floor(Date.now() / 1000), metrics: runtimeMetrics.snapshot() };
    setKv(db, 'runtime_metrics', snapshot);
    log.info('运行耗时汇总', snapshot);
  }, 60_000);
  shutdownHooks.push(() => clearInterval(metricsTimer));

  // M4/M5：数据评估、对照采样、退出监控、备份与候选维护（不依赖 Telegram）
  const measurementGateway = gateway.background();
  const researchDeps = { ...engineDeps, gateway: measurementGateway, research: research.config, researchVersion: research.version };
  let measuring = false;
  const runMeasurements = async (): Promise<void> => {
    if (measuring) return;
    measuring = true;
    try {
      await collectResearch(researchDeps);
      await evaluateResearchOutcomes(researchDeps);
      await repairBaselines({ ...engineDeps, gateway: measurementGateway, maxPerRun: 4 });
      await evaluateOutcomes({ db, config, gateway: measurementGateway,
        logger: log.child({ module: 'backtest' }), maxPerRun: 4 });
    } catch (err) { log.error('回测失败', { error: err }); }
    finally { measuring = false; }
  };
  const backtestTimer = setInterval(() => { void runMeasurements(); }, 30_000);
  const runControls = (): void => {
    try {
      const created = reserveResearch(researchDeps);
      if (created > 0) void runMeasurements();
    } catch (err) {
      log.error('对照采样失败', { error: err });
    }
  };
  // The persisted 15-minute gate survives restarts; polling this gate creates no extra samples.
  const controlTimer = setInterval(runControls, 30_000);
  runControls();
  const exitTimer = setInterval(() => {
    try {
      const created = runExitMonitor({
        db,
        config,
        logger: log.child({ module: 'exit-monitor' }),
        blacklist,
      });
      if (created > 0) log.info('退出监控创建提醒', { created });
    } catch (err) {
      log.error('退出监控失败', { error: err });
    }
  }, 60_000);
  let lastBackupDay = '';
  const backupTimer = setInterval(() => {
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    if (d.getUTCHours() === 9 && lastBackupDay !== day) {
      try {
        backupDatabase(db, join(dataDir, 'backups'), {
          now: d,
          retentionDays: 7,
          logger: log.child({ module: 'backup' }),
        });
        lastBackupDay = day;
      } catch (err) {
        log.error('数据库备份失败', { error: err });
      }
    }
  }, 60_000);
  const maintenanceTimer = setInterval(() => {
    try {
      const nowSec = Math.floor(Date.now() / 1000);
      const active = db
        .prepare("SELECT DISTINCT token FROM signals WHERE status IN ('candidate','sending','invalidated','blocked_price','suppressed_enrich_failed') UNION SELECT DISTINCT base_address AS token FROM trades WHERE timestamp >= ?")
        .all(nowSec - 2 * 3600) as Array<{ token: string }>;
      for (const { token } of active) {
        runCandidateMaintenance(
          db,
          token,
          nowSec,
          config.signal.windowMinutes,
          config.tradeFilter.minTradeAmountUsd,
        );
      }
      // 对仍有候选的 token 做定时重验（价格/年龄/富化退避）
      const candidates = db
        .prepare(
          `SELECT DISTINCT token FROM signals
           WHERE (status IN ('candidate','sending','invalidated','blocked_price','suppressed_enrich_failed')
                  AND triggered_at >= ?)
              OR (status = 'pushed' AND sent_at >= ?)`,
        )
        .all(nowSec - 3600, nowSec - config.push.stopEditAfterMinutes * 60) as Array<{ token: string }>;
      for (const { token } of candidates) scheduleEvaluation(token);
    } catch (err) {
      log.error('候选维护失败', { error: err });
    }
  }, 60_000);
  shutdownHooks.push(
    () => clearInterval(backtestTimer),
    () => clearInterval(controlTimer),
    () => clearInterval(exitTimer),
    () => clearInterval(backupTimer),
    () => clearInterval(maintenanceTimer),
  );

  // 推送层（M3）：需要 Telegram 凭证；缺失时仅记录（本地开发模式）
  let pushTimer: NodeJS.Timeout | null = null;
  if (!dryRun && env.TG_BOT_TOKEN && env.TG_CHAT_ID) {
    const adminIds = (env.TG_ADMIN_IDS ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
    const bot = createBot(env.TG_BOT_TOKEN, {
      db,
      config,
      logger: log.child({ module: 'bot' }),
      adminIds,
      ...(env.TG_ALERT_CHAT_ID ? { alertChatId: env.TG_ALERT_CHAT_ID } : {}),
    });
    const sender = grammySender(bot);
    const pusher = new Pusher({
      beforeRun: () => captureDelivery(researchDeps),
      db,
      blacklist,
      config,
      sender,
      chatId: env.TG_CHAT_ID,
      logger: log.child({ module: 'pusher' }),
      configVersion: loaded.configVersion,
      rulesVersion: loaded.rulesVersion,
      revalidate: (signalId) => revalidateSignalForSend(engineDeps, signalId),
    });
    pushTimer = setInterval(() => {
      void pusher
        .runOnce()
        .catch((err: unknown) => log.error('推送批次失败', { error: err }));
    }, 2000);

    // 每日报告（UTC 08:00）
    let lastReportDay = '';
    const reportTimer = setInterval(() => {
      const d = new Date();
      const day = d.toISOString().slice(0, 10);
      if (d.getUTCHours() === 8 && lastReportDay !== day) {
        lastReportDay = day;
        void sendDailyReport({
          db,
          config,
          sender,
          chatId: env.TG_CHAT_ID!,
          logger: log.child({ module: 'daily-report' }),
        }).catch((err: unknown) => { lastReportDay = ''; log.error('每日报告失败', { error: err }); });
      }
    }, 60_000);
    shutdownHooks.push(() => clearInterval(reportTimer));

    // 运维告警（每 5 分钟）
    if (env.TG_ALERT_CHAT_ID) {
      const alertChatId = env.TG_ALERT_CHAT_ID;
      const opsTimer = setInterval(() => {
        void sendOpsAlerts({
          db,
          sender,
          chatId: alertChatId,
          logger: log.child({ module: 'ops' }),
          nowSec: Math.floor(Date.now() / 1000),
          gatewayBannedUntilMs: gateway.bannedUntil,
        }).catch((err: unknown) => log.error('告警发送失败', { error: err }));
      }, 300_000);
      shutdownHooks.push(() => clearInterval(opsTimer));
    }

    void bot.start({ onStart: async () => {
      log.info('Telegram bot 已启动');
      try {
        await registerBotCommands(bot);
        log.info('Telegram 指令菜单已更新');
      } catch {
        log.error('Telegram 指令菜单更新失败，仍可输入 /help 使用指令');
      }
    } }).catch((err: unknown) => {
      log.error('Telegram bot 启动失败', { error: err });
    });
  } else {
    log.warn(
      dryRun
        ? 'DRY_RUN=1，推送层未启动（采集/信号评估/回测继续运行）'
        : '未配置 TG_BOT_TOKEN/TG_CHAT_ID，推送层未启动（信号仅入队 push_tasks）',
    );
  }

  log.info('M1 采集服务已启动', {
    pollerCount: pollers.length,
    ratePerSecond,
    dbPath: join(dataDir, 'meme.sqlite'),
    archiveDir,
  });

  const shutdown = (signal: string): void => {
    log.info('收到退出信号，正在关闭', { signal });
    clearInterval(backfillTimer);
    clearInterval(archiveTimer);
    clearTimeout(archiveStartupTimer);
    if (pushTimer) clearInterval(pushTimer);
    for (const hook of shutdownHooks) hook();
    for (const poller of pollers) poller.stop();
    evaluationScheduler.stop();
    closeDb(db);
    process.exit(0);
  };

  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function closeDb(db: Db): void {
  try {
    db.close();
  } catch (err) {
    log.warn('关闭数据库失败', { error: err });
  }
}

main().catch((err: unknown) => {
  log.error('启动失败', { error: err });
  process.exitCode = 1;
});
