import type { Db } from '../db.js';

export type EvaluationStage = 'wallet_layer' | 'token_layer' | 'send_recheck';
export type EvaluationResult = 'pass' | 'fail';

export interface EvaluationInput {
  signalId: number;
  stage: EvaluationStage;
  configVersion: string;
  rulesVersion: string;
  inputSnapshot: unknown;
  result: EvaluationResult;
  reason?: string | null;
}

/**
 * 不可变评估记录（M1-14）：只追加，不更新。
 * 用于回放"当时为什么被拦截"以及假设验证（§10）。
 */
export function recordEvaluation(
  db: Db,
  input: EvaluationInput,
  now = Math.floor(Date.now() / 1000),
): number {
  const res = db
    .prepare(
      `INSERT INTO signal_evaluations
       (signal_id, evaluated_at, stage, config_version, rules_version, input_snapshot, result, reason, created_at)
       VALUES (@signal_id, @evaluated_at, @stage, @config_version, @rules_version, @input_snapshot, @result, @reason, @created_at)`,
    )
    .run({
      signal_id: input.signalId,
      evaluated_at: now,
      stage: input.stage,
      config_version: input.configVersion,
      rules_version: input.rulesVersion,
      input_snapshot: JSON.stringify(input.inputSnapshot),
      result: input.result,
      reason: input.reason ?? null,
      created_at: now,
    });
  return Number(res.lastInsertRowid);
}

export interface StoredEvaluation {
  id: number;
  signalId: number;
  evaluatedAt: number;
  stage: EvaluationStage;
  configVersion: string;
  rulesVersion: string;
  inputSnapshot: unknown;
  result: EvaluationResult;
  reason: string | null;
}

export function listEvaluations(db: Db, signalId: number): StoredEvaluation[] {
  const rows = db
    .prepare(
      `SELECT id, signal_id, evaluated_at, stage, config_version, rules_version, input_snapshot, result, reason
       FROM signal_evaluations WHERE signal_id = ? ORDER BY evaluated_at, id`,
    )
    .all(signalId) as Array<{
    id: number;
    signal_id: number;
    evaluated_at: number;
    stage: EvaluationStage;
    config_version: string;
    rules_version: string;
    input_snapshot: string;
    result: EvaluationResult;
    reason: string | null;
  }>;
  return rows.map((row) => ({
    id: row.id,
    signalId: row.signal_id,
    evaluatedAt: row.evaluated_at,
    stage: row.stage,
    configVersion: row.config_version,
    rulesVersion: row.rules_version,
    inputSnapshot: JSON.parse(row.input_snapshot) as unknown,
    result: row.result,
    reason: row.reason,
  }));
}

export function countEvaluations(db: Db): number {
  const row = db.prepare('SELECT COUNT(*) AS n FROM signal_evaluations').get() as { n: number };
  return row.n;
}
