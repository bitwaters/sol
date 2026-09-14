import { describe, expect, it } from 'vitest';
import { loadConfig, PROJECT_ROOT } from '../src/config.js';

const baseEnv = { GMGN_API_KEY: 'test-key', DRY_RUN: '1' };

describe('loadConfig', () => {
  it('加载并校验 config.jsonc', () => {
    const loaded = loadConfig({ root: PROJECT_ROOT, skipDotenv: true, env: baseEnv });
    expect(loaded.config.chain).toBe('sol');
    expect(loaded.config.signal.windowMinutes).toBe(15);
    expect(loaded.config.signalValidation.minVerifiableWallets).toBe(2);
    expect(loaded.configVersion).toMatch(/^[0-9a-f]{12}$/);
    expect(loaded.rulesVersion.length).toBeGreaterThan(0);
    expect(loaded.dryRun).toBe(true);
  });

  it('缺少 GMGN_API_KEY 时报错', () => {
    expect(() =>
      loadConfig({ root: PROJECT_ROOT, skipDotenv: true, env: { DRY_RUN: '0' } }),
    ).toThrow(/GMGN_API_KEY/);
  });

  it('DRY_RUN 默认关闭', () => {
    const loaded = loadConfig({
      root: PROJECT_ROOT,
      skipDotenv: true,
      env: { GMGN_API_KEY: 'test-key' },
    });
    expect(loaded.dryRun).toBe(false);
  });
});
