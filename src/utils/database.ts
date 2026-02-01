import Database from "better-sqlite3";
import { StrategyStatus, Recommendation } from "../strategy/types";
import path from "path";
import fs from "fs";
import { migrate } from "./migrations";

export interface MonitoringSnapshot {
  id: number;
  timestamp: number;
  account: string;
  totalNavUsd: string; // Stored as string to preserve precision
  totalLpValueUsd: string;
  gmxNetValueUsd: string;
  totalLpDelta: string;
  gmxDelta: string;
  netDelta: string;
  deltaDrift: number;
  totalFeesUsd: string;
  recommendationAction: string;
  recommendationReason: string;
}

export interface PositionSnapshot {
  id: number;
  snapshotId: number;
  tokenId: string;
  positionType: "uniswap" | "gmx";
  liquidity?: string;
  tickLower?: number;
  tickUpper?: number;
  currentPrice: number;
  priceLower?: number;
  priceUpper?: number;
  delta: string;
  deltaZone?: string;
  unclaimedFees0?: string;
  unclaimedFees1?: string;
  positionSizeTokens?: string;
  collateralAmount?: string;
}

export interface NavHistory {
  timestamp: number;
  navUsd: string;
}

/**
 * Database service for storing monitoring data
 */
export class MonitoringDatabase {
  private db: Database.Database;

  constructor(dbPath?: string) {
    const defaultPath = path.join(process.cwd(), "data", "monitoring.db");
    const finalPath = dbPath || defaultPath;

    // Ensure directory exists (avoid race with parallel test cleanup)
    const dir = path.dirname(finalPath);
    fs.mkdirSync(dir, { recursive: true });

    this.db = new Database(finalPath);
    this.db.pragma("journal_mode = WAL"); // Better concurrency
    this.db.pragma("foreign_keys = ON"); // Enforce foreign key constraints

    // Run migrations to ensure schema is up to date
    migrate(this.db);
  }

