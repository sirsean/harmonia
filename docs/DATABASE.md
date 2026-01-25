# Database Documentation

The Harmonia monitoring system uses SQLite to store historical monitoring data, NAV tracking, and position snapshots. This document describes the database setup, migrations, and usage.

## Overview

The monitoring database stores:
- **Monitoring snapshots**: Complete strategy status at each monitoring check
- **Position snapshots**: Detailed tracking of Uniswap LP and GMX hedge positions
- **NAV history**: Time series data for Net Asset Value tracking

## Database Location

By default, the database is stored at:
```
./data/monitoring.db
```

You can specify a custom path using the `--db-path` option when running the daemon:

```bash
harmonia daemon --db-path /path/to/custom/monitoring.db
```

## Automatic Setup

The database is automatically created and migrated when you first run the daemon or instantiate the `MonitoringDatabase` class. No manual setup is required.

```bash
# First run will create the database and apply migrations
harmonia daemon --network arbitrum
```

## Database Schema

### Tables

#### `monitoring_snapshots`
Stores complete strategy status at each monitoring check.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-incrementing snapshot ID |
| `timestamp` | INTEGER | Unix timestamp of the snapshot |
| `account` | TEXT | Ethereum account address |
| `total_nav_usd` | TEXT | Total Net Asset Value in USD (30 decimals, stored as string) |
| `total_lp_value_usd` | TEXT | Total LP position value in USD |
| `gmx_net_value_usd` | TEXT | GMX position net value in USD |
| `total_lp_delta` | TEXT | Total LP delta exposure (18 decimals) |
| `gmx_delta` | TEXT | GMX hedge delta (18 decimals) |
| `net_delta` | TEXT | Net delta (LP + GMX) |
| `delta_drift` | REAL | Delta drift percentage |
| `total_fees_usd` | TEXT | Total unclaimed fees in USD |
| `recommendation_action` | TEXT | Recommended action (NONE, REBALANCE, COMPOUND, ADJUST_RANGE) |
| `recommendation_reason` | TEXT | Reason for the recommendation |
| `created_at` | INTEGER | Record creation timestamp |

#### `position_snapshots`
Stores detailed position information for each snapshot.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-incrementing position ID |
| `snapshot_id` | INTEGER | Foreign key to `monitoring_snapshots.id` |
| `token_id` | TEXT | Token ID (Uniswap NFT ID or "gmx-hedge") |
| `position_type` | TEXT | Either "uniswap" or "gmx" |
| `liquidity` | TEXT | Liquidity amount (Uniswap only) |
| `tick_lower` | INTEGER | Lower tick (Uniswap only) |
| `tick_upper` | INTEGER | Upper tick (Uniswap only) |
| `current_price` | REAL | Current price at snapshot time |
| `price_lower` | REAL | Lower price bound (Uniswap only) |
| `price_upper` | REAL | Upper price bound (Uniswap only) |
| `delta` | TEXT | Position delta (18 decimals) |
| `delta_zone` | TEXT | Delta zone ("below", "in", "above") |
| `unclaimed_fees0` | TEXT | Unclaimed fees for token0 (Uniswap only) |
| `unclaimed_fees1` | TEXT | Unclaimed fees for token1 (Uniswap only) |
| `position_size_tokens` | TEXT | Position size in tokens (GMX only) |
| `collateral_amount` | TEXT | Collateral amount (GMX only) |

#### `nav_history`
Time series NAV tracking for analysis.

| Column | Type | Description |
|--------|------|-------------|
| `id` | INTEGER PRIMARY KEY | Auto-incrementing ID |
| `timestamp` | INTEGER | Unix timestamp |
| `account` | TEXT | Ethereum account address |
| `nav_usd` | TEXT | NAV in USD (30 decimals) |
| `created_at` | INTEGER | Record creation timestamp |

**Unique constraint**: `(timestamp, account)` - one NAV entry per account per timestamp

#### `schema_migrations`
Tracks applied database migrations.

| Column | Type | Description |
|--------|------|-------------|
| `version` | INTEGER PRIMARY KEY | Migration version number |
| `name` | TEXT | Migration name |
| `applied_at` | INTEGER | When migration was applied |

### Indexes

The following indexes are created for query performance:

- `idx_snapshots_timestamp` on `monitoring_snapshots(timestamp)`
- `idx_snapshots_account` on `monitoring_snapshots(account)`
- `idx_positions_snapshot_id` on `position_snapshots(snapshot_id)`
- `idx_positions_token_id` on `position_snapshots(token_id)`
- `idx_nav_history_timestamp` on `nav_history(timestamp)`
- `idx_nav_history_account` on `nav_history(account)`

## Migrations

The database uses a migration system to manage schema changes over time. Migrations are automatically applied when the database is initialized.

### Current Migrations

#### Migration 1: Initial Schema (v1)
Creates the initial database schema with all tables and indexes.

**Applied automatically** on first database initialization.

### Migration System

Migrations are defined in `src/utils/migrations.ts` and are applied automatically when:
- The database is first created
- The `MonitoringDatabase` class is instantiated

### Manual Migration Management

If you need to manually manage migrations (for example, in a script), you can use the migration functions:

