import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { DeltaNeutralVault, MockLiquidityManager, MockHedgeManager } from "../../typechain-types";

describe("DeltaNeutralVault - Configurable Threshold", function () {
  const PRECISION = BigInt(10) ** BigInt(18);
  const USDC_DECIMALS = 6;
  const INITIAL_BALANCE = BigInt(1_000_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

  async function deployFixture() {
    const [owner, user, rebalanceController] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await usdc.waitForDeployment();

    // Deploy vault
    const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = (await upgrades.deployProxy(
      DeltaNeutralVault,
      [await usdc.getAddress(), "Harmonia Delta Neutral", "hdnUSDC", owner.address],
      { kind: "uups" }
    )) as unknown as DeltaNeutralVault;
    await vault.waitForDeployment();

    // Deploy Managers
    const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
    const liquidityManager = (await MockLiquidityManager.deploy(
      await usdc.getAddress(),
      await usdc.getAddress()
    )) as unknown as MockLiquidityManager;
    await liquidityManager.waitForDeployment();

    // Deploy MockHedgeManager
    const MockHedgeManager = await ethers.getContractFactory("MockHedgeManager");
    const mockHedgeManager = await MockHedgeManager.deploy();
    await mockHedgeManager.waitForDeployment();
    const hedgeManager = await mockHedgeManager.getAddress();

    // Set Managers
    await vault.setManagers(
      await liquidityManager.getAddress(),
      hedgeManager,
      rebalanceController.address
    );

    return { vault, liquidityManager, owner, user, usdc };
  }

  it("should initialize with default threshold of 5%", async function () {
    const { vault } = await loadFixture(deployFixture);
    const expected = (5n * PRECISION) / 100n; // 0.05e18
    expect(await vault.deltaThreshold()).to.equal(expected);
  });

  it("should allow owner to update threshold", async function () {
    const { vault, owner } = await loadFixture(deployFixture);
    const newThreshold = (10n * PRECISION) / 100n; // 10%

    await expect(vault.connect(owner).setDeltaThreshold(newThreshold))
      .to.emit(vault, "DeltaThresholdUpdated")
      .withArgs((5n * PRECISION) / 100n, newThreshold);

    expect(await vault.deltaThreshold()).to.equal(newThreshold);
  });

  it("should revert when non-owner updates threshold", async function () {
    const { vault, user } = await loadFixture(deployFixture);
    const newThreshold = (10n * PRECISION) / 100n;

    await expect(vault.connect(user).setDeltaThreshold(newThreshold)).to.be.revertedWithCustomError(
      vault,
      "OwnableUnauthorizedAccount"
    );
  });

  it("should respect new threshold in rebalanceNeeded logic", async function () {
    const { vault, liquidityManager, owner } = await loadFixture(deployFixture);

    // Setup:
    // Total Assets = 100 (mocked via liquidity manager value for simplicity, ignoring idle assets)
    // We want to test percentages.

    const assets = BigInt(100) * BigInt(10) ** BigInt(USDC_DECIMALS);
    await liquidityManager.setMockValue(assets); // Position value = 100
    // Note: totalAssets() = idle + lpValue + hedgeValue.
    // If we have 0 idle and 0 hedge, totalAssets = lpValue.

    // Case 1: Default Threshold (5%)
    // Set delta to 4% (0.04 * 100 = 4)
    // Delta is int256, usually 18 decimals for ratios, but here it is absolute delta?
    // Let's check getDeltaRatio implementation:
    // deltaRatio = (netDelta * PRECISION) / total;
    // So if we want ratio 0.04e18, we need:
    // (netDelta * 1e18) / 100e6 = 0.04e18
    // netDelta = 0.04 * 100e6 = 4e6.

    // Wait, getNetDelta returns "Net delta (positive = long, negative = short)".
    // The unit of netDelta depends on the underlying asset?
    // Usually delta is unitless (e.g. 1.0 ETH exposure).
    // But getDeltaRatio calculation: `(netDelta * PRECISION) / total`
    // suggests netDelta and total have the same units (or compatible to produce a ratio).
    // `total` is in USDC terms (e.g. 1e6).
    // So `netDelta` must be in USDC terms (Delta Value).
    // Let's check `_getLPDelta`. It calls `getPositionDelta`.
    // In `DeltaNeutralVault`, `getDeltaRatio` doc says "Delta as percentage of position".
    // If totalAssets is $100, and we have 1 ETH exposure ($3000), delta ratio would be huge (3000%).
    // So `getNetDelta` likely returns delta in USD value?
    // Or `total` is in ETH? No, `totalAssets` returns USDC.
    // Let's assume `netDelta` is dollar delta.

    const delta4Percent = (assets * 4n) / 100n; // 4% of assets
    await liquidityManager.setMockDelta(delta4Percent);

    expect(await vault.rebalanceNeeded()).to.equal(false); // 4% < 5%

    const delta6Percent = (assets * 6n) / 100n; // 6% of assets
    await liquidityManager.setMockDelta(delta6Percent);

    expect(await vault.rebalanceNeeded()).to.equal(true); // 6% > 5%

    // Case 2: Update Threshold to 10%
    const newThreshold = (10n * PRECISION) / 100n;
    await vault.connect(owner).setDeltaThreshold(newThreshold);

    expect(await vault.rebalanceNeeded()).to.equal(false); // 6% < 10%

    const delta11Percent = (assets * 11n) / 100n; // 11% of assets
    await liquidityManager.setMockDelta(delta11Percent);

    expect(await vault.rebalanceNeeded()).to.equal(true); // 11% > 10%
  });
});
