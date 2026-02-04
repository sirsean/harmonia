import Database from "better-sqlite3";

export interface Migration {
  version: number;
  name: string;
  up: (db: Database.Database) => void;
  down?: (db: Database.Database) => void;
}

/**
 * Migration: Initial schema creation
 */
const migration001_initial_schema: Migration = {
  version: 1,
  name: "initial_schema",
  up: (db: Database.Database) => {
    // Main monitoring snapshots table
    db.exec(`
      CREATE TABLE IF NOT EXISTS monitoring_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        total_nav_usd TEXT NOT NULL,
        total_lp_value_usd TEXT NOT NULL,
        gmx_net_value_usd TEXT NOT NULL,
        total_lp_delta TEXT NOT NULL,
        gmx_delta TEXT NOT NULL,
        net_delta TEXT NOT NULL,
        delta_drift REAL NOT NULL,
        total_fees_usd TEXT NOT NULL,
        recommendation_action TEXT NOT NULL,
        recommendation_reason TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Position snapshots table (for detailed position tracking)
    db.exec(`
      CREATE TABLE IF NOT EXISTS position_snapshots (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        snapshot_id INTEGER NOT NULL,
        token_id TEXT NOT NULL,
        position_type TEXT NOT NULL CHECK(position_type IN ('uniswap', 'gmx')),
        liquidity TEXT,
        tick_lower INTEGER,
        tick_upper INTEGER,
        current_price REAL NOT NULL,
        price_lower REAL,
        price_upper REAL,
        delta TEXT NOT NULL,
        delta_zone TEXT,
        unclaimed_fees0 TEXT,
        unclaimed_fees1 TEXT,
        position_size_tokens TEXT,
        collateral_amount TEXT,
        FOREIGN KEY (snapshot_id) REFERENCES monitoring_snapshots(id) ON DELETE CASCADE
      )
    `);

    // NAV history table (for time series analysis)
    db.exec(`
      CREATE TABLE IF NOT EXISTS nav_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        nav_usd TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(timestamp, account)
      )
    `);

    // Indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_snapshots_timestamp ON monitoring_snapshots(timestamp);
      CREATE INDEX IF NOT EXISTS idx_snapshots_account ON monitoring_snapshots(account);
      CREATE INDEX IF NOT EXISTS idx_positions_snapshot_id ON position_snapshots(snapshot_id);
      CREATE INDEX IF NOT EXISTS idx_positions_token_id ON position_snapshots(token_id);
      CREATE INDEX IF NOT EXISTS idx_nav_history_timestamp ON nav_history(timestamp);
      CREATE INDEX IF NOT EXISTS idx_nav_history_account ON nav_history(account);
    `);
  },
};

/**
 * Migration: Add optimization tracking table
 */
