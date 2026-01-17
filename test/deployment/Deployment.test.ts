/**
 * Deployment Tests
 *
 * These tests validate the deployment configuration by deploying contracts
 * with mock dependencies. They ensure:
 * - All contracts deploy successfully with correct constructor args
 * - Contract relationships are properly configured
 * - Access control works correctly
 * - Constants are set to expected values
 *
 * NOTE: These tests use mock contracts to avoid fork dependencies.
 * Fork-dependent integration tests are in test/fork/
 */

import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { CONSTANTS, DEFAULT_DEPLOYMENT_CONFIG } from "../../scripts/config/addresses";

describe("Deployment", function () {
  // Increase timeout for deployment tests
  this.timeout(120_000);

  /**
   * Fixture that deploys all contracts with mock dependencies
   */
  async function deployWithMocksFixture() {
    const [deployer, guardian, user] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", 6);
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);

    // Deploy mock Uniswap V3 contracts
    const MockNonfungiblePositionManager = await ethers.getContractFactory(
      "MockNonfungiblePositionManager"
    );
    const mockPositionManager = await MockNonfungiblePositionManager.deploy();

    const MockSwapRouter = await ethers.getContractFactory("MockSwapRouter");
    const mockSwapRouter = await MockSwapRouter.deploy();

    const MockUniswapV3Factory = await ethers.getContractFactory("MockUniswapV3Factory");
    const mockFactory = await MockUniswapV3Factory.deploy();

    // Create a pool in the factory for the LiquidityManager to find
    await mockFactory.createPool(
      await weth.getAddress(),
      await usdc.getAddress(),
      DEFAULT_DEPLOYMENT_CONFIG.poolFee!
    );

    // Link position manager to factory
    await mockPositionManager.setFactory(await mockFactory.getAddress());

    // Deploy mock GMX V2 contracts
    const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
    const mockExchangeRouter = await MockExchangeRouter.deploy();

    // Deploy mock Chainlink price feed
    const MockGMXPriceFeed = await ethers.getContractFactory("MockGMXPriceFeed");
    const mockPriceFeed = await MockGMXPriceFeed.deploy(200000000000n, 8); // $2000 with 8 decimals

    // Deploy DeltaNeutralVault
    const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = await upgrades.deployProxy(VaultFactory, [
      await usdc.getAddress(),
      DEFAULT_DEPLOYMENT_CONFIG.vaultName!,
      DEFAULT_DEPLOYMENT_CONFIG.vaultSymbol!,
      deployer.address
    ], { kind: 'uups' });
    await vault.waitForDeployment();

    // Deploy LiquidityManager with mock addresses
    const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    const liquidityManager = await upgrades.deployProxy(LiquidityManagerFactory, [
      await mockPositionManager.getAddress(), // positionManager
      await mockSwapRouter.getAddress(), // swapRouter
      await mockFactory.getAddress(), // factory
      await weth.getAddress(),
      await usdc.getAddress(),
      DEFAULT_DEPLOYMENT_CONFIG.poolFee!,
      deployer.address
    ], { kind: 'uups' });
    await liquidityManager.waitForDeployment();

    // Deploy HedgeManager with mock addresses
    // Use a separate mock address for market since it's a different concept than the router
    const mockMarketAddress = ethers.Wallet.createRandom().address;
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
    const hedgeManager = await upgrades.deployProxy(HedgeManagerFactory, [
      await mockExchangeRouter.getAddress(), // exchangeRouter
      mockMarketAddress, // market
      await usdc.getAddress(),
      await weth.getAddress(),
      await mockPriceFeed.getAddress(),
      deployer.address
    ], { kind: 'uups' });
    await hedgeManager.waitForDeployment();

    // Deploy RebalanceController
    const RebalanceControllerFactory = await ethers.getContractFactory("RebalanceController");
    const rebalanceController = await upgrades.deployProxy(RebalanceControllerFactory, [
      await vault.getAddress(),
      deployer.address
    ], { kind: 'uups' });
    await rebalanceController.waitForDeployment();

    // Configure contracts
    await liquidityManager.setVault(await vault.getAddress());
    await hedgeManager.setVault(await vault.getAddress());
    await vault.setManagers(
      await liquidityManager.getAddress(),
      await hedgeManager.getAddress(),
      await rebalanceController.getAddress()
    );
    await vault.setGuardian(guardian.address);
    await vault.setDepositCap(DEFAULT_DEPLOYMENT_CONFIG.initialDepositCap!);

    return {
      vault,
      liquidityManager,
      hedgeManager,
      rebalanceController,
      usdc,
      weth,
      mockPositionManager,
      mockSwapRouter,
      mockFactory,
      mockExchangeRouter,
      mockPriceFeed,
      deployer,
      guardian,
      user,
    };
  }

  describe("Contract Deployment", function () {
    it("should deploy DeltaNeutralVault with correct parameters", async function () {
      const { vault, usdc, deployer } = await loadFixture(deployWithMocksFixture);

      expect(await vault.asset()).to.equal(await usdc.getAddress());
      expect(await vault.name()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.vaultName);
      expect(await vault.symbol()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.vaultSymbol);
      expect(await vault.owner()).to.equal(deployer.address);
    });

    it("should deploy LiquidityManager with correct parameters", async function () {
      const {
        liquidityManager,
        mockPositionManager,
        mockSwapRouter,
        mockFactory,
        weth,
        usdc,
        deployer,
      } = await loadFixture(deployWithMocksFixture);

      expect(await liquidityManager.positionManager()).to.equal(
        await mockPositionManager.getAddress()
      );
      expect(await liquidityManager.swapRouter()).to.equal(await mockSwapRouter.getAddress());
      expect(await liquidityManager.factory()).to.equal(await mockFactory.getAddress());
      expect(await liquidityManager.baseToken()).to.equal(await weth.getAddress());
      expect(await liquidityManager.quoteToken()).to.equal(await usdc.getAddress());
      expect(await liquidityManager.poolFee()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.poolFee);
      expect(await liquidityManager.owner()).to.equal(deployer.address);
    });

    it("should deploy HedgeManager with correct parameters", async function () {
      const { hedgeManager, mockExchangeRouter, usdc, weth, mockPriceFeed, deployer } =
        await loadFixture(deployWithMocksFixture);

      expect(await hedgeManager.exchangeRouter()).to.equal(await mockExchangeRouter.getAddress());
      // Market is a random address we passed during deployment
      expect(await hedgeManager.market()).to.not.equal(ethers.ZeroAddress);
      expect(await hedgeManager.collateralToken()).to.equal(await usdc.getAddress());
      expect(await hedgeManager.indexToken()).to.equal(await weth.getAddress());
      expect(await hedgeManager.priceFeed()).to.equal(await mockPriceFeed.getAddress());
      expect(await hedgeManager.owner()).to.equal(deployer.address);
    });

    it("should deploy RebalanceController with correct parameters", async function () {
      const { rebalanceController, vault, deployer } = await loadFixture(deployWithMocksFixture);

      expect(await rebalanceController.vault()).to.equal(await vault.getAddress());
      expect(await rebalanceController.owner()).to.equal(deployer.address);
    });
  });

  describe("Contract Configuration", function () {
    it("should configure vault with all managers", async function () {
      const { vault, liquidityManager, hedgeManager, rebalanceController } =
        await loadFixture(deployWithMocksFixture);

      expect(await vault.liquidityManager()).to.equal(await liquidityManager.getAddress());
      expect(await vault.hedgeManager()).to.equal(await hedgeManager.getAddress());
      expect(await vault.rebalanceController()).to.equal(await rebalanceController.getAddress());
    });

    it("should configure LiquidityManager with vault", async function () {
      const { liquidityManager, vault } = await loadFixture(deployWithMocksFixture);

      expect(await liquidityManager.vault()).to.equal(await vault.getAddress());
    });

    it("should configure HedgeManager with vault", async function () {
      const { hedgeManager, vault } = await loadFixture(deployWithMocksFixture);

      expect(await hedgeManager.vault()).to.equal(await vault.getAddress());
    });

    it("should set guardian correctly", async function () {
      const { vault, guardian } = await loadFixture(deployWithMocksFixture);

      expect(await vault.guardian()).to.equal(guardian.address);
    });

    it("should set deposit cap correctly", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.depositCap()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.initialDepositCap);
    });
  });

  describe("Access Control", function () {
    it("should allow owner to call setManagers", async function () {
      const { vault, deployer } = await loadFixture(deployWithMocksFixture);

      // Owner can update managers
      await expect(
        vault
          .connect(deployer)
          .setManagers(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.not.be.reverted;
    });

    it("should prevent non-owner from calling setManagers", async function () {
      const { vault, user } = await loadFixture(deployWithMocksFixture);

      await expect(
        vault.connect(user).setManagers(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to set deposit cap", async function () {
      const { vault, deployer } = await loadFixture(deployWithMocksFixture);

      const newCap = ethers.parseUnits("100000", 6);
      await expect(vault.connect(deployer).setDepositCap(newCap)).to.not.be.reverted;
      expect(await vault.depositCap()).to.equal(newCap);
    });

    it("should allow owner to set guardian", async function () {
      const { vault, deployer, user } = await loadFixture(deployWithMocksFixture);

      await expect(vault.connect(deployer).setGuardian(user.address)).to.not.be.reverted;
      expect(await vault.guardian()).to.equal(user.address);
    });

    it("should allow guardian to trigger circuit breaker", async function () {
      const { vault, guardian } = await loadFixture(deployWithMocksFixture);

      // This works because getDeltaRatio() returns 0 when totalAssets is 0,
      // and the mocks handle the underlying calls gracefully
      await expect(vault.connect(guardian).triggerCircuitBreaker()).to.not.be.reverted;
      expect(await vault.circuitBreakerTriggered()).to.be.true;
    });

    it("should prevent non-guardian/owner from triggering circuit breaker", async function () {
      const { vault, user } = await loadFixture(deployWithMocksFixture);

      await expect(vault.connect(user).triggerCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("should allow owner to pause vault", async function () {
      const { vault, deployer } = await loadFixture(deployWithMocksFixture);

      await expect(vault.connect(deployer).pause()).to.not.be.reverted;
      expect(await vault.paused()).to.be.true;
    });

    it("should allow owner to unpause vault", async function () {
      const { vault, deployer } = await loadFixture(deployWithMocksFixture);

      await vault.connect(deployer).pause();
      await expect(vault.connect(deployer).unpause()).to.not.be.reverted;
      expect(await vault.paused()).to.be.false;
    });
  });

  describe("Contract Constants", function () {
    it("should have correct vault constants", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.PRECISION()).to.equal(CONSTANTS.PRECISION);
      expect(await vault.DELTA_THRESHOLD()).to.equal(CONSTANTS.DELTA_THRESHOLD);
      expect(await vault.EMERGENCY_THRESHOLD()).to.equal(CONSTANTS.EMERGENCY_THRESHOLD);
      expect(await vault.MAX_LEVERAGE()).to.equal(CONSTANTS.MAX_LEVERAGE);
      expect(await vault.MIN_HEDGE_RATIO()).to.equal(CONSTANTS.MIN_HEDGE_RATIO);
      expect(await vault.MAX_SINGLE_WITHDRAWAL()).to.equal(CONSTANTS.MAX_SINGLE_WITHDRAWAL);
      expect(await vault.LARGE_WITHDRAWAL_COOLDOWN()).to.equal(CONSTANTS.LARGE_WITHDRAWAL_COOLDOWN);
      expect(await vault.LARGE_WITHDRAWAL_THRESHOLD()).to.equal(
        CONSTANTS.LARGE_WITHDRAWAL_THRESHOLD
      );
    });

    it("should have correct hedge manager constants", async function () {
      const { hedgeManager } = await loadFixture(deployWithMocksFixture);

      expect(await hedgeManager.PRECISION()).to.equal(CONSTANTS.PRECISION);
      expect(await hedgeManager.MAX_LEVERAGE()).to.equal(CONSTANTS.MAX_LEVERAGE);
    });

    it("should have correct rebalance controller intervals", async function () {
      const { rebalanceController } = await loadFixture(deployWithMocksFixture);

      expect(await rebalanceController.MIN_REBALANCE_INTERVAL()).to.equal(
        CONSTANTS.MIN_REBALANCE_INTERVAL
      );
      expect(await rebalanceController.MAX_REBALANCE_INTERVAL()).to.equal(
        CONSTANTS.MAX_REBALANCE_INTERVAL
      );
      expect(await rebalanceController.MIN_COMPOUND_INTERVAL()).to.equal(
        CONSTANTS.MIN_COMPOUND_INTERVAL
      );
      expect(await rebalanceController.MIN_SNAPSHOT_INTERVAL()).to.equal(
        CONSTANTS.MIN_SNAPSHOT_INTERVAL
      );
    });
  });

  describe("Vault Initialization State", function () {
    it("should start with no LP position", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.lpTokenId()).to.equal(0);
    });

    it("should start with zero fees collected", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.totalFeesCollected()).to.equal(0);
    });

    it("should start with zero funding received", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.totalFundingReceived()).to.equal(0);
    });

    it("should start with circuit breaker not triggered", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.circuitBreakerTriggered()).to.be.false;
    });

    it("should start unpaused", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.paused()).to.be.false;
    });

    it("should start with zero total assets", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.totalAssets()).to.equal(0);
    });

    it("should start with zero total supply", async function () {
      const { vault } = await loadFixture(deployWithMocksFixture);

      expect(await vault.totalSupply()).to.equal(0);
    });
  });

  describe("Manager Initialization State", function () {
    it("should have LiquidityManager with no position", async function () {
      const { liquidityManager } = await loadFixture(deployWithMocksFixture);

      expect(await liquidityManager.tokenId()).to.equal(0);
      expect(await liquidityManager.liquidity()).to.equal(0);
    });

    it("should have HedgeManager with no position", async function () {
      const { hedgeManager } = await loadFixture(deployWithMocksFixture);

      // With mocks, hasPosition should work and return false
      expect(await hedgeManager.hasPosition()).to.be.false;
      expect(await hedgeManager.totalCollateralDeposited()).to.equal(0);
    });

    it("should have default slippage tolerances set", async function () {
      const { liquidityManager, hedgeManager } = await loadFixture(deployWithMocksFixture);

      // LiquidityManager default: 0.5%
      expect(await liquidityManager.slippageTolerance()).to.equal(5n * 10n ** 15n);

      // HedgeManager default: 1%
      expect(await hedgeManager.slippageTolerance()).to.equal(10n ** 16n);
    });
  });

  describe("RebalanceController Automation Interface", function () {
    it("should implement checkUpkeep without reverting", async function () {
      const { rebalanceController } = await loadFixture(deployWithMocksFixture);

      // checkUpkeep should return without reverting
      const result = await rebalanceController.checkUpkeep.staticCall("0x");
      const upkeepNeeded = result[0];
      const performData = result[1];
      expect(typeof upkeepNeeded).to.equal("boolean");
      expect(typeof performData).to.equal("string");
    });

    it("should return snapshot needed on first check", async function () {
      const { rebalanceController } = await loadFixture(deployWithMocksFixture);

      // On first check, snapshot should be needed (lastSnapshotTime is 0)
      const result = await rebalanceController.checkUpkeep.staticCall("0x");
      const upkeepNeeded = result[0];
      expect(upkeepNeeded).to.be.true;
    });
  });

  describe("Ownership Transfer", function () {
    it("should allow ownership transfer for vault", async function () {
      const { vault, deployer, user } = await loadFixture(deployWithMocksFixture);

      await vault.connect(deployer).transferOwnership(user.address);
      expect(await vault.owner()).to.equal(user.address);
    });

    it("should allow ownership transfer for LiquidityManager", async function () {
      const { liquidityManager, deployer, user } = await loadFixture(deployWithMocksFixture);

      await liquidityManager.connect(deployer).transferOwnership(user.address);
      expect(await liquidityManager.owner()).to.equal(user.address);
    });

    it("should allow ownership transfer for HedgeManager", async function () {
      const { hedgeManager, deployer, user } = await loadFixture(deployWithMocksFixture);

      await hedgeManager.connect(deployer).transferOwnership(user.address);
      expect(await hedgeManager.owner()).to.equal(user.address);
    });

    it("should allow ownership transfer for RebalanceController", async function () {
      const { rebalanceController, deployer, user } = await loadFixture(deployWithMocksFixture);

      await rebalanceController.connect(deployer).transferOwnership(user.address);
      expect(await rebalanceController.owner()).to.equal(user.address);
    });
  });
});
