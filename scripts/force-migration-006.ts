#!/usr/bin/env ts-node

/**
 * Script to force-run migration 006 to clean up old cost estimates
 * This is useful if the migration already ran but didn't catch all estimates
 */

import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import { migrations } from "../src/utils/migrations";

const dbPath = process.env.DB_PATH || path.join(process.cwd(), "data", "monitoring.db");

if (!fs.existsSync(dbPath)) {
  console.error(`Database not found at: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);

console.log("Force-running migration 006 cleanup...");

// Get migration 006
const migration006 = migrations.find((m) => m.version === 6);
if (!migration006) {
  console.error("Migration 006 not found!");
  process.exit(1);
}

// Run just the cleanup part (idempotent)
const tableInfo = db
  .prepare("PRAGMA table_info(operation_history)")
  .all() as Array<{ name: string }>;
const hasGmxFeeColumn = tableInfo.some((col) => col.name === "gmx_execution_fee_usd");

if (!hasGmxFeeColumn) {
  console.log("Adding gmx_execution_fee_usd column...");
  db.exec(`
    ALTER TABLE operation_history 
    ADD COLUMN gmx_execution_fee_usd TEXT
  `);
}

// Delete old estimates
console.log("Deleting old cost estimates >= $1...");
// Use numeric comparison - SQLite can compare TEXT as numbers if both are numeric strings
const updateStmt = db.prepare(`
  UPDATE operation_history 
  SET gas_cost_usd = NULL 
  WHERE gas_cost_usd IS NOT NULL 
  AND CAST(gas_cost_usd AS REAL) >= 1000000000000000000000000000000.0
`);
const result = updateStmt.run();
console.log(`Updated ${result.changes} records`);

// Verify
const verifyStmt = db.prepare(`
  SELECT 
    COUNT(*) as count,
    SUM(CAST(gas_cost_usd AS TEXT)) as total
  FROM operation_history
  WHERE gas_cost_usd IS NOT NULL
`);
const verifyResult = verifyStmt.get() as { count: number; total: string | null };
console.log(`\nRemaining records with gas_cost_usd: ${verifyResult.count}`);
if (verifyResult.total) {
  const totalBigInt = BigInt(verifyResult.total);
  const totalUsd = Number(totalBigInt) / Number(10n ** 30n);
  console.log(`Total gas costs: $${totalUsd.toFixed(2)}`);
}

db.close();
console.log("\nDone!");