```typescript
import Database from "better-sqlite3";
import { migrate, rollback, getCurrentVersion } from "./src/utils/migrations";

const db = new Database("./data/monitoring.db");

// Apply all pending migrations
migrate(db);

// Check current version
const version = getCurrentVersion(db);
console.log(`Current schema version: ${version}`);

// Rollback last migration (if supported)
rollback(db);

// Rollback to specific version
rollback(db, 0);
```

### Creating New Migrations

To add a new migration:

1. Add a new migration object to `src/utils/migrations.ts`:

```typescript
const migration002_your_feature: Migration = {
  version: 2,
  name: "your_feature",
  up: (db: Database.Database) => {
    // Add new table, column, index, etc.
    db.exec(`
      ALTER TABLE monitoring_snapshots
      ADD COLUMN new_field TEXT
    `);
  },
  down: (db: Database.Database) => {
    // Optional: rollback logic
    db.exec(`
      ALTER TABLE monitoring_snapshots
      DROP COLUMN new_field
    `);
  },
};

// Add to migrations array
export const migrations: Migration[] = [
  migration001_initial_schema,
  migration002_your_feature, // Add here
];
```

2. Migrations are automatically applied on next database initialization.

## Querying the Database

### Using the MonitoringDatabase Class

The `MonitoringDatabase` class provides methods for querying data:

```typescript
import { MonitoringDatabase } from "./src/utils/database";

const db = new MonitoringDatabase("./data/monitoring.db");

// Get latest snapshot
const snapshot = db.getLatestSnapshot("0x...");
console.log(`Latest NAV: $${snapshot?.totalNavUsd}`);

// Get NAV history
const history = db.getNavHistory("0x...", startTime, endTime);
history.forEach(entry => {
  console.log(`${new Date(entry.timestamp)}: $${entry.navUsd}`);
});

// Get statistics
const stats = db.getStatistics("0x...");
console.log(`Total snapshots: ${stats.snapshotCount}`);
console.log(`Min NAV: $${stats.minNav}`);
console.log(`Max NAV: $${stats.maxNav}`);
console.log(`Avg NAV: $${stats.avgNav}`);

// Get snapshots in time range
const snapshots = db.getSnapshots("0x...", startTime, endTime, limit);

// Get position snapshots for a snapshot
const positions = db.getPositionSnapshots(snapshotId);

db.close();
```

### Direct SQL Queries

You can also query the database directly using SQLite:

```bash
# Using sqlite3 CLI
sqlite3 data/monitoring.db

# Example queries
SELECT * FROM monitoring_snapshots ORDER BY timestamp DESC LIMIT 10;
SELECT * FROM nav_history WHERE account = '0x...' ORDER BY timestamp;
SELECT COUNT(*) FROM monitoring_snapshots WHERE account = '0x...';
```

## Database Maintenance

### Backup

To backup the database:

```bash
# Simple copy
cp data/monitoring.db data/monitoring.db.backup

# Using sqlite3
sqlite3 data/monitoring.db ".backup data/monitoring.db.backup"
```

### Vacuum (Optimize)

To optimize the database and reclaim space:

```bash
sqlite3 data/monitoring.db "VACUUM;"
```

Or programmatically:

```typescript
const db = new MonitoringDatabase("./data/monitoring.db");
db.getDb().exec("VACUUM;");
db.close();
```

### WAL Mode

The database uses WAL (Write-Ahead Logging) mode for better concurrency. This creates additional files:
- `monitoring.db-wal` - Write-ahead log
- `monitoring.db-shm` - Shared memory file

These files are automatically managed by SQLite and should not be manually edited.

## Troubleshooting

### Database Locked

If you encounter "database is locked" errors:
- Ensure only one process is accessing the database at a time
- Check for stale WAL files and remove them if needed
- Restart the daemon

### Migration Errors

If migrations fail:
1. Check the `schema_migrations` table to see which migrations were applied
2. Review migration logs/errors
3. Manually fix the schema if needed
4. Update the `schema_migrations` table accordingly

### Corrupted Database

If the database becomes corrupted:
1. Restore from backup if available
2. Or delete the database file and let it be recreated on next run
3. Note: This will lose all historical data

## Best Practices

1. **Regular Backups**: Back up the database regularly, especially before major operations
2. **Monitor Size**: The database can grow large over time. Consider archiving old data if needed
3. **Single Writer**: Only run one daemon instance per database file
4. **Migration Testing**: Test migrations on a copy of production data before applying
5. **Precision**: All monetary values are stored as strings to preserve BigInt precision

## Example: Analyzing NAV Trends

```typescript
import { MonitoringDatabase } from "./src/utils/database";

const db = new MonitoringDatabase();

// Get NAV history for last 24 hours
const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
const history = db.getNavHistory("0x...", oneDayAgo);

// Calculate daily return
if (history.length >= 2) {
  const startNav = BigInt(history[0].navUsd);
  const endNav = BigInt(history[history.length - 1].navUsd);
  const returnPct = Number((endNav - startNav) * 10000n / startNav) / 100;
  console.log(`24h return: ${returnPct.toFixed(2)}%`);
}

db.close();
```