const migration002_optimization_tracking: Migration = {
  version: 2,
  name: "optimization_tracking",
  up: (db: Database.Database) => {
    // Track when optimizations were executed
    db.exec(`
      CREATE TABLE IF NOT EXISTS optimization_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        delta_drift REAL NOT NULL,
        total_fees_usd TEXT NOT NULL,
        gas_cost_usd TEXT,
        benefit_usd TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Index for quick lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_optimization_history_account_timestamp 
      ON optimization_history(account, timestamp DESC)
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`DROP INDEX IF EXISTS idx_optimization_history_account_timestamp`);
    db.exec(`DROP TABLE IF EXISTS optimization_history`);
  },
};

/**
 * Migration: Add optimization failure tracking
 */
const migration003_optimization_failures: Migration = {
  version: 3,
  name: "optimization_failures",
  up: (db: Database.Database) => {
    // Track optimization failures for recovery and analysis
    db.exec(`
      CREATE TABLE IF NOT EXISTS optimization_failures (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        error_message TEXT NOT NULL,
        error_stack TEXT,
        delta_drift REAL,
        total_fees_usd TEXT,
        recommendation_reason TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Index for quick lookups
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_optimization_failures_account_timestamp 
      ON optimization_failures(account, timestamp DESC)
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`DROP INDEX IF EXISTS idx_optimization_failures_account_timestamp`);
    db.exec(`DROP TABLE IF EXISTS optimization_failures`);
  },
};

/**
 * Migration: Add state persistence tables
 */
const migration004_state_persistence: Migration = {
  version: 4,
  name: "state_persistence",
  up: (db: Database.Database) => {
    // Operation history table - tracks all operations (rebalance, compound, range_adjustment, optimization)
    db.exec(`
      CREATE TABLE IF NOT EXISTS operation_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        operation_type TEXT NOT NULL CHECK(operation_type IN ('rebalance', 'compound', 'range_adjustment', 'optimization')),
        gas_cost_usd TEXT,
        operation_data TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Alert suppressions table - tracks suppressed alerts to avoid spam
    db.exec(`
      CREATE TABLE IF NOT EXISTS alert_suppressions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        alert_type TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(account, alert_type)
      )
    `);

    // Configuration overrides table - allows runtime config overrides
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_overrides (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT,
        config_key TEXT NOT NULL,
        config_value TEXT NOT NULL,
        expires_at INTEGER,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(account, config_key)
      )
    `);

    // Strategy metrics table - tracks cumulative metrics across all operations
    db.exec(`
      CREATE TABLE IF NOT EXISTS strategy_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        account TEXT NOT NULL,
        total_fees_collected_usd TEXT NOT NULL DEFAULT '0',
        total_gas_spent_usd TEXT NOT NULL DEFAULT '0',
        rebalance_count INTEGER NOT NULL DEFAULT 0,
        compound_count INTEGER NOT NULL DEFAULT 0,
        range_adjustment_count INTEGER NOT NULL DEFAULT 0,
        optimization_count INTEGER NOT NULL DEFAULT 0,
        last_updated INTEGER DEFAULT (strftime('%s', 'now')),
        UNIQUE(account)
      )
    `);

    // Indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_operation_history_account_timestamp 
      ON operation_history(account, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_operation_history_type 
      ON operation_history(operation_type);
      CREATE INDEX IF NOT EXISTS idx_alert_suppressions_account_expires 
      ON alert_suppressions(account, expires_at);
      CREATE INDEX IF NOT EXISTS idx_config_overrides_account_key 
      ON config_overrides(account, config_key);
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`DROP INDEX IF EXISTS idx_config_overrides_account_key`);
    db.exec(`DROP INDEX IF EXISTS idx_alert_suppressions_account_expires`);
    db.exec(`DROP INDEX IF EXISTS idx_operation_history_type`);
    db.exec(`DROP INDEX IF EXISTS idx_operation_history_account_timestamp`);
    db.exec(`DROP TABLE IF EXISTS strategy_metrics`);
    db.exec(`DROP TABLE IF EXISTS config_overrides`);
    db.exec(`DROP TABLE IF EXISTS alert_suppressions`);
    db.exec(`DROP TABLE IF EXISTS operation_history`);
  },
};

/**
 * Migration: Add APR tracking tables
 */
