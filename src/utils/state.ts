import { MonitoringDatabase } from "./database";

export interface StrategyState {
  lastCheck: number;
  lastRebalance: number | null;
  lastCompound: number | null;
  lastRangeAdjustment: number | null;
  lastOptimization: number | null;
  metrics: {
    totalFeesCollected: bigint;
    totalGasSpent: bigint;
    rebalanceCount: number;
    compoundCount: number;
    rangeAdjustmentCount: number;
    optimizationCount: number;
  };
}

export interface OperationRecord {
  id: number;
  timestamp: number;
  operationType: string;
  gasCostUsd?: string;
  operationData?: Record<string, any>;
}

/**
 * StateManager provides a convenient interface for managing strategy state persistence.
 * It wraps MonitoringDatabase and provides higher-level operations for state management.
 */
export class StateManager {
  constructor(private db: MonitoringDatabase) {}

  /**
   * Load complete strategy state for an account
   */
  async loadState(account: string): Promise<StrategyState> {
    const metrics = this.db.getMetrics(account);
    const lastRebalance = this.db.getLastOperationTime(account, "rebalance") || null;
    const lastCompound = this.db.getLastOperationTime(account, "compound") || null;
    const lastRangeAdjustment = this.db.getLastOperationTime(account, "range_adjustment") || null;
    const lastOptimization = this.db.getLastOptimizationTime(account) || null;

    // Get last check time from latest snapshot
    const latestSnapshot = this.db.getLatestSnapshot(account);
    const lastCheck = latestSnapshot?.timestamp || Date.now();

    return {
      lastCheck,
      lastRebalance: lastRebalance || null,
      lastCompound: lastCompound || null,
      lastRangeAdjustment: lastRangeAdjustment || null,
      lastOptimization: lastOptimization || null,
      metrics,
    };
  }

  /**
   * Save partial state updates for an account
   */
  async saveState(account: string, state: Partial<StrategyState>): Promise<void> {
    // Update metrics if provided
    if (state.metrics) {
      this.db.updateMetrics(account, state.metrics);
    }

    // Note: Operation timestamps are updated via recordOperation()
    // Position snapshots are stored via storeSnapshot()
    // This method is mainly for metrics and other state that doesn't have dedicated methods
  }

  /**
   * Record an operation and update metrics
   */
  async recordOperation(
    account: string,
    type: "rebalance" | "compound" | "range_adjustment" | "optimization",
    gasCostUsd?: bigint,
    operationData?: Record<string, any>,
    gmxExecutionFeeUsd?: bigint
  ): Promise<number> {
    const operationId = this.db.recordOperation(
      account,
      type,
      gasCostUsd,
      operationData,
      gmxExecutionFeeUsd
    );

    // Update metrics
    const metrics = this.db.getMetrics(account);
    const updates: Parameters<typeof this.db.updateMetrics>[1] = {};

    switch (type) {
      case "rebalance":
        updates.rebalanceCount = metrics.rebalanceCount + 1;
        break;
      case "compound":
        updates.compoundCount = metrics.compoundCount + 1;
        break;
      case "range_adjustment":
        updates.rangeAdjustmentCount = metrics.rangeAdjustmentCount + 1;
        break;
      case "optimization":
        updates.optimizationCount = metrics.optimizationCount + 1;
        break;
    }

    if (gasCostUsd !== undefined) {
      updates.totalGasSpent = metrics.totalGasSpent + gasCostUsd;
    }

    this.db.updateMetrics(account, updates);

    return operationId;
  }

  /**
   * Get the timestamp of the last operation of a specific type
   */
  async getLastOperationTime(
    account: string,
    type: "rebalance" | "compound" | "range_adjustment" | "optimization"
  ): Promise<number | null> {
    const timestamp = this.db.getLastOperationTime(account, type);
    return timestamp || null;
  }

  /**
   * Get operation history for an account
   */
  async getOperationHistory(
    account: string,
    type?: "rebalance" | "compound" | "range_adjustment" | "optimization",
    limit?: number
  ): Promise<OperationRecord[]> {
    return this.db.getOperationHistory(account, type, limit);
  }

  /**
   * Suppress an alert for a specific duration
   */
  async suppressAlert(account: string, alertType: string, durationSeconds: number): Promise<void> {
    this.db.suppressAlert(account, alertType, durationSeconds);
  }

  /**
   * Check if an alert is currently suppressed
   */
  async isAlertSuppressed(account: string, alertType: string): Promise<boolean> {
    return this.db.isAlertSuppressed(account, alertType);
  }

  /**
   * Clear suppressed alerts for an account
   */
  async clearSuppressedAlerts(account: string, alertType?: string): Promise<void> {
    this.db.clearSuppressedAlerts(account, alertType);
  }

  /**
   * Set a configuration override
   */
  async setConfigOverride(
    account: string | null,
    key: string,
    value: any,
    expiresAt?: number
  ): Promise<void> {
    this.db.setConfigOverride(account, key, value, expiresAt);
  }

  /**
   * Get a configuration override
   */
  async getConfigOverride(account: string | null, key: string): Promise<any | null> {
    return this.db.getConfigOverride(account, key);
  }

  /**
   * Clear a configuration override
   */
  async clearConfigOverride(account: string | null, key: string): Promise<void> {
    this.db.clearConfigOverride(account, key);
  }

  /**
   * Update metrics for an account
   */
  async updateMetrics(account: string, updates: Partial<StrategyState["metrics"]>): Promise<void> {
    this.db.updateMetrics(account, updates);
  }

  /**
   * Get metrics for an account
   */
  async getMetrics(account: string): Promise<StrategyState["metrics"]> {
    return this.db.getMetrics(account);
  }

  /**
   * Get the underlying database instance (for advanced operations)
   */
  getDatabase(): MonitoringDatabase {
    return this.db;
  }
}