  /**
   * Store a monitoring snapshot
   */
  storeSnapshot(
    account: string,
    status: StrategyStatus,
    recommendation: Recommendation,
    totalLpValueUsd: bigint,
    totalFeesUsd: bigint
  ): number {
    const timestamp = status.timestamp || Date.now();
    const totalNavUsd = totalLpValueUsd + status.gmx.netValueUsd;

    const insertSnapshot = this.db.prepare(`
      INSERT INTO monitoring_snapshots (
        timestamp, account, total_nav_usd, total_lp_value_usd, gmx_net_value_usd,
        total_lp_delta, gmx_delta, net_delta, delta_drift, total_fees_usd,
        recommendation_action, recommendation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insertSnapshot.run(
      timestamp,
      account,
      totalNavUsd.toString(),
      totalLpValueUsd.toString(),
      status.gmx.netValueUsd.toString(),
      status.totalLpDelta.toString(),
      status.gmx.delta.toString(),
      status.netDelta.toString(),
      status.deltaDrift,
      totalFeesUsd.toString(),
      recommendation.action,
      recommendation.reason
    );

    const snapshotId = Number(result.lastInsertRowid);

    // Store Uniswap positions
    for (const pos of status.uniswap) {
      const insertPosition = this.db.prepare(`
        INSERT INTO position_snapshots (
          snapshot_id, token_id, position_type, liquidity, tick_lower, tick_upper,
          current_price, price_lower, price_upper, delta, delta_zone,
          unclaimed_fees0, unclaimed_fees1
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);

      insertPosition.run(
        snapshotId,
        pos.tokenId,
        "uniswap",
        pos.liquidity.toString(),
        pos.tickLower,
        pos.tickUpper,
        pos.currentPrice,
        pos.priceLower,
        pos.priceUpper,
        pos.delta.delta.toString(),
        pos.delta.zone,
        pos.unclaimedFees.amount0.toString(),
        pos.unclaimedFees.amount1.toString()
      );
    }

    // Store GMX position
    const insertGmxPosition = this.db.prepare(`
      INSERT INTO position_snapshots (
        snapshot_id, token_id, position_type, current_price, delta,
        position_size_tokens, collateral_amount
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    insertGmxPosition.run(
      snapshotId,
      "gmx-hedge",
      "gmx",
      0, // GMX doesn't have a price in the same sense
      status.gmx.delta.toString(),
      status.gmx.positionSizeTokens.toString(),
      status.gmx.collateralAmount.toString()
    );

    // Store NAV history entry
    const insertNav = this.db.prepare(`
      INSERT OR REPLACE INTO nav_history (timestamp, account, nav_usd)
      VALUES (?, ?, ?)
    `);

    insertNav.run(timestamp, account, totalNavUsd.toString());

    // Record funding fee snapshot if GMX position exists
    // Note: pendingFundingRewards is shortTokenClaimableFundingAmountPerSize
    // For shorts, this is typically negative (we pay funding), positive means we receive funding
    if (status.gmx.positionSizeTokens > 0n) {
      const fundingFeePerSize = status.gmx.pendingFundingRewards || 0n;
      // Record the funding fee per size - actual costs will be calculated from deltas
      this.recordFundingFee(
        account,
        snapshotId,
        0n, // Will be calculated from deltas between snapshots
        fundingFeePerSize,
        status.gmx.positionSizeTokens
      );
    }

    return snapshotId;
  }

  /**
   * Get latest snapshot for an account
   */
  getLatestSnapshot(account: string): MonitoringSnapshot | null {
    const stmt = this.db.prepare(`
      SELECT * FROM monitoring_snapshots
      WHERE account = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = stmt.get(account) as any;
    if (!row) return null;

    return {
      id: row.id,
      timestamp: row.timestamp,
      account: row.account,
      totalNavUsd: row.total_nav_usd,
      totalLpValueUsd: row.total_lp_value_usd,
      gmxNetValueUsd: row.gmx_net_value_usd,
      totalLpDelta: row.total_lp_delta,
      gmxDelta: row.gmx_delta,
      netDelta: row.net_delta,
      deltaDrift: row.delta_drift,
      totalFeesUsd: row.total_fees_usd,
      recommendationAction: row.recommendation_action,
      recommendationReason: row.recommendation_reason,
    };
  }

  /**
   * Get NAV history for an account within a time range
   */
  getNavHistory(account: string, startTime?: number, endTime?: number): NavHistory[] {
    let query = `
      SELECT timestamp, nav_usd FROM nav_history
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    query += " ORDER BY timestamp ASC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      timestamp: row.timestamp,
      navUsd: row.nav_usd,
    }));
  }

  /**
   * Get position snapshots for a given snapshot ID
   */
  getPositionSnapshots(snapshotId: number): PositionSnapshot[] {
    const stmt = this.db.prepare(`
      SELECT * FROM position_snapshots
      WHERE snapshot_id = ?
      ORDER BY position_type, token_id
    `);

    const rows = stmt.all(snapshotId) as any[];

    return rows.map((row) => ({
      id: row.id,
      snapshotId: row.snapshot_id,
      tokenId: row.token_id,
      positionType: row.position_type,
      liquidity: row.liquidity,
      tickLower: row.tick_lower,
      tickUpper: row.tick_upper,
      currentPrice: row.current_price,
      priceLower: row.price_lower,
      priceUpper: row.price_upper,
      delta: row.delta,
      deltaZone: row.delta_zone,
      unclaimedFees0: row.unclaimed_fees0,
      unclaimedFees1: row.unclaimed_fees1,
      positionSizeTokens: row.position_size_tokens,
      collateralAmount: row.collateral_amount,
    }));
  }

  /**
   * Get snapshots within a time range
   */
  getSnapshots(
    account: string,
    startTime?: number,
    endTime?: number,
    limit?: number
  ): MonitoringSnapshot[] {
    let query = `
      SELECT * FROM monitoring_snapshots
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    query += " ORDER BY timestamp DESC";

    if (limit !== undefined) {
      query += " LIMIT ?";
      params.push(limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as any[];

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      account: row.account,
      totalNavUsd: row.total_nav_usd,
      totalLpValueUsd: row.total_lp_value_usd,
      gmxNetValueUsd: row.gmx_net_value_usd,
      totalLpDelta: row.total_lp_delta,
      gmxDelta: row.gmx_delta,
      netDelta: row.net_delta,
      deltaDrift: row.delta_drift,
      totalFeesUsd: row.total_fees_usd,
      recommendationAction: row.recommendation_action,
      recommendationReason: row.recommendation_reason,
    }));
  }