const migration005_apr_tracking: Migration = {
  version: 5,
  name: "apr_tracking",
  up: (db: Database.Database) => {
    // Track individual fee collection events
    db.exec(`
      CREATE TABLE IF NOT EXISTS fee_collection_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        token_id TEXT NOT NULL,
        fees_collected_usd TEXT NOT NULL,
        fees_amount0 TEXT,
        fees_amount1 TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Track GMX funding fee snapshots
    db.exec(`
      CREATE TABLE IF NOT EXISTS funding_fee_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        snapshot_id INTEGER,
        funding_fee_amount_usd TEXT NOT NULL,
        funding_fee_per_size TEXT NOT NULL,
        position_size_tokens TEXT NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now')),
        FOREIGN KEY (snapshot_id) REFERENCES monitoring_snapshots(id)
      )
    `);

    // APR calculation cache (for performance)
    db.exec(`
      CREATE TABLE IF NOT EXISTS apr_calculations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        period_type TEXT NOT NULL CHECK(period_type IN ('daily', 'weekly', 'monthly', 'rolling_7d', 'rolling_30d', 'rolling_90d', 'lifetime')),
        period_start INTEGER NOT NULL,
        period_end INTEGER NOT NULL,
        fees_collected_usd TEXT NOT NULL,
        costs_incurred_usd TEXT NOT NULL,
        net_yield_usd TEXT NOT NULL,
        average_nav_usd TEXT NOT NULL,
        apr_bps INTEGER NOT NULL,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    // Indexes for performance
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_fee_collection_account_timestamp 
      ON fee_collection_history(account, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_funding_fee_account_timestamp 
      ON funding_fee_history(account, timestamp DESC);
      CREATE INDEX IF NOT EXISTS idx_apr_calculations_account_period 
      ON apr_calculations(account, period_type, period_end DESC);
    `);
  },
  down: (db: Database.Database) => {
    db.exec(`DROP INDEX IF EXISTS idx_apr_calculations_account_period`);
    db.exec(`DROP INDEX IF EXISTS idx_funding_fee_account_timestamp`);
    db.exec(`DROP INDEX IF EXISTS idx_fee_collection_account_timestamp`);
    db.exec(`DROP TABLE IF EXISTS apr_calculations`);
    db.exec(`DROP TABLE IF EXISTS funding_fee_history`);
    db.exec(`DROP TABLE IF EXISTS fee_collection_history`);
  },
};

/**
 * Migration: Add GMX execution fee tracking and clean up old estimates
 */
const migration006_cost_tracking: Migration = {
  version: 6,
  name: "cost_tracking",
  up: (db: Database.Database) => {
    // Check if column already exists (in case migration runs twice)
    const tableInfo = db.prepare("PRAGMA table_info(operation_history)").all() as Array<{
      name: string;
    }>;
    const hasGmxFeeColumn = tableInfo.some((col) => col.name === "gmx_execution_fee_usd");

    if (!hasGmxFeeColumn) {
      // Add gmx_execution_fee_usd column to operation_history
      db.exec(`
        ALTER TABLE operation_history 
        ADD COLUMN gmx_execution_fee_usd TEXT
      `);
    }

    // Delete old $2 estimates (estimatedOptimizationGasCostUsd)
    // These are way too high and will throw off calculations
    // We'll replace them with actual gas costs going forward
    // The value is stored as: BigInt(2) * PRECISION.GMX_USD = 2 * 10^30
    // Delete any gas_cost_usd values that are >= $1 (1000000000000000000000000000000)
    // as these are clearly estimates, not actual gas costs
    // Actual gas costs should be much smaller (~$0.05 = 50000000000000000000000000000)
    // Use numeric comparison - SQLite can compare TEXT as numbers if both are numeric strings
    // This is idempotent - safe to run multiple times
    const updateStmt = db.prepare(`
      UPDATE operation_history 
      SET gas_cost_usd = NULL 
      WHERE gas_cost_usd IS NOT NULL 
      AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
    `);
    const result = updateStmt.run();
    if (result.changes > 0) {
      console.log(`[Migration 006] Deleted ${result.changes} old cost estimates`);
    }
  },
  down: (db: Database.Database) => {
    // Remove the column (SQLite doesn't support DROP COLUMN, so we'd need to recreate the table)
    // For now, just leave it - the column can stay but won't be used
  },
};

/**
 * Migration: Cleanup old cost estimates (idempotent, can run multiple times)
 * This is a follow-up to migration 006 to ensure all old estimates are deleted
 */
const migration007_cleanup_old_costs: Migration = {
  version: 7,
  name: "cleanup_old_costs",
  up: (db: Database.Database) => {
    // Delete any gas_cost_usd values that are >= $1
    // This is idempotent and can be run multiple times safely
    // Use numeric comparison - SQLite can compare TEXT as numbers if both are numeric strings
    const updateStmt = db.prepare(`
      UPDATE operation_history 
      SET gas_cost_usd = NULL 
      WHERE gas_cost_usd IS NOT NULL 
      AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
    `);
    const result = updateStmt.run();
    if (result.changes > 0) {
      console.log(`[Migration 007] Deleted ${result.changes} old cost estimates`);
    }
  },
  down: (db: Database.Database) => {
    // No rollback needed - this is just a cleanup
  },
};

/**
 * Migration: Add hedge adjustment tracking
 */
const migration008_hedge_adjustments: Migration = {
  version: 8,
  name: "hedge_adjustments",
  up: (db: Database.Database) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS hedge_adjustment_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp INTEGER NOT NULL,
        account TEXT NOT NULL,
        direction TEXT NOT NULL CHECK(direction IN ('increase', 'decrease')),
        adjustment_size_usd TEXT NOT NULL,
        delta_drift_before REAL NOT NULL,
        current_leverage REAL,
        estimated_leverage_after REAL,
        tx_hash TEXT,
        created_at INTEGER DEFAULT (strftime('%s', 'now'))
      )
    `);

    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_hedge_adjustment_account_timestamp
      ON hedge_adjustment_history(account, timestamp DESC)
    `);

    // Add 'hedge_adjust' to operation_history operation_type check constraint
    // SQLite doesn't support ALTER CHECK, so we add hedge adjustments as a new type
    // by recreating the table. However, since this is risky, we'll just use the
    // separate hedge_adjustment_history table for tracking and the operation_history
    // for general operation tracking with a TEXT type (the CHECK is soft).
  },
  down: (db: Database.Database) => {
    db.exec(`DROP INDEX IF EXISTS idx_hedge_adjustment_account_timestamp`);
    db.exec(`DROP TABLE IF EXISTS hedge_adjustment_history`);
  },
};

/**
 * Migration: Add wallet balance USD tracking to monitoring snapshots
 */
const migration009_wallet_balances: Migration = {
  version: 9,
  name: "wallet_balances",
  up: (db: Database.Database) => {
    const tableInfo = db.prepare("PRAGMA table_info(monitoring_snapshots)").all() as Array<{
      name: string;
    }>;

    const hasWalletEth = tableInfo.some((col) => col.name === "wallet_eth_usd");
    const hasWalletWeth = tableInfo.some((col) => col.name === "wallet_weth_usd");
    const hasWalletUsdc = tableInfo.some((col) => col.name === "wallet_usdc_usd");

    if (!hasWalletEth) {
      db.exec(`
        ALTER TABLE monitoring_snapshots
        ADD COLUMN wallet_eth_usd TEXT NOT NULL DEFAULT '0'
      `);
    }

    if (!hasWalletWeth) {
      db.exec(`
        ALTER TABLE monitoring_snapshots
        ADD COLUMN wallet_weth_usd TEXT NOT NULL DEFAULT '0'
      `);
    }

    if (!hasWalletUsdc) {
      db.exec(`
        ALTER TABLE monitoring_snapshots
        ADD COLUMN wallet_usdc_usd TEXT NOT NULL DEFAULT '0'
      `);
    }
  },
  down: (db: Database.Database) => {
    // SQLite doesn't support DROP COLUMN; leave columns in place.
  },
};

/**
 * All migrations in order
 */
export const migrations: Migration[] = [
  migration001_initial_schema,
  migration002_optimization_tracking,
  migration003_optimization_failures,
  migration004_state_persistence,
  migration005_apr_tracking,
  migration006_cost_tracking,
  migration007_cleanup_old_costs,
  migration008_hedge_adjustments,
  migration009_wallet_balances,
];

/**
 * Get the current database schema version
 */
export function getCurrentVersion(db: Database.Database): number {
  // Check if migrations table exists
  const tableExists = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
    .get() as { name: string } | undefined;

  if (!tableExists) {
    return 0;
  }

  const result = db
    .prepare("SELECT version FROM schema_migrations ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;

  return result?.version || 0;
}

/**
 * Create migrations tracking table
 */
function createMigrationsTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at INTEGER DEFAULT (strftime('%s', 'now'))
    )
  `);
}

