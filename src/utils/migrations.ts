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
 * All migrations in order
 */
export const migrations: Migration[] = [
  migration001_initial_schema,
  migration002_optimization_tracking,
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
      migration.up(db);

      // Record migration
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        migration.version,
        migration.name
      );
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