  /**
   * Get statistics for an account
   */
  getStatistics(
    account: string,
    startTime?: number,
    endTime?: number
  ): {
    snapshotCount: number;
    firstSnapshot: number | null;
    lastSnapshot: number | null;
    minNav: string | null;
    maxNav: string | null;
    avgNav: string | null;
  } {
    let query = `
      SELECT 
        COUNT(*) as count,
        MIN(timestamp) as first_timestamp,
        MAX(timestamp) as last_timestamp
      FROM monitoring_snapshots
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    const stmt = this.db.prepare(query);
    const row = stmt.get(...params) as any;

    // Get min/max/avg NAV by querying all snapshots and calculating in JavaScript
    // This preserves precision for bigint values
    let navQuery = `
      SELECT total_nav_usd
      FROM monitoring_snapshots
      WHERE account = ?
    `;
    const navParams: any[] = [account];

    if (startTime !== undefined) {
      navQuery += " AND timestamp >= ?";
      navParams.push(startTime);
    }

    if (endTime !== undefined) {
      navQuery += " AND timestamp <= ?";
      navParams.push(endTime);
    }

    const navStmt = this.db.prepare(navQuery);
    const navRows = navStmt.all(...navParams) as Array<{ total_nav_usd: string }>;

    let minNav: string | null = null;
    let maxNav: string | null = null;
    let sumNav = 0n;
    let countNav = 0;

    for (const navRow of navRows) {
      const navValue = BigInt(navRow.total_nav_usd);
      if (minNav === null || navValue < BigInt(minNav)) {
        minNav = navRow.total_nav_usd;
      }
      if (maxNav === null || navValue > BigInt(maxNav)) {
        maxNav = navRow.total_nav_usd;
      }
      sumNav += navValue;
      countNav++;
    }

    const avgNav = countNav > 0 ? (sumNav / BigInt(countNav)).toString() : null;

    return {
      snapshotCount: row.count || 0,
      firstSnapshot: row.first_timestamp || null,
      lastSnapshot: row.last_timestamp || null,
      minNav,
      maxNav,
      avgNav,
    };
  }

  /**
   * Record an optimization execution
   */
  recordOptimization(
    account: string,
    deltaDrift: number,
    totalFeesUsd: bigint,
    gasCostUsd?: bigint,
    benefitUsd?: bigint
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO optimization_history (
        timestamp, account, delta_drift, total_fees_usd, gas_cost_usd, benefit_usd
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      timestamp,
      account,
      deltaDrift,
      totalFeesUsd.toString(),
      gasCostUsd?.toString() || null,
      benefitUsd?.toString() || null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get the timestamp of the last optimization for an account
   * @returns Timestamp in milliseconds, or undefined if never optimized
   */
  getLastOptimizationTime(account: string): number | undefined {
    const stmt = this.db.prepare(`
      SELECT timestamp FROM optimization_history
      WHERE account = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = stmt.get(account) as { timestamp: number } | undefined;
    return row?.timestamp;
  }

  /**
   * Record an optimization failure
   */
  recordOptimizationFailure(
    account: string,
    errorMessage: string,
    errorStack?: string,
    deltaDrift?: number,
    totalFeesUsd?: bigint,
    recommendationReason?: string
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO optimization_failures (
        timestamp, account, error_message, error_stack, delta_drift, total_fees_usd, recommendation_reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      timestamp,
      account,
      errorMessage,
      errorStack || null,
      deltaDrift !== undefined ? deltaDrift : null,
      totalFeesUsd?.toString() || null,
      recommendationReason || null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get recent optimization failures for an account
   * @param account Account address
   * @param limit Maximum number of failures to return
   * @returns Array of failure records
   */
  getRecentOptimizationFailures(
    account: string,
    limit: number = 10
  ): Array<{
    id: number;
    timestamp: number;
    errorMessage: string;
    errorStack?: string;
    deltaDrift?: number;
    totalFeesUsd?: string;
    recommendationReason?: string;
  }> {
    const stmt = this.db.prepare(`
      SELECT id, timestamp, error_message, error_stack, delta_drift, total_fees_usd, recommendation_reason
      FROM optimization_failures
      WHERE account = ?
      ORDER BY timestamp DESC
      LIMIT ?
    `);

    const rows = stmt.all(account, limit) as Array<{
      id: number;
      timestamp: number;
      error_message: string;
      error_stack?: string;
      delta_drift?: number;
      total_fees_usd?: string;
      recommendation_reason?: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      errorMessage: row.error_message,
      errorStack: row.error_stack,
      deltaDrift: row.delta_drift,
      totalFeesUsd: row.total_fees_usd,
      recommendationReason: row.recommendation_reason,
    }));
  }