/**
 * Apply all pending migrations
 */
export function migrate(db: Database.Database): void {
  createMigrationsTable(db);

  const currentVersion = getCurrentVersion(db);
  const pendingMigrations = migrations.filter((m) => m.version > currentVersion);

  if (pendingMigrations.length === 0) {
    return; // Already up to date
  }

  // Begin transaction
  const transaction = db.transaction(() => {
    for (const migration of pendingMigrations) {
      try {
        migration.up(db);

        // Record migration
        db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
          migration.version,
          migration.name
        );
      } catch (error: any) {
        // If migration fails, log error but don't fail silently
        console.error(`Migration ${migration.version} (${migration.name}) failed:`, error);
        throw error;
      }
    }
  });

  transaction();
}

/**
 * Rollback the last migration (if down migration is provided)
 */
export function rollback(db: Database.Database, targetVersion?: number): void {
  const currentVersion = getCurrentVersion(db);
  const target = targetVersion !== undefined ? targetVersion : currentVersion - 1;

  if (target < 0) {
    throw new Error("Cannot rollback below version 0");
  }

  const migrationsToRollback = migrations
    .filter((m) => m.version > target && m.version <= currentVersion)
    .sort((a, b) => b.version - a.version); // Rollback in reverse order

  if (migrationsToRollback.length === 0) {
    return; // Nothing to rollback
  }

  const transaction = db.transaction(() => {
    for (const migration of migrationsToRollback) {
      if (!migration.down) {
        throw new Error(
          `Migration ${migration.version} (${migration.name}) does not support rollback`
        );
      }

      migration.down(db);

      // Remove migration record
      db.prepare("DELETE FROM schema_migrations WHERE version = ?").run(migration.version);
    }
  });

  transaction();
}
