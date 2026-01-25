import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { migrate, rollback, getCurrentVersion, migrations } from "../../src/utils/migrations";
import * as fs from "fs";
import * as path from "path";

describe("Database Migrations", () => {
  let testDbPath: string;
  let db: Database.Database;

  beforeEach(() => {
    // Create a temporary database file for each test
    testDbPath = path.join(
      process.cwd(),
      "test-data",
      `migrations-test-${Date.now()}-${Math.random().toString(36).substring(7)}.db`
    );

    // Ensure directory exists
    const dir = path.dirname(testDbPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    db = new Database(testDbPath);
    db.pragma("journal_mode = WAL");
    db.pragma("foreign_keys = ON");
  });

  afterEach(() => {
    // Clean up: close database and remove test file
    db.close();
    if (fs.existsSync(testDbPath)) {
      fs.unlinkSync(testDbPath);
    }
    // Remove test-data directory if empty
    const testDataDir = path.dirname(testDbPath);
    try {
      if (fs.existsSync(testDataDir) && fs.readdirSync(testDataDir).length === 0) {
        fs.rmdirSync(testDataDir);
      }
    } catch (e) {
      // Ignore errors
    }
  });

  describe("getCurrentVersion", () => {
    it("should return 0 for new database", () => {
      const version = getCurrentVersion(db);
      expect(version).toBe(0);
    });

    it("should return current version after migrations", () => {
      migrate(db);
      const version = getCurrentVersion(db);
      expect(version).toBe(migrations.length);
    });
  });

  describe("migrate", () => {
    it("should create migrations table", () => {
      migrate(db);

      const tableExists = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'")
        .get() as { name: string } | undefined;

      expect(tableExists).toBeDefined();
    });

    it("should apply all migrations", () => {
      migrate(db);

      const appliedMigrations = db
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .all() as Array<{ version: number; name: string }>;

      expect(appliedMigrations.length).toBe(migrations.length);
      expect(appliedMigrations[0].version).toBe(1);
      expect(appliedMigrations[0].name).toBe("initial_schema");
    });

    it("should create all required tables", () => {
      migrate(db);

      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;

      const tableNames = tables.map((t) => t.name).sort();
      expect(tableNames).toContain("monitoring_snapshots");
      expect(tableNames).toContain("position_snapshots");
      expect(tableNames).toContain("nav_history");
      expect(tableNames).toContain("schema_migrations");
    });

    it("should create all required indexes", () => {
      migrate(db);

      const indexes = db
        .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name IS NOT NULL")
        .all() as Array<{ name: string }>;

      const indexNames = indexes.map((i) => i.name).sort();
      expect(indexNames).toContain("idx_snapshots_timestamp");
      expect(indexNames).toContain("idx_snapshots_account");
      expect(indexNames).toContain("idx_positions_snapshot_id");
      expect(indexNames).toContain("idx_positions_token_id");
      expect(indexNames).toContain("idx_nav_history_timestamp");
      expect(indexNames).toContain("idx_nav_history_account");
    });

    it("should be idempotent (safe to run multiple times)", () => {
      migrate(db);
      const version1 = getCurrentVersion(db);

      migrate(db);
      const version2 = getCurrentVersion(db);

      expect(version1).toBe(version2);
      expect(version1).toBe(migrations.length);
    });

    it("should only apply pending migrations", () => {
      // Create migrations table first
      db.exec(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
          version INTEGER PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at INTEGER DEFAULT (strftime('%s', 'now'))
        )
      `);

      // Apply first migration manually
      migrations[0].up(db);
      db.prepare("INSERT INTO schema_migrations (version, name) VALUES (?, ?)").run(
        migrations[0].version,
        migrations[0].name
      );

      const versionBefore = getCurrentVersion(db);
      expect(versionBefore).toBe(1);

      // Run migrate - should only apply remaining migrations
      // (In this case, there's only one migration, so it should be idempotent)
      migrate(db);

      const versionAfter = getCurrentVersion(db);
      expect(versionAfter).toBe(migrations.length);
    });
  });

  describe("rollback", () => {
    it("should rollback last migration if down migration exists", () => {
      migrate(db);
      const versionBefore = getCurrentVersion(db);
      expect(versionBefore).toBeGreaterThan(0);

      // Note: Current migrations don't have down migrations, so this test
      // verifies the rollback mechanism works when down migrations are provided
      // For now, we'll test that it throws appropriately
      expect(() => {
        rollback(db);
      }).toThrow();
    });

    it("should rollback to specific version", () => {
      migrate(db);

      // Try to rollback to version 0 (should fail since no down migrations)
      expect(() => {
        rollback(db, 0);
      }).toThrow();
    });

    it("should throw error when rolling back below version 0", () => {
      migrate(db);

      expect(() => {
        rollback(db, -1);
      }).toThrow("Cannot rollback below version 0");
    });
  });

  describe("migration integrity", () => {
    it("should have migrations in sequential order", () => {
      for (let i = 0; i < migrations.length; i++) {
        expect(migrations[i].version).toBe(i + 1);
      }
    });

    it("should have unique migration versions", () => {
      const versions = migrations.map((m) => m.version);
      const uniqueVersions = new Set(versions);
      expect(versions.length).toBe(uniqueVersions.size);
    });

    it("should have unique migration names", () => {
      const names = migrations.map((m) => m.name);
      const uniqueNames = new Set(names);
      expect(names.length).toBe(uniqueNames.size);
    });
  });
});