  /**
   * Close database connection
   */
  close(): void {
    this.db.close();
  }

  /**
   * Record an operation (rebalance, compound, range_adjustment, or optimization)
   */
  recordOperation(
    account: string,
    operationType: "rebalance" | "compound" | "range_adjustment" | "optimization",
    gasCostUsd?: bigint,
    operationData?: Record<string, any>,
    gmxExecutionFeeUsd?: bigint
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO operation_history (
        timestamp, account, operation_type, gas_cost_usd, gmx_execution_fee_usd, operation_data
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      timestamp,
      account,
      operationType,
      gasCostUsd?.toString() || null,
      gmxExecutionFeeUsd?.toString() || null,
      operationData ? JSON.stringify(operationData) : null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get the timestamp of the last operation of a specific type for an account
   */
  getLastOperationTime(
    account: string,
    operationType: "rebalance" | "compound" | "range_adjustment" | "optimization"
  ): number | undefined {
    const stmt = this.db.prepare(`
      SELECT timestamp FROM operation_history
      WHERE account = ? AND operation_type = ?
      ORDER BY timestamp DESC
      LIMIT 1
    `);

    const row = stmt.get(account, operationType) as { timestamp: number } | undefined;
    return row?.timestamp;
  }

  /**
   * Get operation history for an account
   */
  getOperationHistory(
    account: string,
    operationType?: "rebalance" | "compound" | "range_adjustment" | "optimization",
    limit?: number
  ): Array<{
    id: number;
    timestamp: number;
    operationType: string;
    gasCostUsd?: string;
    gmxExecutionFeeUsd?: string;
    operationData?: Record<string, any>;
  }> {
    let query = `
      SELECT id, timestamp, operation_type, gas_cost_usd, gmx_execution_fee_usd, operation_data
      FROM operation_history
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (operationType) {
      query += " AND operation_type = ?";
      params.push(operationType);
    }

    query += " ORDER BY timestamp DESC, id DESC";

    if (limit !== undefined) {
      query += " LIMIT ?";
      params.push(limit);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      id: number;
      timestamp: number;
      operation_type: string;
      gas_cost_usd?: string;
      gmx_execution_fee_usd?: string;
      operation_data?: string;
    }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      operationType: row.operation_type,
      gasCostUsd: row.gas_cost_usd || undefined,
      gmxExecutionFeeUsd: row.gmx_execution_fee_usd || undefined,
      operationData: row.operation_data ? JSON.parse(row.operation_data) : undefined,
    }));
  }

  /**
   * Suppress an alert for a specific duration
   */
  suppressAlert(account: string, alertType: string, durationSeconds: number): void {
    const expiresAt = Date.now() + durationSeconds * 1000;
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO alert_suppressions (account, alert_type, expires_at)
      VALUES (?, ?, ?)
    `);

    insert.run(account, alertType, expiresAt);
  }

  /**
   * Check if an alert is currently suppressed
   */
  isAlertSuppressed(account: string, alertType: string): boolean {
    const stmt = this.db.prepare(`
      SELECT expires_at FROM alert_suppressions
      WHERE account = ? AND alert_type = ?
    `);

    const row = stmt.get(account, alertType) as { expires_at: number } | undefined;
    if (!row) {
      return false;
    }

    // Check if suppression has expired
    if (Date.now() > row.expires_at) {
      // Clean up expired suppression
      const deleteStmt = this.db.prepare(`
        DELETE FROM alert_suppressions
        WHERE account = ? AND alert_type = ?
      `);
      deleteStmt.run(account, alertType);
      return false;
    }

    return true;
  }

  /**
   * Clear all suppressed alerts for an account (or specific alert type)
   */
  clearSuppressedAlerts(account: string, alertType?: string): void {
    if (alertType) {
      const stmt = this.db.prepare(`
        DELETE FROM alert_suppressions
        WHERE account = ? AND alert_type = ?
      `);
      stmt.run(account, alertType);
    } else {
      const stmt = this.db.prepare(`
        DELETE FROM alert_suppressions
        WHERE account = ?
      `);
      stmt.run(account);
    }
  }

  /**
   * Set a configuration override
   */
  setConfigOverride(
    account: string | null,
    configKey: string,
    configValue: any,
    expiresAt?: number
  ): void {
    const insert = this.db.prepare(`
      INSERT OR REPLACE INTO config_overrides (account, config_key, config_value, expires_at)
      VALUES (?, ?, ?, ?)
    `);

    insert.run(account, configKey, JSON.stringify(configValue), expiresAt || null);
  }

  /**
   * Get a configuration override
   */
  getConfigOverride(account: string | null, configKey: string): any | null {
    const stmt = this.db.prepare(`
      SELECT config_value, expires_at FROM config_overrides
      WHERE account IS ? AND config_key = ?
    `);

    const row = stmt.get(account, configKey) as
      | { config_value: string; expires_at: number | null }
      | undefined;

    if (!row) {
      return null;
    }

    // Check if override has expired
    if (row.expires_at !== null && Date.now() > row.expires_at) {
      // Clean up expired override
      const deleteStmt = this.db.prepare(`
        DELETE FROM config_overrides
        WHERE account IS ? AND config_key = ?
      `);
      deleteStmt.run(account, configKey);
      return null;
    }

    return JSON.parse(row.config_value);
  }

  /**
   * Clear a configuration override
   */
  clearConfigOverride(account: string | null, configKey: string): void {
    const stmt = this.db.prepare(`
      DELETE FROM config_overrides
      WHERE account IS ? AND config_key = ?
    `);
    stmt.run(account, configKey);
  }

  /**
   * Get or initialize strategy metrics for an account
   */
  getMetrics(account: string): {
    totalFeesCollected: bigint;
    totalGasSpent: bigint;
    rebalanceCount: number;
    compoundCount: number;
    rangeAdjustmentCount: number;
    optimizationCount: number;
  } {
    const stmt = this.db.prepare(`
      SELECT 
        total_fees_collected_usd,
        total_gas_spent_usd,
        rebalance_count,
        compound_count,
        range_adjustment_count,
        optimization_count
      FROM strategy_metrics
      WHERE account = ?
    `);

    const row = stmt.get(account) as
      | {
          total_fees_collected_usd: string;
          total_gas_spent_usd: string;
          rebalance_count: number;
          compound_count: number;
          range_adjustment_count: number;
          optimization_count: number;
        }
      | undefined;

    if (!row) {
      // Initialize metrics if they don't exist
      const insert = this.db.prepare(`
        INSERT INTO strategy_metrics (
          account, total_fees_collected_usd, total_gas_spent_usd,
          rebalance_count, compound_count, range_adjustment_count, optimization_count
        ) VALUES (?, '0', '0', 0, 0, 0, 0)
      `);
      insert.run(account);

      return {
        totalFeesCollected: 0n,
        totalGasSpent: 0n,
        rebalanceCount: 0,
        compoundCount: 0,
        rangeAdjustmentCount: 0,
        optimizationCount: 0,
      };
    }

    return {
      totalFeesCollected: BigInt(row.total_fees_collected_usd),
      totalGasSpent: BigInt(row.total_gas_spent_usd),
      rebalanceCount: row.rebalance_count,
      compoundCount: row.compound_count,
      rangeAdjustmentCount: row.range_adjustment_count,
      optimizationCount: row.optimization_count,
    };
  }

  /**
   * Update strategy metrics for an account
   */
  updateMetrics(
    account: string,
    updates: {
      totalFeesCollected?: bigint;
      totalGasSpent?: bigint;
      rebalanceCount?: number;
      compoundCount?: number;
      rangeAdjustmentCount?: number;
      optimizationCount?: number;
    }
  ): void {
    // Ensure metrics exist
    this.getMetrics(account);

    const fields: string[] = [];
    const values: any[] = [];

    if (updates.totalFeesCollected !== undefined) {
      fields.push("total_fees_collected_usd = ?");
      values.push(updates.totalFeesCollected.toString());
    }
    if (updates.totalGasSpent !== undefined) {
      fields.push("total_gas_spent_usd = ?");
      values.push(updates.totalGasSpent.toString());
    }
    if (updates.rebalanceCount !== undefined) {
      fields.push("rebalance_count = ?");
      values.push(updates.rebalanceCount);
    }
    if (updates.compoundCount !== undefined) {
      fields.push("compound_count = ?");
      values.push(updates.compoundCount);
    }
    if (updates.rangeAdjustmentCount !== undefined) {
      fields.push("range_adjustment_count = ?");
      values.push(updates.rangeAdjustmentCount);
    }
    if (updates.optimizationCount !== undefined) {
      fields.push("optimization_count = ?");
      values.push(updates.optimizationCount);
    }

    if (fields.length === 0) {
      return; // No updates to apply
    }

    fields.push("last_updated = ?");
    values.push(Date.now());

    values.push(account);

    const updateStmt = this.db.prepare(`
      UPDATE strategy_metrics
      SET ${fields.join(", ")}
      WHERE account = ?
    `);

    updateStmt.run(...values);
  }

  /**
   * Record a fee collection event
   */
  recordFeeCollection(
    account: string,
    tokenId: string,
    feesCollectedUsd: bigint,
    feesAmount0?: bigint,
    feesAmount1?: bigint
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO fee_collection_history (
        timestamp, account, token_id, fees_collected_usd, fees_amount0, fees_amount1
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      timestamp,
      account,
      tokenId,
      feesCollectedUsd.toString(),
      feesAmount0?.toString() || null,
      feesAmount1?.toString() || null
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Record a funding fee snapshot
   */
  recordFundingFee(
    account: string,
    snapshotId: number,
    fundingFeeAmountUsd: bigint,
    fundingFeePerSize: bigint,
    positionSizeTokens: bigint
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO funding_fee_history (
        timestamp, account, snapshot_id, funding_fee_amount_usd,
        funding_fee_per_size, position_size_tokens
      ) VALUES (?, ?, ?, ?, ?, ?)
    `);

    const result = insert.run(
      timestamp,
      account,
      snapshotId,
      fundingFeeAmountUsd.toString(),
      fundingFeePerSize.toString(),
      positionSizeTokens.toString()
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get total fees collected in a time period
   */
  getFeesCollected(account: string, startTime?: number, endTime?: number): bigint {
    // Fetch individual rows and sum in JS to avoid SQLite integer overflow
    let query = `
      SELECT fees_collected_usd
      FROM fee_collection_history
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{ fees_collected_usd: string }>;

    let total = 0n;
    for (const row of rows) {
      try {
        total += BigInt(row.fees_collected_usd);
      } catch (e) {
        // Ignore invalid values
      }
    }

    return total;
  }

  /**
   * Get total costs (funding fees + gas) in a time period
   *
   * Note: Funding fees are calculated from deltas in funding_fee_per_size between snapshots.
   * For shorts, negative funding fees mean we're paying (cost), positive means we're receiving (benefit).
   *
   * TODO: Implement proper funding fee delta calculation once we have sufficient snapshot data
   */
  getTotalCosts(account: string, startTime?: number, endTime?: number): bigint {
    // Get gas costs and GMX execution fees
    // We fetch individual rows and sum in JS to avoid SQLite integer overflow
    let query = `
      SELECT 
        gas_cost_usd,
        gmx_execution_fee_usd
      FROM operation_history
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{
      gas_cost_usd: string | null;
      gmx_execution_fee_usd: string | null;
    }>;

    let totalGas = 0n;
    let totalGmxFees = 0n;

    for (const row of rows) {
      if (row.gas_cost_usd) {
        // Handle potential huge values or garbage by wrapping in try/catch if necessary
        // but BigInt constructor should handle valid numeric strings
        try {
          totalGas += BigInt(row.gas_cost_usd);
        } catch (e) {
          // Ignore invalid values
        }
      }
      if (row.gmx_execution_fee_usd) {
        try {
          totalGmxFees += BigInt(row.gmx_execution_fee_usd);
        } catch (e) {
          // Ignore invalid values
        }
      }
    }

    // TODO: Add funding fee calculation from snapshot deltas
    // For now, return gas costs + GMX execution fees
    return totalGas + totalGmxFees;
  }

  /**
   * Get average NAV over a time period
   */
  getAverageNav(account: string, startTime?: number, endTime?: number): bigint {
    let query = `
      SELECT total_nav_usd
      FROM monitoring_snapshots
      WHERE account = ?
    `;
    const params: any[] = [account];

    if (startTime !== undefined) {
      query += " AND timestamp >= ?";
      params.push(startTime);
    }

    if (endTime !== undefined) {
      query += " AND timestamp <= ?";
      params.push(endTime);
    }

    query += " ORDER BY timestamp ASC";

    const stmt = this.db.prepare(query);
    const rows = stmt.all(...params) as Array<{ total_nav_usd: string }>;

    if (rows.length === 0) {
      return 0n;
    }

    // Filter out snapshots with very low NAV (likely during position transitions)
    // These snapshots occur when positions are being closed/reopened and don't
    // represent the typical position size during the period
    const navValues = rows.map((row) => BigInt(row.total_nav_usd));

    // Find the maximum NAV in the period to use as a reference
    const maxNav = navValues.reduce((max, nav) => (nav > max ? nav : max), 0n);

    // Exclude snapshots with NAV < $100 or < 20% of max NAV
    // This filters out transition periods while keeping normal operational snapshots
    const MIN_NAV_THRESHOLD = 100n * 10n ** 30n; // $100 in 30 decimals
    const MIN_NAV_PERCENTAGE = (maxNav * 20n) / 100n; // 20% of max NAV
    const effectiveThreshold =
      MIN_NAV_THRESHOLD > MIN_NAV_PERCENTAGE ? MIN_NAV_THRESHOLD : MIN_NAV_PERCENTAGE;

    const validNavValues = navValues.filter((nav) => nav >= effectiveThreshold);

    if (validNavValues.length === 0) {
      // If all snapshots were filtered out, fall back to all snapshots
      // (shouldn't happen in practice, but handle gracefully)
      const sum = navValues.reduce((acc, nav) => acc + nav, 0n);
      return sum / BigInt(navValues.length);
    }

    // Calculate average of valid snapshots
    const sum = validNavValues.reduce((acc, nav) => acc + nav, 0n);
    return sum / BigInt(validNavValues.length);
  }

  /**
   * Calculate and cache APR for a period
   */
  calculateAndCacheAPR(
    account: string,
    periodType:
      | "daily"
      | "weekly"
      | "monthly"
      | "rolling_7d"
      | "rolling_30d"
      | "rolling_90d"
      | "lifetime",
    periodStart: number,
    periodEnd: number,
    feesCollected: bigint,
    costsIncurred: bigint,
    averageNav: bigint,
    aprBps: bigint
  ): number {
    const timestamp = Date.now();
    const insert = this.db.prepare(`
      INSERT INTO apr_calculations (
        timestamp, account, period_type, period_start, period_end,
        fees_collected_usd, costs_incurred_usd, net_yield_usd,
        average_nav_usd, apr_bps
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const netYield = feesCollected - costsIncurred;

    const result = insert.run(
      timestamp,
      account,
      periodType,
      periodStart,
      periodEnd,
      feesCollected.toString(),
      costsIncurred.toString(),
      netYield.toString(),
      averageNav.toString(),
      aprBps.toString()
    );

    return Number(result.lastInsertRowid);
  }

  /**
   * Get latest APR calculation for a period type
   */
  getLatestAPR(
    account: string,
    periodType:
      | "daily"
      | "weekly"
      | "monthly"
      | "rolling_7d"
      | "rolling_30d"
      | "rolling_90d"
      | "lifetime"
  ): {
    periodStart: number;
    periodEnd: number;
    feesCollected: bigint;
    costsIncurred: bigint;
    netYield: bigint;
    averageNav: bigint;
    aprBps: bigint;
  } | null {
    const stmt = this.db.prepare(`
      SELECT * FROM apr_calculations
      WHERE account = ? AND period_type = ?
      ORDER BY period_end DESC
      LIMIT 1
    `);

    const row = stmt.get(account, periodType) as
      | {
          period_start: number;
          period_end: number;
          fees_collected_usd: string;
          costs_incurred_usd: string;
          net_yield_usd: string;
          average_nav_usd: string;
          apr_bps: string;
        }
      | undefined;

    if (!row) {
      return null;
    }

    return {
      periodStart: row.period_start,
      periodEnd: row.period_end,
      feesCollected: BigInt(row.fees_collected_usd),
      costsIncurred: BigInt(row.costs_incurred_usd),
      netYield: BigInt(row.net_yield_usd),
      averageNav: BigInt(row.average_nav_usd),
      aprBps: BigInt(row.apr_bps),
    };
  }

  /**
   * Get database instance (for testing)
   */
  getDb(): Database.Database {
    return this.db;
  }
}
