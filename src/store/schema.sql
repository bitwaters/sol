-- Meme 信号 Bot 数据模型（SQLite）
-- 与 docs/DEVELOPMENT.md §6 保持一致；所有时间戳为 unix 秒（除 push_tasks 调度用毫秒见注释）

-- 成交事件（买卖双边；金额/数量按事件只累计一次）
CREATE TABLE IF NOT EXISTS trades (
  event_id TEXT PRIMARY KEY,        -- sol:tx_hash:maker:base_address:side:timestamp:token_amount:quote_amount
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  maker TEXT NOT NULL,
  side TEXT NOT NULL,               -- buy | sell
  base_address TEXT NOT NULL,
  symbol TEXT,
  raw_amount TEXT,                  -- 接口原样数量（字符串）
  raw_amount_unit TEXT,             -- human | base_unit
  raw_decimals INTEGER,
  amount_normalized TEXT,           -- 统一换算后的十进制数量
  amount_usd TEXT,                  -- 权威金额（十进制字符串）
  amount_usd_num REAL,              -- 冗余，仅 SQL 粗过滤
  price_usd TEXT,
  action_hint TEXT,                 -- full_open | partial_add | close | reduce | null
  is_open_or_close INTEGER,         -- 原始字段（按来源解释）
  timestamp INTEGER NOT NULL,
  raw JSON,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_trades_token_ts ON trades(base_address, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_maker_ts ON trades(maker, timestamp);
CREATE INDEX IF NOT EXISTS idx_trades_tx ON trades(tx_hash);
CREATE INDEX IF NOT EXISTS idx_trades_created ON trades(created_at);

-- 同一事件的多来源观测（只累计来源标签，不重复计金额）
CREATE TABLE IF NOT EXISTS trade_sources (
  event_id TEXT NOT NULL,
  source TEXT NOT NULL,             -- smartmoney | kol | follow
  raw_is_open_or_close INTEGER,
  raw JSON,
  first_seen_at INTEGER NOT NULL,
  PRIMARY KEY (event_id, source)
);

-- 同笔成交在不同来源有浮点表示差异，别名保留原始来源键，避免重复累计。
CREATE TABLE IF NOT EXISTS trade_event_aliases (
  source TEXT NOT NULL,
  alias_id TEXT NOT NULL,
  event_id TEXT NOT NULL REFERENCES trades(event_id) ON DELETE CASCADE,
  PRIMARY KEY (source, alias_id)
);
CREATE INDEX IF NOT EXISTS idx_trade_alias_event ON trade_event_aliases(event_id);

-- 采集健康与缺口
CREATE TABLE IF NOT EXISTS source_health (
  source TEXT PRIMARY KEY,
  last_success_at INTEGER,
  watermark_ts INTEGER,             -- 已完整处理到的成交时间水位
  gap_from_ts INTEGER,
  gap_to_ts INTEGER,
  backfill_cursor TEXT,
  updated_at INTEGER
);

-- 代币富化缓存
CREATE TABLE IF NOT EXISTS tokens (
  address TEXT PRIMARY KEY,
  symbol TEXT, name TEXT, launchpad TEXT,
  created_at INTEGER,
  price TEXT,
  price_updated_at INTEGER,
  risk_updated_at INTEGER,
  basic_updated_at INTEGER,
  market_cap REAL, liquidity REAL, holder_count INTEGER,
  top10_rate REAL, bundler_rate REAL, insider_rate REAL,
  entrapment_rate REAL, bot_degen_rate REAL,
  sniper_hold_rate REAL, sniper_count INTEGER, fresh_wallet_rate REAL,
  dev_hold_rate REAL, creator_token_status TEXT,
  is_honeypot INTEGER,
  renounced_mint INTEGER, renounced_freeze INTEGER,
  has_social INTEGER, socials JSON,
  enriched_at INTEGER,
  raw JSON
);

-- 钱包画像（每日批量刷新 + 候选时按需补拉）
CREATE TABLE IF NOT EXISTS wallets (
  address TEXT PRIMARY KEY,
  name TEXT, twitter TEXT, tags JSON,
  fund_from TEXT, fund_from_address TEXT,
  wallet_created_at INTEGER,
  refreshed_at INTEGER
);

-- 持仓周期（由 trades 增量更新；当前周期 = max(cycle_no)）
CREATE TABLE IF NOT EXISTS wallet_positions (
  wallet TEXT NOT NULL,
  token TEXT NOT NULL,
  cycle_no INTEGER NOT NULL DEFAULT 1,
  state TEXT NOT NULL DEFAULT 'open', -- open | closed | unknown | incomplete
  cost_complete INTEGER DEFAULT 0,
  bought_amount TEXT DEFAULT '0',
  sold_amount TEXT DEFAULT '0',
  bought_usd TEXT DEFAULT '0',
  sold_usd TEXT DEFAULT '0',
  avg_entry_price_usd TEXT,
  cycle_started_at INTEGER,
  last_buy_ts INTEGER,
  last_sell_ts INTEGER,
  last_trade_ts INTEGER,
  confidence REAL DEFAULT 0,
  PRIMARY KEY (wallet, token, cycle_no)
);
CREATE INDEX IF NOT EXISTS idx_positions_token ON wallet_positions(token);

-- 持仓检查点（核验余额 + 迟到事件重放）
CREATE TABLE IF NOT EXISTS position_checkpoints (
  wallet TEXT NOT NULL,
  token TEXT NOT NULL,
  cycle_no INTEGER NOT NULL,
  checked_at INTEGER NOT NULL,
  balance TEXT NOT NULL,
  bought_amount TEXT NOT NULL,
  sold_amount TEXT NOT NULL,
  bought_usd TEXT NOT NULL,
  sold_usd TEXT NOT NULL,
  cost_complete INTEGER NOT NULL,
  cycle_started_at INTEGER,
  last_buy_ts INTEGER,
  last_sell_ts INTEGER,
  source TEXT NOT NULL,             -- balance_info | local_rebuild
  PRIMARY KEY (wallet, token, cycle_no, checked_at)
);

-- 信号记录
CREATE TABLE IF NOT EXISTS signals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL,
  symbol TEXT,
  triggered_at INTEGER NOT NULL,
  window_start INTEGER,
  window_end INTEGER,
  wallet_count INTEGER,
  net_inflow_usd REAL,
  holding_ratio REAL,
  price_ratio REAL,
  status TEXT,
  reason TEXT,
  tg_chat_id TEXT, tg_message_id INTEGER,
  escalated_count INTEGER DEFAULT 0,
  message_revision INTEGER DEFAULT 0,
  price_at_trigger TEXT,
  price_at_send TEXT,
  sent_at INTEGER,
  outcome_5m REAL, outcome_1h REAL, outcome_24h REAL,
  snapshot JSON,
  display_wallets JSON,
  send_snapshot JSON
);
CREATE INDEX IF NOT EXISTS idx_signals_token ON signals(token, triggered_at);
CREATE INDEX IF NOT EXISTS idx_signals_status ON signals(status, triggered_at);

-- 信号涉及的钱包明细（绑定持仓周期）
CREATE TABLE IF NOT EXISTS signal_wallets (
  signal_id INTEGER NOT NULL,
  wallet TEXT NOT NULL,
  cycle_no INTEGER NOT NULL,
  cluster_id TEXT,
  joined_version INTEGER DEFAULT 0,
  joined_at INTEGER,
  joined_event_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  source TEXT, tags JSON,
  amount_usd TEXT, action TEXT,
  entry_price_usd TEXT,
  holding_state_at_push TEXT,
  holding_state_now TEXT,
  PRIMARY KEY (signal_id, wallet, cycle_no)
);

-- 运行状态：冷却、cursor、心跳
CREATE TABLE IF NOT EXISTS kv (
  key TEXT PRIMARY KEY,
  value JSON,
  updated_at INTEGER
);

-- 持久化发送任务
CREATE TABLE IF NOT EXISTS push_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  kind TEXT NOT NULL,               -- signal | escalate | exit_alert（summary 暂不实现）
  alert_type TEXT,                  -- consensus_exit | other_cluster_exit
  revision INTEGER DEFAULT 0,
  dedupe_key TEXT NOT NULL UNIQUE,
  payload JSON NOT NULL,
  status TEXT NOT NULL,             -- pending | sending | sent | unknown | failed | cancelled
  attempts INTEGER DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  next_retry_at INTEGER,
  tg_message_id INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_push_tasks_status ON push_tasks(status, updated_at);

-- 不可变评估记录
CREATE TABLE IF NOT EXISTS signal_evaluations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL,
  evaluated_at INTEGER NOT NULL,
  stage TEXT NOT NULL,              -- wallet_layer | token_layer | send_recheck
  config_version TEXT NOT NULL,
  rules_version TEXT NOT NULL,
  input_snapshot JSON NOT NULL,
  result TEXT NOT NULL,             -- pass | fail
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evaluations_signal ON signal_evaluations(signal_id, evaluated_at);

-- Measurement quality is separate from trading state; legacy rows stay explicitly unknown.
CREATE TABLE IF NOT EXISTS sample_quality (
  signal_id INTEGER PRIMARY KEY REFERENCES signals(id) ON DELETE CASCADE,
  anchor_ts INTEGER NOT NULL,
  anchor_price TEXT,
  selection_ts INTEGER NOT NULL,
  price_ts INTEGER,
  captured_at INTEGER NOT NULL,
  method TEXT NOT NULL CHECK(method IN ('live','historical','legacy','pending')),
  state TEXT NOT NULL CHECK(state IN ('ready','pending','exhausted')),
  config_version TEXT,
  rules_version TEXT,
  features TEXT,
  initial_features TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_retry_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS idx_quality_retry ON sample_quality(state, next_retry_at);
CREATE TABLE IF NOT EXISTS baseline_repairs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  repaired_at INTEGER NOT NULL,
  old_anchor_ts INTEGER NOT NULL,
  new_anchor_ts INTEGER NOT NULL,
  price TEXT NOT NULL,
  price_ts INTEGER NOT NULL,
  method TEXT NOT NULL,
  deviation_sec INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS outcome_quality (
  signal_id INTEGER NOT NULL REFERENCES signals(id) ON DELETE CASCADE,
  horizon TEXT NOT NULL,
  anchor_ts INTEGER NOT NULL,
  anchor_price TEXT NOT NULL,
  target_ts INTEGER NOT NULL,
  candle_close_ts INTEGER,
  recorded_at INTEGER NOT NULL,
  state TEXT NOT NULL,
  PRIMARY KEY(signal_id, horizon)
);
CREATE TABLE IF NOT EXISTS data_gaps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  from_ts INTEGER NOT NULL,
  to_ts INTEGER NOT NULL,
  opened_at INTEGER NOT NULL,
  closed_at INTEGER,
  state TEXT NOT NULL CHECK(state IN ('open','recovered','accepted'))
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_gap_open ON data_gaps(source) WHERE state='open';
CREATE INDEX IF NOT EXISTS idx_gap_interval ON data_gaps(from_ts,to_ts);

-- Independent research universe. Payloads contain private snapshots, never public report output.
CREATE TABLE IF NOT EXISTS research_runs (
  id INTEGER PRIMARY KEY, sampled_at INTEGER NOT NULL, version TEXT NOT NULL,
  universe INTEGER NOT NULL, selected INTEGER NOT NULL, strata TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS research_samples (
  id INTEGER PRIMARY KEY, run_id INTEGER NOT NULL REFERENCES research_runs(id),
  token TEXT NOT NULL, selected_at INTEGER NOT NULL, anchor_at INTEGER,
  stratum INTEGER NOT NULL, probability REAL NOT NULL,
  config_version TEXT NOT NULL, rules_version TEXT NOT NULL, research_version TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', baseline TEXT, price_at INTEGER,
  initial BLOB, frozen BLOB, diagnostics TEXT, error TEXT,
  UNIQUE(run_id,token)
);
CREATE INDEX IF NOT EXISTS idx_research_state ON research_samples(state,selected_at);
CREATE TABLE IF NOT EXISTS research_outcomes (
  sample_id INTEGER NOT NULL REFERENCES research_samples(id), horizon INTEGER NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending', ratio REAL, candle_at INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_at INTEGER NOT NULL,
  path TEXT, PRIMARY KEY(sample_id,horizon)
);
CREATE INDEX IF NOT EXISTS idx_research_outcomes_due ON research_outcomes(state,next_at);
CREATE TABLE IF NOT EXISTS research_experiments (
  id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, definition TEXT NOT NULL,
  boundary_id INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS research_delivery_frames (
  id INTEGER PRIMARY KEY, captured_at INTEGER NOT NULL, digest TEXT NOT NULL UNIQUE,
  frame BLOB, error TEXT
);
