-- All money is stored in integer cents. All ids are client-generated UUIDs so
-- rows can be created offline and merged later. Every synced table carries
-- household_id, updated_at (ms epoch) and deleted (soft delete) for sync.

CREATE TABLE IF NOT EXISTS households (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  household_id TEXT NOT NULL REFERENCES households(id),
  created_at INTEGER NOT NULL
);

-- type: checking | savings | cash | credit | loan
-- on_budget: cash + credit accounts count toward "Ready to Assign"; loans don't.
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  on_budget INTEGER NOT NULL DEFAULT 1,
  closed INTEGER NOT NULL DEFAULT 0,
  reconciled_balance INTEGER NOT NULL DEFAULT 0,
  reconciled_at INTEGER,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS category_groups (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS categories (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  group_id TEXT NOT NULL,
  name TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- One row per category per month. month is 'YYYY-MM'. "Hold for next month"
-- is simply a row with a future month and an assigned amount.
CREATE TABLE IF NOT EXISTS budget_months (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  category_id TEXT NOT NULL,
  month TEXT NOT NULL,
  assigned INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS bm_slot ON budget_months(household_id, category_id, month);

-- amount: negative = outflow, positive = inflow.
-- transfer_id: set on BOTH legs of a transfer (e.g. a credit card payment).
--   Transfer legs have category_id NULL and never touch the budget.
-- category_id NULL on a non-transfer = "inflow: ready to assign" or uncategorized.
-- cleared: 0 pending, 1 cleared, 2 reconciled (locked).
-- tip_pending (added in db.js): cents of a tip included in amount that the bank hasn't posted yet.
CREATE TABLE IF NOT EXISTS transactions (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  date TEXT NOT NULL,
  payee TEXT NOT NULL DEFAULT '',
  category_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  cleared INTEGER NOT NULL DEFAULT 0,
  transfer_id TEXT,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
  -- added later by db.js: split_id, created_by, tip_pending, bank_ref, created_at (entry time, ms)
);
CREATE INDEX IF NOT EXISTS tx_account ON transactions(account_id, date);
CREATE INDEX IF NOT EXISTS tx_category ON transactions(category_id, date);

-- Append-only log used for sync. Clients pull rows with seq > their cursor.
CREATE TABLE IF NOT EXISTS change_log (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  household_id TEXT NOT NULL,
  tbl TEXT NOT NULL,
  row_id TEXT NOT NULL,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS log_hh ON change_log(household_id, seq);

-- v0.4.0 ---------------------------------------------------------------
-- Recurring transactions. amount sign as usual; transfer_to set = transfer.
-- frequency: weekly | biweekly | monthly | yearly. next_date = next due 'YYYY-MM-DD'.
CREATE TABLE IF NOT EXISTS scheduled (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  account_id TEXT NOT NULL,
  transfer_to TEXT,
  payee TEXT NOT NULL DEFAULT '',
  category_id TEXT,
  memo TEXT NOT NULL DEFAULT '',
  amount INTEGER NOT NULL,
  frequency TEXT NOT NULL DEFAULT 'monthly',
  next_date TEXT NOT NULL,
  auto INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- Payee cleanup rules: if lower(raw payee) contains `match`, rename to `payee`
-- and (optionally) default the category.
CREATE TABLE IF NOT EXISTS payee_rules (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  match TEXT NOT NULL,
  payee TEXT NOT NULL,
  category_id TEXT,
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);

-- v1.0 ------------------------------------------------------------------
-- Small synced key/value settings for the household (e.g. closed_through = '2026-10').
CREATE TABLE IF NOT EXISTS household_prefs (
  id TEXT PRIMARY KEY,            -- the key
  household_id TEXT NOT NULL,
  value TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0
);
-- Web push subscriptions (server only, not synced).
CREATE TABLE IF NOT EXISTS push_subs (
  id TEXT PRIMARY KEY,
  household_id TEXT NOT NULL,
  email TEXT NOT NULL,
  sub TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
-- Nightly integrity results.
CREATE TABLE IF NOT EXISTS integrity (
  household_id TEXT PRIMARY KEY,
  at INTEGER NOT NULL,
  ok INTEGER NOT NULL,
  detail TEXT NOT NULL
);
