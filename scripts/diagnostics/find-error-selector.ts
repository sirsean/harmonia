import fs from "fs";
import path from "path";
import { ethers } from "hardhat";

function walk(dir: string, acc: string[]) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, acc);
    else if (entry.isFile() && entry.name.endsWith(".json")) acc.push(full);
  }
}

async function main() {
  const target = (process.env.SELECTOR || "").toLowerCase();
  if (!target) {
    throw new Error("Set SELECTOR env var (e.g. 0x6e553f65).");
  }

  const artifactsDir = path.resolve(process.cwd(), "artifacts");
  const files: string[] = [];
  walk(artifactsDir, files);

  for (const file of files) {
    const content = JSON.parse(fs.readFileSync(file, "utf8"));
    const abi = content.abi as Array<{ type: string; name: string; inputs?: Array<{ type: string }> }>;
    if (!abi) continue;
    for (const item of abi) {
      if (item.type !== "error") continue;
      const types = (item.inputs || []).map((i) => i.type).join(",");
      const sig = `${item.name}(${types})`;
      const selector = ethers.id(sig).slice(0, 10).toLowerCase();
      if (selector === target) {
        console.log("Match:", sig, "in", file.replace(process.cwd() + "/", ""));
        return;
      }
    }
  }

  console.log("No match found in artifacts.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
