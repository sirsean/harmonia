/**
 * Archives the OpenZeppelin upgrades manifest into deployments/ with a timestamped name.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade/archive-manifest.ts --network arbitrum
 *
 * Optional env:
 *   MANIFEST_NAME=arbitrum-one.json
 */

import fs from "fs";
import path from "path";
import { network } from "hardhat";

function formatUtcTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}T${pad(
    date.getUTCHours()
  )}-${pad(date.getUTCMinutes())}-${pad(date.getUTCSeconds())}Z`;
}

function resolveManifestPath(openzeppelinDir: string, manifestName?: string): string {
  if (manifestName) {
    return path.join(openzeppelinDir, manifestName);
  }

  const direct = path.join(openzeppelinDir, `${network.name}.json`);
  if (fs.existsSync(direct)) return direct;

  const alt = path.join(openzeppelinDir, `${network.name}-one.json`);
  if (fs.existsSync(alt)) return alt;

  const candidates = fs.readdirSync(openzeppelinDir).filter((entry) => entry.endsWith(".json"));
  if (candidates.length === 1) {
    return path.join(openzeppelinDir, candidates[0]);
  }

  throw new Error(
    `Could not resolve manifest file in ${openzeppelinDir}. Set MANIFEST_NAME explicitly.`
  );
}

async function main() {
  const openzeppelinDir = path.resolve(process.cwd(), ".openzeppelin");
  if (!fs.existsSync(openzeppelinDir)) {
    throw new Error(`Missing .openzeppelin directory at ${openzeppelinDir}`);
  }

  const manifestPath = resolveManifestPath(openzeppelinDir, process.env.MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Manifest not found at ${manifestPath}`);
  }

  const timestamp = formatUtcTimestamp(new Date());
  const manifestBase = path.basename(manifestPath, ".json");
  const destDir = path.resolve(process.cwd(), "deployments");
  const destName = `upgrade-manifest.${manifestBase}.${timestamp}.json`;
  const destPath = path.join(destDir, destName);

  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(manifestPath, destPath);

  console.log(`Archived manifest to ${destPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
