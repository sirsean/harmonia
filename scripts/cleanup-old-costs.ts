#!/usr/bin/env ts-node

/**
 * Script to manually clean up old $2 cost estimates from the database
 * Run this if the migration didn't catch all the old estimates
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "monitoring.db");

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

console.log("Checking for old cost estimates...");

// Check current values
const checkStmt = db.prepare(`
  SELECT 
    COUNT(*) as count,
    SUM(CAST(gas_cost_usd AS TEXT)) as total
  FROM operation_history
  WHERE gas_cost_usd IS NOT NULL
`);

const checkResult = checkStmt.get() as { count: number; total: string | null };
console.log(`Current records with gas_cost_usd: ${checkResult.count}`);
if (checkResult.total) {
  const totalBigInt = BigInt(checkResult.total);
  console.log(`Total gas costs: $${(Number(totalBigInt) / Number(10n ** 30n)).toFixed(2)}`);
}

// Find records with estimates >= $1
// Use numeric comparison - SQLite can compare TEXT as numbers if both are numeric strings
const findStmt = db.prepare(`
  SELECT id, timestamp, operation_type, gas_cost_usd
  FROM operation_history
  WHERE gas_cost_usd IS NOT NULL 
  AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
  ORDER BY timestamp DESC
`);

const estimates = findStmt.all() as Array<{
  id: number;
  timestamp: number;
  operation_type: string;
  gas_cost_usd: string;
}>;

console.log(`\nFound ${estimates.length} records with estimates >= $1:`);
for (const record of estimates.slice(0, 10)) {
  const costUsd = Number(BigInt(record.gas_cost_usd) / 10n ** 30n);
  const date = new Date(record.timestamp).toISOString();
  console.log(`  ID ${record.id}: ${record.operation_type} at ${date} - $${costUsd.toFixed(2)}`);
}
if (estimates.length > 10) {
  console.log(`  ... and ${estimates.length - 10} more`);
}

// Delete old estimates
if (estimates.length > 0) {
  console.log(`\nDeleting ${estimates.length} old estimates...`);
  const deleteStmt = db.prepare(`
    UPDATE operation_history 
    SET gas_cost_usd = NULL 
    WHERE gas_cost_usd IS NOT NULL 
    AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
  `);
  const result = deleteStmt.run();
  console.log(`Updated ${result.changes} records`);
  
  // Verify deletion
  const verifyStmt = db.prepare(`
    SELECT COUNT(*) as count
    FROM operation_history
    WHERE gas_cost_usd IS NOT NULL 
    AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
  `);
  const verifyResult = verifyStmt.get() as { count: number };
  console.log(`Remaining estimates >= $1: ${verifyResult.count}`);
} else {
  console.log("\nNo old estimates found to delete.");
}

db.close();
console.log("\nDone!");
