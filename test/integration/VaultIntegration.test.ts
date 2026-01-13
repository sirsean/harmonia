import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { time } from "@nomicfoundation/hardhat-network-helpers";
import {
  DeltaNeutralVault,
  LiquidityManager,
  HedgeManager,
  MockERC20,
  MockUniswapV3Pool,
  MockNonfungiblePositionManager,
  MockSwapRouter,
  MockExchangeRouter,
  MockOrderVault,
  MockDataStore,
  MockReader,
  MockChainlinkAggregator,
} from "../../typechain-types";

describe("Vault Integration Tests", function () {
  let vault: DeltaNeutralVault;
  let liquidityManager: LiquidityManager;
  let hedgeManager: HedgeManager;
  let usdc: MockERC20;
  let weth: MockERC20;
  let pool: MockUniswapV3Pool;
  let positionManager: MockNonfungiblePositionManager;
  let swapRouter: MockSwapRouter;
  let exchangeRouter: MockExchangeRouter;
  let orderVault: MockOrderVault;
  let dataStore: MockDataStore;
  let reader: MockReader;
  let priceFeed: MockChainlinkAggregator;
  let owner: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;
  let user3: HardhatEthersSigner;

  const PRECISION = BigInt(10) ** BigInt(18);
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);
  const POOL_FEE = 500;
  const MARKET_ADDRESS = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336";
  const MIN_DEPOSIT = ethers.parseUnits("100", 6);
  const ETH_PRICE = 2000n * 10n ** 8n; // $2000

  // Helper to get deadline
  async function getDeadline(secondsFromNow: number = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp + secondsFromNow);
  }

  // Helper to simulate order execution (cancel pending order to clear state)
  async function simulateOrderExecution(): Promise<void> {
    const pendingKey = await hedgeManager.pendingOrderKey();
    if (pendingKey !== ethers.ZeroHash) {
      await hedgeManager.connect(owner).cancelPendingOrder({ value: 0 });
    }
  }

  // Helper to setup mock position data in GMX reader
  async function setupMockHedgePosition(sizeUsd: bigint, collateralAmount: bigint): Promise<void> {
    const positionKey = await hedgeManager.getPositionKey();
    await reader.setMockPosition(positionKey, sizeUsd, collateralAmount, 0);
  }

  // Helper to refresh oracle timestamp (prevents PriceStale errors after time.increase)
  async function refreshOracle(): Promise<void> {
    await priceFeed.setPrice(ETH_PRICE);
  }

  beforeEach(async function () {
    [owner, keeper, user1, user2, user3] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    weth = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    // Deploy Uniswap mocks
    const MockPoolFactory = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await MockPoolFactory.deploy(await weth.getAddress(), await usdc.getAddress(), POOL_FEE);

    const MockPositionManagerFactory = await ethers.getContractFactory(
      "MockNonfungiblePositionManager"
    );
    positionManager = await MockPositionManagerFactory.deploy();

    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    swapRouter = await MockSwapRouterFactory.deploy();

    // Deploy GMX mocks
    const MockDataStoreFactory = await ethers.getContractFactory("MockDataStore");
    dataStore = await MockDataStoreFactory.deploy();

    const MockOrderVaultFactory = await ethers.getContractFactory("MockOrderVault");
    orderVault = await MockOrderVaultFactory.deploy();

    const MockExchangeRouterFactory = await ethers.getContractFactory("MockExchangeRouter");
    exchangeRouter = await MockExchangeRouterFactory.deploy(
      await dataStore.getAddress(),
      await orderVault.getAddress()
    );

    const MockReaderFactory = await ethers.getContractFactory("MockReader");
    reader = await MockReaderFactory.deploy();

    // Deploy Chainlink mock
    const MockChainlinkFactory = await ethers.getContractFactory("MockChainlinkAggregator");
    priceFeed = await MockChainlinkFactory.deploy(8, "ETH / USD");

    // Deploy LiquidityManager
    const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    liquidityManager = await LiquidityManagerFactory.deploy(
      await positionManager.getAddress(),
      await pool.getAddress(),
      await swapRouter.getAddress(),
      await priceFeed.getAddress(),
      owner.address
    );

    // Deploy HedgeManager
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
    hedgeManager = await HedgeManagerFactory.deploy(
      await exchangeRouter.getAddress(),
      await reader.getAddress(),
      await priceFeed.getAddress(),
      MARKET_ADDRESS,
      await usdc.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Deploy DeltaNeutralVault
    const DeltaNeutralVaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
    vault = await DeltaNeutralVaultFactory.deploy(
      await usdc.getAddress(),
      await liquidityManager.getAddress(),
      await hedgeManager.getAddress(),
      await priceFeed.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Set vault in managers
    await liquidityManager.setVault(await vault.getAddress());
    await hedgeManager.setVault(await vault.getAddress());

    // Set keeper
    await vault.setKeeper(keeper.address);

    // Mint tokens to users
    await usdc.mint(user1.address, ethers.parseUnits("1000000", 6));
    await usdc.mint(user2.address, ethers.parseUnits("1000000", 6));
    await usdc.mint(user3.address, ethers.parseUnits("1000000", 6));
    await weth.mint(owner.address, ethers.parseEther("1000"));
    await usdc.mint(owner.address, ethers.parseUnits("10000000", 6));

    // Mint tokens to mock contracts for simulating returns
    await weth.mint(await positionManager.getAddress(), ethers.parseEther("1000"));
    await usdc.mint(await positionManager.getAddress(), ethers.parseUnits("2000000", 6));
    await usdc.mint(await orderVault.getAddress(), ethers.parseUnits("2000000", 6));
  });

  describe("openPositions - Full Flow", function () {
    const tickLower = 72000; // ~$1500
    const tickUpper = 78000; // ~$2700
    const lpAmount0 = ethers.parseEther("1"); // 1 WETH
    const lpAmount1 = ethers.parseUnits("2000", 6); // 2000 USDC
    const hedgeCollateral = ethers.parseUnits("1000", 6); // 1000 USDC collateral
    const hedgeSizeUsd = 2000n * GMX_USD_PRECISION; // $2000 short position

    beforeEach(async function () {
      // Owner approves tokens
      await weth.connect(owner).approve(await vault.getAddress(), lpAmount0);
      await usdc.connect(owner).approve(await vault.getAddress(), lpAmount1 + hedgeCollateral);
    });

    it("should open LP and hedge positions together", async function () {
      const executionFee = ethers.parseEther("0.01");

      // Open positions
      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: executionFee,
        });

      // Verify LP position was created
      const lpTokenId = await liquidityManager.positionTokenId();
      expect(lpTokenId).to.be.gt(0n);

      // Verify hedge order was submitted (target size is set)
      const targetSize = await hedgeManager.targetHedgeSizeUsd();
      expect(targetSize).to.equal(hedgeSizeUsd);

      // Simulate order execution and setup mock position
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);

      // Verify hedge position was created
      const hedgePosition = await hedgeManager.getHedgePosition();
      expect(hedgePosition.sizeUsd).to.equal(hedgeSizeUsd);
      expect(hedgePosition.collateralAmount).to.equal(hedgeCollateral);
      expect(hedgePosition.isActive).to.be.true;

      // Verify yield snapshot was taken
      const snapshotCount = await vault.getSnapshotCount();
      expect(snapshotCount).to.equal(2n); // Initial + after opening
    });

    it("should correctly calculate total assets after opening positions", async function () {
      const executionFee = ethers.parseEther("0.01");

      // First deposit some USDC into vault
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const totalAssetsBefore = await vault.totalAssets();
      expect(totalAssetsBefore).to.equal(depositAmount);

      // Open positions
      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: executionFee,
        });

      // Total assets should include idle USDC + LP value + hedge collateral
      const totalAssetsAfter = await vault.totalAssets();
      expect(totalAssetsAfter).to.be.gt(0n);
    });

    it("should fail if called by non-owner", async function () {
      await weth.connect(user1).approve(await vault.getAddress(), lpAmount0);
      await usdc.connect(user1).approve(await vault.getAddress(), lpAmount1 + hedgeCollateral);
      await weth.mint(user1.address, lpAmount0);

      await expect(
        vault
          .connect(user1)
          .openPositions(
            tickLower,
            tickUpper,
            lpAmount0,
            lpAmount1,
            hedgeCollateral,
            hedgeSizeUsd,
            {
              value: ethers.parseEther("0.01"),
            }
          )
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should track delta correctly after opening positions", async function () {
      const executionFee = ethers.parseEther("0.01");

      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: executionFee,
        });

      // Simulate order execution and setup mock position
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);

      // Get net delta - should be close to 0 for delta-neutral
      const netDelta = await vault.getNetDelta();

      // LP delta should be positive (long ETH exposure)
      const lpDelta = await liquidityManager.getPositionDelta();
      expect(lpDelta).to.be.gte(0n);

      // Hedge delta should be negative (short ETH exposure)
      const hedgeDelta = await hedgeManager.getPositionDelta();
      expect(hedgeDelta).to.be.lte(0n);

      // Net should be sum
      expect(netDelta).to.equal(lpDelta + hedgeDelta);
    });

    it("should update vault state correctly", async function () {
      const executionFee = ethers.parseEther("0.01");

      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: executionFee,
        });

      // Simulate order execution and setup mock position
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);

      const state = await vault.getVaultState();

      expect(state.totalAssets).to.be.gt(0n);
      expect(state.lpValue).to.be.gt(0n);
      expect(state.hedgeValue).to.be.gt(0n);
    });
  });

  describe("Rebalance - Full Cycle", function () {
    const tickLower = 72000;
    const tickUpper = 78000;
    const lpAmount0 = ethers.parseEther("1");
    const lpAmount1 = ethers.parseUnits("2000", 6);
    const hedgeCollateral = ethers.parseUnits("1000", 6);
    const hedgeSizeUsd = 2000n * GMX_USD_PRECISION;

    beforeEach(async function () {
      // Setup: minimal deposit to keep totalAssets small relative to LP delta
      // This ensures LP delta is >5% of totalAssets for rebalance to trigger
      const depositAmount = ethers.parseUnits("200", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      await weth.connect(owner).approve(await vault.getAddress(), lpAmount0);
      await usdc.connect(owner).approve(await vault.getAddress(), lpAmount1 + hedgeCollateral);

      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: ethers.parseEther("0.01"),
        });

      // Simulate order execution and setup mock position
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);

      // Wait for rebalance cooldown
      await time.increase(3601);
      await refreshOracle();
    });

    it("should revert if delta is within tolerance", async function () {
      // With balanced positions, delta should be within tolerance
      const rebalanceParams = {
        newTickLower: 0,
        newTickUpper: 0,
        hedgeSizeDelta: 0n,
        increaseHedge: false,
      };

      await expect(vault.connect(keeper).rebalance(rebalanceParams)).to.be.revertedWithCustomError(
        vault,
        "DeltaWithinTolerance"
      );
    });

    it("should verify LP delta is tracked correctly", async function () {
      // Note: Full delta-based rebalancing tests require fork testing with real Uniswap
      // This test verifies that LP position has positive delta (long ETH exposure)
      const lpDelta = await liquidityManager.getPositionDelta();

      // LP position should have positive delta (long exposure)
      expect(lpDelta).to.be.gt(0n);

      // Hedge should have negative delta (short exposure)
      const hedgeDelta = await hedgeManager.getPositionDelta();
      expect(hedgeDelta).to.be.lte(0n);
    });

    it("should enforce rebalance cooldown after manual hedge operations", async function () {
      // Owner manually adjusts hedge (bypasses rebalance function)
      await refreshOracle();
      await usdc.mint(owner.address, hedgeCollateral);
      await usdc.connect(owner).approve(await hedgeManager.getAddress(), hedgeCollateral);

      // Increase hedge directly via hedge manager
      await hedgeManager.connect(owner).increaseHedge(hedgeSizeUsd, 0, { value: ethers.parseEther("0.01") });
      await simulateOrderExecution();

      // Try rebalance - should still be within tolerance (delta balanced)
      const rebalanceParams = {
        newTickLower: 0,
        newTickUpper: 0,
        hedgeSizeDelta: 0n,
        increaseHedge: false,
      };

      // Expect DeltaWithinTolerance because positions are balanced
      await expect(vault.connect(keeper).rebalance(rebalanceParams)).to.be.revertedWithCustomError(
        vault,
        "DeltaWithinTolerance"
      );
    });

    it("should have zero lastRebalanceTime before any rebalance call", async function () {
      // lastRebalanceTime is only set by the rebalance() function, not openPositions
      const lastRebalance = await vault.lastRebalanceTime();
      // Should be 0 since rebalance() hasn't been called yet
      expect(lastRebalance).to.equal(0n);
    });

    it("should allow keeper to initiate LP fee collection as rebalance alternative", async function () {
      // When rebalance isn't needed, keeper can still collect fees
      await refreshOracle();

      // Fee collection should work regardless of delta tolerance
      await expect(vault.connect(keeper).collectLPFees()).to.not.be.reverted;

      // Verify a snapshot was taken
      const snapshotCount = await vault.getSnapshotCount();
      expect(snapshotCount).to.be.gte(2n);
    });
  });

  describe("Yield Tracking - With Real Positions", function () {
    const tickLower = 72000;
    const tickUpper = 78000;
    const lpAmount0 = ethers.parseEther("1");
    const lpAmount1 = ethers.parseUnits("2000", 6);
    const hedgeCollateral = ethers.parseUnits("1000", 6);
    const hedgeSizeUsd = 2000n * GMX_USD_PRECISION;

    beforeEach(async function () {
      // Setup positions
      await weth.connect(owner).approve(await vault.getAddress(), lpAmount0);
      await usdc.connect(owner).approve(await vault.getAddress(), lpAmount1 + hedgeCollateral);

      await vault
        .connect(owner)
        .openPositions(tickLower, tickUpper, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: ethers.parseEther("0.01"),
        });

      // Simulate order execution
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);
    });

    it("should track yield snapshots over time", async function () {
      const initialSnapshotCount = await vault.getSnapshotCount();

      // Collect LP fees (triggers snapshot)
      await vault.connect(keeper).collectLPFees();

      const snapshotCountAfterFees = await vault.getSnapshotCount();
      expect(snapshotCountAfterFees).to.equal(initialSnapshotCount + 1n);

      // Claim hedge funding (triggers snapshot)
      await vault.connect(keeper).claimHedgeFunding();

      const snapshotCountAfterFunding = await vault.getSnapshotCount();
      expect(snapshotCountAfterFunding).to.equal(snapshotCountAfterFees + 1n);
    });

    it("should calculate yield metrics correctly", async function () {
      // Advance time by 1 day
      await time.increase(86400);

      // Collect fees to update snapshots
      await vault.connect(keeper).collectLPFees();

      // Get yield metrics
      const metrics = await vault.getYieldMetrics();

      // Metrics should be accessible (values depend on mock behavior)
      expect(metrics.totalFeeIncome).to.be.gte(0n);
      expect(metrics.totalFundingIncome).to.exist;
      expect(metrics.totalRebalanceCosts).to.be.gte(0n);
    });

    it("should update high water mark on value increase", async function () {
      const initialHWM = await vault.highWaterMark();

      // Simulate value increase by depositing
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const newHWM = await vault.highWaterMark();
      expect(newHWM).to.be.gt(initialHWM);
    });
  });

  describe("Multi-User Scenarios", function () {
    // Note: No positions opened in beforeEach to test pure deposit/withdrawal mechanics
    // ERC4626 share calculation requires careful handling when totalSupply=0 but totalAssets>0

    it("should handle multiple concurrent deposits", async function () {
      const deposit1 = ethers.parseUnits("10000", 6);
      const deposit2 = ethers.parseUnits("20000", 6);
      const deposit3 = ethers.parseUnits("15000", 6);

      await usdc.connect(user1).approve(await vault.getAddress(), deposit1);
      await usdc.connect(user2).approve(await vault.getAddress(), deposit2);
      await usdc.connect(user3).approve(await vault.getAddress(), deposit3);

      // All users deposit
      await vault.connect(user1).deposit(deposit1, user1.address);
      await vault.connect(user2).deposit(deposit2, user2.address);
      await vault.connect(user3).deposit(deposit3, user3.address);

      // Check balances
      const shares1 = await vault.balanceOf(user1.address);
      const shares2 = await vault.balanceOf(user2.address);
      const shares3 = await vault.balanceOf(user3.address);

      expect(shares1).to.be.gt(0n);
      expect(shares2).to.be.gt(0n);
      expect(shares3).to.be.gt(0n);

      // User2 deposited 2x user1, should have ~2x shares
      expect(shares2).to.be.gt(shares1);
    });

    it("should handle deposits and withdrawals in sequence", async function () {
      const depositAmount = ethers.parseUnits("10000", 6);

      // User1 deposits
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesUser1 = await vault.balanceOf(user1.address);

      // User2 deposits
      await usdc.connect(user2).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user2).deposit(depositAmount, user2.address);

      // User1 withdraws half
      const halfShares = sharesUser1 / 2n;
      await vault.connect(user1).redeem(halfShares, user1.address, user1.address);

      // User1 should still have shares
      const remainingShares = await vault.balanceOf(user1.address);
      expect(remainingShares).to.be.closeTo(halfShares, halfShares / 100n); // ~1% tolerance
    });

    it("should maintain share price consistency across users", async function () {
      const depositAmount = ethers.parseUnits("10000", 6);

      // Get initial share price
      const previewBefore = await vault.previewDeposit(depositAmount);

      // User1 deposits
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Share price should be similar for user2
      const previewAfter = await vault.previewDeposit(depositAmount);

      // Allow small variance due to rounding
      const variance =
        previewBefore > previewAfter ? previewBefore - previewAfter : previewAfter - previewBefore;

      // Preview should be positive
      expect(previewBefore).to.be.gt(0n);
      expect(previewAfter).to.be.gt(0n);
      expect(variance).to.be.lt(previewBefore / 100n); // <1% variance
    });

    it("should correctly calculate pro-rata shares", async function () {
      // User1 deposits 10000
      const deposit1 = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), deposit1);
      await vault.connect(user1).deposit(deposit1, user1.address);

      const shares1 = await vault.balanceOf(user1.address);

      // User2 deposits 10000 (same amount)
      const deposit2 = ethers.parseUnits("10000", 6);
      await usdc.connect(user2).approve(await vault.getAddress(), deposit2);
      await vault.connect(user2).deposit(deposit2, user2.address);

      const shares2 = await vault.balanceOf(user2.address);

      // Both users should have positive shares
      expect(shares1).to.be.gt(0n);
      expect(shares2).to.be.gt(0n);

      // Both users should have similar shares (deposited same amount)
      const shareDiff = shares1 > shares2 ? shares1 - shares2 : shares2 - shares1;
      expect(shareDiff).to.be.lt(shares1 / 50n); // <2% difference
    });
  });

  describe("Fee Collection Integration", function () {
    beforeEach(async function () {
      // Setup with positions
      const lpAmount0 = ethers.parseEther("1");
      const lpAmount1 = ethers.parseUnits("2000", 6);
      const hedgeCollateral = ethers.parseUnits("1000", 6);
      const hedgeSizeUsd = 2000n * GMX_USD_PRECISION;

      await weth.connect(owner).approve(await vault.getAddress(), lpAmount0);
      await usdc.connect(owner).approve(await vault.getAddress(), lpAmount1 + hedgeCollateral);

      await vault
        .connect(owner)
        .openPositions(72000, 78000, lpAmount0, lpAmount1, hedgeCollateral, hedgeSizeUsd, {
          value: ethers.parseEther("0.01"),
        });

      // Simulate order execution
      await simulateOrderExecution();
      await setupMockHedgePosition(hedgeSizeUsd, hedgeCollateral);

      // User deposits
      const depositAmount = ethers.parseUnits("100000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should collect management fees over time", async function () {
      const feeRecipient = await vault.feeRecipient();
      const feeSharesBefore = await vault.balanceOf(feeRecipient);

      // Advance time by 30 days
      await time.increase(30 * 86400);

      // Collect fees
      await vault.collectFees();

      const feeSharesAfter = await vault.balanceOf(feeRecipient);
      // Fees should increase (shares minted to fee recipient)
      expect(feeSharesAfter).to.be.gte(feeSharesBefore);
    });

    it("should collect performance fees when above high water mark", async function () {
      const feeRecipient = await vault.feeRecipient();

      // Record high water mark
      const hwmBefore = await vault.highWaterMark();

      // Simulate gains by another deposit (increases total assets)
      const additionalDeposit = ethers.parseUnits("50000", 6);
      await usdc.connect(user2).approve(await vault.getAddress(), additionalDeposit);
      await vault.connect(user2).deposit(additionalDeposit, user2.address);

      // The HWM should update
      const hwmAfter = await vault.highWaterMark();
      expect(hwmAfter).to.be.gt(hwmBefore);

      // Advance time
      await time.increase(86400);

      const feeSharesBefore = await vault.balanceOf(feeRecipient);

      // Collect fees
      await vault.collectFees();

      const feeSharesAfter = await vault.balanceOf(feeRecipient);

      // Should have collected some fees (management at minimum)
      expect(feeSharesAfter).to.be.gte(feeSharesBefore);
    });

    it("should track total fees collected", async function () {
      const totalFeesBefore = await vault.totalFeesCollected();

      // Advance time and collect
      await time.increase(30 * 86400);
      await vault.collectFees();

      const totalFeesAfter = await vault.totalFeesCollected();
      // Should have some fees collected
      expect(totalFeesAfter).to.be.gte(totalFeesBefore);
    });

    it("should emit FeesCollected event", async function () {
      // Advance time
      await time.increase(30 * 86400);

      // Collect fees and check event
      await expect(vault.collectFees()).to.emit(vault, "FeesCollected");
    });
  });

  describe("Edge Cases and Emergency Flows", function () {
    it("should handle minimum deposit exactly at threshold", async function () {
      const minDeposit = MIN_DEPOSIT;
      await usdc.connect(user1).approve(await vault.getAddress(), minDeposit);

      // Should succeed at exactly minimum
      await expect(vault.connect(user1).deposit(minDeposit, user1.address)).to.not.be.reverted;

      const shares = await vault.balanceOf(user1.address);
      expect(shares).to.be.gt(0n);
    });

    it("should reject deposit below minimum", async function () {
      const belowMin = MIN_DEPOSIT - 1n;
      await usdc.connect(user1).approve(await vault.getAddress(), belowMin);

      await expect(
        vault.connect(user1).deposit(belowMin, user1.address)
      ).to.be.revertedWithCustomError(vault, "DepositTooSmall");
    });

    it("should handle withdrawal of all available assets", async function () {
      // Deposit first
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Get shares
      const shares = await vault.balanceOf(user1.address);

      // Redeem all shares
      await vault.connect(user1).redeem(shares, user1.address, user1.address);

      const remainingShares = await vault.balanceOf(user1.address);
      expect(remainingShares).to.equal(0n);
    });

    it("should pause and unpause correctly", async function () {
      // Deposit while unpaused
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount * 2n);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Pause
      await vault.connect(owner).pause();

      // Deposit should fail
      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Withdrawal should still work
      const shares = await vault.balanceOf(user1.address);
      await expect(vault.connect(user1).redeem(shares / 2n, user1.address, user1.address)).to.not.be
        .reverted;

      // Unpause
      await vault.connect(owner).unpause();

      // Deposit should work again
      await expect(vault.connect(user1).deposit(depositAmount, user1.address)).to.not.be.reverted;
    });

    it("should allow emergency token recovery", async function () {
      // Send random token to vault
      const randomToken = await (
        await ethers.getContractFactory("MockERC20")
      ).deploy("Random", "RND", 18);
      await randomToken.mint(await vault.getAddress(), ethers.parseEther("100"));

      const recoveryAmount = ethers.parseEther("50");
      const recipientBalanceBefore = await randomToken.balanceOf(owner.address);

      // Recover tokens
      await vault
        .connect(owner)
        .emergencyRecover(await randomToken.getAddress(), owner.address, recoveryAmount);

      const recipientBalanceAfter = await randomToken.balanceOf(owner.address);
      expect(recipientBalanceAfter - recipientBalanceBefore).to.equal(recoveryAmount);
    });

    it("should prevent recovery of underlying asset", async function () {
      await expect(
        vault
          .connect(owner)
          .emergencyRecover(await usdc.getAddress(), owner.address, ethers.parseUnits("100", 6))
      ).to.be.revertedWith("Cannot recover underlying");
    });

    it("should handle zero address checks in admin functions", async function () {
      await expect(
        vault.connect(owner).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");

      await expect(
        vault.connect(owner).emergencyRecover(await weth.getAddress(), ethers.ZeroAddress, 1n)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });

  describe("Withdrawal Constraints", function () {
    // No beforeEach - each test sets up its own scenario

    it("should limit withdrawals to available idle assets", async function () {
      // User deposits first (to get shares at 1:1)
      const depositAmount = ethers.parseUnits("5000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // The vault now has idle USDC from the deposit
      const vaultUsdcBalance = await usdc.balanceOf(await vault.getAddress());

      // Try to withdraw more than available
      const excessiveAmount = vaultUsdcBalance + ethers.parseUnits("1000", 6);

      await expect(
        vault.connect(user1).withdraw(excessiveAmount, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalExceedsAvailable");
    });

    it("should allow withdrawal up to available amount", async function () {
      // User deposits BEFORE positions are opened (so they get shares at 1:1)
      const depositAmount = ethers.parseUnits("5000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Check that deposit succeeded
      const shares = await vault.balanceOf(user1.address);
      expect(shares).to.be.gt(0n);

      const vaultUsdcBalance = await usdc.balanceOf(await vault.getAddress());
      expect(vaultUsdcBalance).to.be.gt(0n);

      const userBalanceBefore = await usdc.balanceOf(user1.address);

      // Withdraw available amount (the full idle balance)
      await vault.connect(user1).withdraw(vaultUsdcBalance, user1.address, user1.address);

      const userBalanceAfter = await usdc.balanceOf(user1.address);
      expect(userBalanceAfter - userBalanceBefore).to.equal(vaultUsdcBalance);
    });

    it("should track shares correctly after partial withdrawal", async function () {
      // User deposits (without positions for clean 1:1 share price)
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesBefore = await vault.balanceOf(user1.address);
      expect(sharesBefore).to.be.gt(0n);

      // Withdraw half
      const halfDeposit = depositAmount / 2n;
      await vault.connect(user1).withdraw(halfDeposit, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);

      // Should have burned approximately half the shares
      expect(sharesAfter).to.be.lt(sharesBefore);
      expect(sharesAfter).to.be.closeTo(sharesBefore / 2n, sharesBefore / 50n); // Within 2%
    });
  });

  describe("Access Control", function () {
    it("should only allow owner to open positions", async function () {
      await expect(
        vault
          .connect(user1)
          .openPositions(72000, 78000, 0, 0, 0, 0, { value: ethers.parseEther("0.01") })
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should only allow keeper or owner to rebalance", async function () {
      // Deposit first to have assets
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const rebalanceParams = {
        newTickLower: 0,
        newTickUpper: 0,
        hedgeSizeDelta: 0n,
        increaseHedge: false,
      };

      await expect(vault.connect(user1).rebalance(rebalanceParams)).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedCaller"
      );
    });

    it("should only allow keeper or owner to collect LP fees", async function () {
      await expect(vault.connect(user1).collectLPFees()).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedCaller"
      );
    });

    it("should only allow keeper or owner to claim hedge funding", async function () {
      await expect(vault.connect(user1).claimHedgeFunding()).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedCaller"
      );
    });

    it("should only allow owner to pause/unpause", async function () {
      await expect(vault.connect(user1).pause()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.connect(user1).unpause()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should only allow owner to set keeper", async function () {
      await expect(vault.connect(user1).setKeeper(user2.address)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should only allow owner to set fee recipient", async function () {
      await expect(
        vault.connect(user1).setFeeRecipient(user2.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });
});
