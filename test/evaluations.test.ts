import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/store/db.js';
import { countEvaluations, listEvaluations, recordEvaluation } from '../src/store/repo/evaluations.js';

describe('recordEvaluation', () => {
  it('追加不可变评估记录并可回放', () => {
    const db = openDatabase({ path: ':memory:' });
    recordEvaluation(
      db,
      {
        signalId: 1,
        stage: 'wallet_layer',
        configVersion: 'cfg1',
        rulesVersion: 'rules1',
        inputSnapshot: { votes: 3, netInflow: 2500 },
        result: 'fail',
        reason: 'holding_ratio_below_threshold',
      },
      1000,
    );
    recordEvaluation(
      db,
      {
        signalId: 1,
        stage: 'wallet_layer',
        configVersion: 'cfg1',
        rulesVersion: 'rules1',
        inputSnapshot: { votes: 4, netInflow: 4200 },
        result: 'pass',
      },
      1060,
    );

    expect(countEvaluations(db)).toBe(2);
    const rows = listEvaluations(db, 1);
    expect(rows.length).toBe(2);
    expect(rows[0]?.result).toBe('fail');
    expect(rows[0]?.inputSnapshot).toEqual({ votes: 3, netInflow: 2500 });
    expect(rows[1]?.result).toBe('pass');
    db.close();
  });
});
