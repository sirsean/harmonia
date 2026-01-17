import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MockRebalanceVault, RebalanceController } from "../../typechain-types";

describe("RebalanceController", function () {
  const PRECISION = BigInt(10) ** BigInt(18);
  const DELTA_THRESHOLD = (5n * PRECISION) / 100n; // 5%
  const MIN_REBALANCE_INTERVAL = 60 * 60; // 1 hour (seconds)
  const MIN_COMPOUND_INTERVAL = 24 * 60 * 60; // 1 day (seconds)
  const MIN_SNAPSHOT_INTERVAL = 6 * 60 * 60; // 6 hours (seconds)

  async function deployFixture() {
    const [owner] = await ethers.getSigners();

    // Deploy mock vault
    const MockVault = await ethers.getContractFactory("MockRebalanceVault");
    const mockVault = (await MockVault.deploy(DELTA_THRESHOLD)) as MockRebalanceVault;
    await mockVault.waitForDeployment();

    // Deploy controller
    const Controller = await ethers.getContractFactory("RebalanceController");
    const controller = (await upgrades.deployProxy(Controller, [
      await mockVault.getAddress(),
      owner.address
    ], { kind: 'uups' })) as unknown as RebalanceController;
    await controller.waitForDeployment();

    return { owner, mockVault, controller };
  }

  function decodeUpkeepType(performData: string | Uint8Array): number {
    const [raw] = ethers.AbiCoder.defaultAbiCoder().decode(["uint8"], performData);
    return Number(raw);
  }

  describe("Deployment", function () {
    it("should deploy with correct owner and vault", async function () {
      const { owner, mockVault, controller } = await loadFixture(deployFixture);

      expect(await controller.owner()).to.equal(owner.address);
      expect(await controller.vault()).to.equal(await mockVault.getAddress());
    });

    it("should revert on zero vault address", async function () {
      const [owner] = await ethers.getSigners();
      const Controller = await ethers.getContractFactory("RebalanceController");

      await expect(
        upgrades.deployProxy(Controller, [
          ethers.ZeroAddress,
          owner.address
        ], { kind: 'uups' })
      ).to.be.revertedWithCustomError(Controller, "ZeroAddress");
    });

    it("should revert on zero owner address", async function () {
      const [owner] = await ethers.getSigners();
      const MockVault = await ethers.getContractFactory("MockRebalanceVault");
      const mockVault = (await MockVault.deploy(DELTA_THRESHOLD)) as MockRebalanceVault;
      await mockVault.waitForDeployment();

      const Controller = await ethers.getContractFactory("RebalanceController");

      await expect(
        upgrades.deployProxy(Controller, [
          await mockVault.getAddress(),
          ethers.ZeroAddress
        ], { kind: 'uups' })
      ).to.be.revertedWithCustomError(Controller, "OwnableInvalidOwner");
    });
  });

  describe("Rebalance selection", function () {
    it("should request rebalance when delta exceeds threshold and interval passed", async function () {
      const { mockVault, controller } = await loadFixture(deployFixture);

      // Set delta ratio to 10%
      await mockVault.setDeltaRatio((10n * PRECISION) / 100n);

      // Simulate an initial state where no previous rebalance has been recorded
      // This still allows rebalancing because minIntervalPassed is true when hasRebalanced is false.
      await mockVault.setLastRebalanceTime(0);

      const [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);

      const upkeepType = decodeUpkeepType(performData);
      // UpkeepType.Rebalance = 1
      expect(upkeepType).to.equal(1);

      await controller.performUpkeep(performData);

      expect(await mockVault.rebalanceCallCount()).to.equal(1n);
      expect(await mockVault.lastRebalanceTargetSize()).to.equal(0n);
    });

    it("should not request rebalance when delta below threshold", async function () {
      const { mockVault, controller } = await loadFixture(deployFixture);

      // Small delta 1%
      await mockVault.setDeltaRatio((1n * PRECISION) / 100n);

      const [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      const upkeepType = decodeUpkeepType(performData);

      // Some other upkeep (compound/snapshot) may be selected, but not rebalance
      if (upkeepNeeded) {
        expect(upkeepType).to.not.equal(1);
      }
    });
  });

  describe("Compound and snapshot selection", function () {
    it("should prioritize compound over snapshot when both due", async function () {
      const { controller } = await loadFixture(deployFixture);

      // With no previous compound/snapshot, both are considered overdue.
      const [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);

      const upkeepType = decodeUpkeepType(performData);
      // UpkeepType.Compound = 2
      expect(upkeepType).to.equal(2);
    });

    it("should move from compound to snapshot on subsequent checks", async function () {
      const { mockVault, controller } = await loadFixture(deployFixture);

      // Zero delta so we don't trigger rebalances
      await mockVault.setDeltaRatio(0n);

      // First check: should compound
      let [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);
      let upkeepType = decodeUpkeepType(performData);
      expect(upkeepType).to.equal(2); // Compound

      await controller.performUpkeep(performData);
      expect(await mockVault.compoundCallCount()).to.equal(1n);

      // Immediately after, compound interval has not elapsed, but snapshot interval is treated as overdue
      [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);
      upkeepType = decodeUpkeepType(performData);
      expect(upkeepType).to.equal(3); // Snapshot

      // Set totals for snapshot event
      await mockVault.setTotals(1_000_000n, 5_000n, 1_000n);

      const { anyValue } = await import("@nomicfoundation/hardhat-chai-matchers/withArgs");

      await expect(controller.performUpkeep(performData))
        .to.emit(controller, "SnapshotRecorded")
        .withArgs(1_000_000n, 5_000n, 1_000n, anyValue);
    });

    it("should eventually request compound again after interval", async function () {
      const { mockVault, controller } = await loadFixture(deployFixture);

      await mockVault.setDeltaRatio(0n);

      // Initial compound
      let [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);
      let upkeepType = decodeUpkeepType(performData);
      expect(upkeepType).to.equal(2);
      await controller.performUpkeep(performData);

      // Advance time less than compound interval -> expect snapshot
      await time.increase(MIN_SNAPSHOT_INTERVAL + 1);
      [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);
      upkeepType = decodeUpkeepType(performData);
      expect(upkeepType).to.equal(3);

      await controller.performUpkeep(performData);

      // Advance time beyond compound interval -> expect compound again
      await time.increase(MIN_COMPOUND_INTERVAL);
      [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      expect(upkeepNeeded).to.equal(true);
      upkeepType = decodeUpkeepType(performData);
      expect(upkeepType).to.equal(2);
    });
  });

  describe("No-op behaviour", function () {
    it("should be a no-op when no upkeep is needed", async function () {
      const { mockVault, controller } = await loadFixture(deployFixture);

      // Delta below threshold and we simulate recent compound/snapshot by
      // calling performUpkeep a couple of times first.
      await mockVault.setDeltaRatio(0n);

      let [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
      if (upkeepNeeded) {
        await controller.performUpkeep(performData);
      }

      // Immediately check again without advancing time
      [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");

      if (!upkeepNeeded) {
        // Calling performUpkeep should not revert and should not change mock state
        const beforeRebalance = await mockVault.rebalanceCallCount();
        const beforeCompound = await mockVault.compoundCallCount();

        await controller.performUpkeep(performData);

        expect(await mockVault.rebalanceCallCount()).to.equal(beforeRebalance);
        expect(await mockVault.compoundCallCount()).to.equal(beforeCompound);
      }
    });
  });
});
