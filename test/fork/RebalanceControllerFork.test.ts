import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { MockRebalanceVault, RebalanceController } from "../../typechain-types";

// Only run on Arbitrum fork when ALCHEMY_API_KEY is configured
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("RebalanceController Fork Tests", function () {
  const PRECISION = BigInt(10) ** BigInt(18);
  const DELTA_THRESHOLD = (5n * PRECISION) / 100n; // 5%

  async function deployFixture() {
    const [owner] = await ethers.getSigners();

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

  it("should evaluate and perform compound and snapshot on fork", async function () {
    const { mockVault, controller } = await loadFixture(deployFixture);

    // Zero delta so rebalances are not triggered
    await mockVault.setDeltaRatio(0n);

    // Initial check: expect compound
    let [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
    expect(upkeepNeeded).to.equal(true);
    let upkeepType = decodeUpkeepType(performData);
    expect(upkeepType).to.equal(2); // Compound

    await controller.performUpkeep(performData);
    expect(await mockVault.compoundCallCount()).to.equal(1n);

    // Advance time to trigger snapshot on forked network
    await time.increase(6 * 60 * 60 + 1); // > 6 hours

    [upkeepNeeded, performData] = await controller.checkUpkeep.staticCall("0x");
    expect(upkeepNeeded).to.equal(true);
    upkeepType = decodeUpkeepType(performData);
    expect(upkeepType).to.equal(3); // Snapshot

    // Provide some totals for snapshot event
    await mockVault.setTotals(1_000_000n, 10_000n, 500n);

    const { anyValue } = await import("@nomicfoundation/hardhat-chai-matchers/withArgs");

    await expect(controller.performUpkeep(performData))
      .to.emit(controller, "SnapshotRecorded")
      .withArgs(1_000_000n, 10_000n, 500n, anyValue);
  });
});
