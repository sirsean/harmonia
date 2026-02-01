import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { MonitoringDatabase } from "../../src/utils/database";
import * as fs from "fs";
import * as path from "path";

describe("MonitoringDatabase Integer Overflow Fix", () => {
  let db: MonitoringDatabase;
  let testDbPath: string;

  beforeEach(() => {
    // Create a temporary database file for each test
    testDbPath = path.join(
      process.cwd(),
      "test-data",
      `test-overflow-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );
    db = new MonitoringDatabase(testDbPath);
  });

  afterEach(() => {
    // Clean up: close database and remove test file
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
  });

  it("should correctly sum large gas costs without integer overflow", () => {
    const account = "0x123";
    
    // Use values that would definitely overflow 64-bit signed integer if summed as integers
    // 2^63 - 1 is ~9.22 * 10^18
    // We use 2 * 10^30
    const hugeValue = BigInt("2000000000000000000000000000000");

    db.recordOperation(account, "rebalance", hugeValue);
    db.recordOperation(account, "rebalance", hugeValue);

    const total = db.getTotalCosts(account);
    
    // Should be 4 * 10^30
    const expected = hugeValue * 2n;
    expect(total).toBe(expected);
  });

  it("should handle mixed large and small values", () => {
    const account = "0x456";
    const hugeValue = BigInt("2000000000000000000000000000000");
    const smallValue = BigInt("1000");

    db.recordOperation(account, "rebalance", hugeValue);
    db.recordOperation(account, "rebalance", smallValue);

    const total = db.getTotalCosts(account);
    expect(total).toBe(hugeValue + smallValue);
  });

  it("should correctly sum large fees collected without integer overflow", () => {
    const account = "0x789";
    const hugeValue = BigInt("2000000000000000000000000000000");
    
    // fee_collection_history requires more fields: timestamp, account, token_id, fees_collected_usd
    // We can use recordFeeCollection method if available, or insert directly if not exposed conveniently for testing raw values
    // db.recordFeeCollection converts to string, so we can use it.
    
    db.recordFeeCollection(account, "token1", hugeValue);
    db.recordFeeCollection(account, "token1", hugeValue);

    const total = db.getFeesCollected(account);
    expect(total).toBe(hugeValue * 2n);
  });
});