import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Logger } from '../logger.js';
import type { Db } from '../store/db.js';

export interface ArchiveOptions {
  archiveDir: string;
  retentionDays: number;
  now?: number;
  logger?: Logger;
  /** 每批写盘的行数 */
  chunkSize?: number;
}

export interface ArchiveResult {
  days: number;
  archivedTrades: number;
  deletedTrades: number;
  files: string[];
}

interface TradeRow {
  event_id: string;
  chain: string;
  tx_hash: string;
  maker: string;
  side: string;
  base_address: string;
  symbol: string | null;
  raw_amount: string | null;
  raw_amount_unit: string | null;
  raw_decimals: number | null;
  amount_normalized: string | null;
  amount_usd: string | null;
  price_usd: string | null;
  action_hint: string | null;
  is_open_or_close: number | null;
  timestamp: number;
  raw: string | null;
}

function archiveFileName(day: string): string {
  return `trades-${day}.jsonl.gz`;
}

function validateArchiveRow(line: string): string {
  const row = JSON.parse(line) as Record<string, unknown> | null;
  if (!row || ['event_id','chain','tx_hash','maker','base_address'].some(key => typeof row[key] !== 'string' || !row[key]) ||
      !['buy','sell'].includes(String(row['side'])) || !Number.isFinite(row['timestamp']) ||
      ['amount_normalized','amount_usd','price_usd'].some(key => row[key] !== null && typeof row[key] !== 'string') ||
      !Array.isArray(row['sources']) || row['sources'].some(source => typeof source !== 'string')) {
    throw new Error('归档成交字段不完整');
  }
  return row['event_id'] as string;
}

function readArchiveCount(path: string): number {
  const buf = readFileSync(path);
  const text = gunzipSync(buf).toString('utf8');
  if (text.trim() === '') return 0;
  const lines = text.trimEnd().split('\n');
  for (const line of lines) validateArchiveRow(line);
  return lines.length;
}

/**
 * 归档并清理过期成交（M1-11）：
 * - 按天导出 JSONL + gzip（含来源标签，供离线回放）
 * - 归档文件校验通过后才删除数据库记录
 * - 归档与删除均以天为单位
 */
export function archiveAndPrune(db: Db, options: ArchiveOptions): ArchiveResult {
  const { archiveDir, retentionDays, logger } = options;
  const nowSec = Math.floor((options.now ?? Date.now()) / 1000);
  const chunkSize = options.chunkSize ?? 1000;
  const cutoff = nowSec - retentionDays * 86_400;

  mkdirSync(archiveDir, { recursive: true });

  const days = db
    .prepare(
      `SELECT date(timestamp, 'unixepoch') AS day, COUNT(*) AS n
       FROM trades
       WHERE timestamp < ?
         AND (CAST(strftime('%s', date(timestamp, 'unixepoch')) AS INTEGER) + 86400) <= ?
       GROUP BY day ORDER BY day`,
    )
    .all(cutoff, cutoff) as Array<{ day: string; n: number }>;

  const result: ArchiveResult = { days: 0, archivedTrades: 0, deletedTrades: 0, files: [] };

  for (const { day, n } of days) {
    if(db.prepare(`SELECT 1 FROM position_jobs j JOIN trades t ON t.maker=j.wallet AND t.base_address=j.token
      WHERE date(t.timestamp,'unixepoch')=? LIMIT 1`).get(day)) {
      logger?.warn('存在待处理持仓，暂缓相关日期归档');continue;
    }
    const filePath = join(archiveDir, archiveFileName(day));

    // 合并已有归档（兼容旧版本的部分日归档），按 event_id 去重；读取失败则跳过该日
    const existingLines: string[] = [];
    const existingIds = new Set<string>();
    if (existsSync(filePath)) {
      try {
        const text = gunzipSync(readFileSync(filePath)).toString('utf8').trim();
        if (text !== '') {
          for (const line of text.split('\n')) {
            const eventId = validateArchiveRow(line);
            existingLines.push(line);
            existingIds.add(eventId);
          }
        }
      } catch {
        logger?.error('旧归档读取失败，跳过该日清理', { file: filePath });
        continue;
      }
    }

    {
      // 写入临时文件（多成员 gzip 合法），校验后原子替换；任何失败保留旧文件
      const tmpPath = `${filePath}.tmp`;
      if (existsSync(tmpPath)) rmSync(tmpPath, { force: true });
      const rows = db
        .prepare(
          `SELECT t.*, (SELECT json_group_array(s.source) FROM trade_sources s WHERE s.event_id = t.event_id) AS sources
           FROM trades t
           WHERE date(t.timestamp, 'unixepoch') = ? AND t.timestamp < ?
           ORDER BY t.timestamp, t.event_id`,
        )
        .iterate(day, cutoff) as IterableIterator<TradeRow & { sources: string | null }>;

      let buffer: string[] = [...existingLines];
      let written = existingLines.length;
      const flush = (): void => {
        if (buffer.length === 0) return;
        const gz = gzipSync(Buffer.from(`${buffer.join('\n')}\n`, 'utf8'));
        appendFileSync(tmpPath, gz);
        buffer = [];
      };

      for (const row of rows) {
        if (existingIds.has(row.event_id)) continue;
        buffer.push(
          JSON.stringify({
            ...row,
            raw: row.raw ? (JSON.parse(row.raw) as unknown) : null,
            sources: row.sources ? (JSON.parse(row.sources) as string[]) : [],
          }),
        );
        written += 1;
        if (buffer.length >= chunkSize) flush();
      }
      flush();

      const verified = readArchiveCount(tmpPath);
      if (verified !== written) {
        rmSync(tmpPath, { force: true });
        logger?.error('归档校验失败，保留旧文件并跳过清理', { file: filePath, expected: written, actual: verified });
        continue;
      }
      renameSync(tmpPath, filePath);
    }

    const del = db.transaction((): number => {
      db.prepare(
        'DELETE FROM trade_sources WHERE event_id IN (SELECT event_id FROM trades WHERE date(timestamp, \'unixepoch\') = ? AND timestamp < ?)',
      ).run(day, cutoff);
      const res = db
        .prepare("DELETE FROM trades WHERE date(timestamp, 'unixepoch') = ? AND timestamp < ?")
        .run(day, cutoff);
      return res.changes;
    });
    const deleted = del();

    result.days += 1;
    result.archivedTrades += n;
    result.deletedTrades += deleted;
    result.files.push(filePath);
    logger?.info('归档并清理完成', { day, count: n, deleted, file: filePath });
  }

  return result;
}
