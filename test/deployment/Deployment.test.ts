/**
 * Deployment Tests
 *
 * These tests validate the deployment scripts by running them against
 * a forked Arbitrum mainnet. They ensure:
 * - All contracts deploy successfully
 * - Constructor arguments are correct
 * - Contract relationships are properly configured
 * - The system is ready for operation
 *
 * Run with:
 *   ALCHEMY_API_KEY=your_key npx hardhat test test/deployment/Deployment.test.ts
 */

import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  ARBITRUM_MAINNET,
  CONSTANTS,
  DEFAULT_DEPLOYMENT_CONFIG,
} from "../../scripts/config/addresses";

describe("Deployment", function () {
  // Increase timeout for fork tests
  this.timeout(120_000);

  /**
   * Fixture that deploys all contracts as they would be in production
   */
  async function deployAllContractsFixture() {
    const [deployer, guardian, user] = await ethers.getSigners();
    const addresses = ARBITRUM_MAINNET;

    // Deploy DeltaNeutralVault
    const VaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = await VaultFactory.deploy(
      addresses.usdc,
      DEFAULT_DEPLOYMENT_CONFIG.vaultName!,
      DEFAULT_DEPLOYMENT_CONFIG.vaultSymbol!,
      deployer.address
    );
    await vault.waitForDeployment();

    // Deploy LiquidityManager
    const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    const liquidityManager = await LiquidityManagerFactory.deploy(
      addresses.uniswapV3PositionManager,
      addresses.uniswapV3SwapRouter,
      addresses.uniswapV3Factory,
      addresses.weth,
      addresses.usdc,
      DEFAULT_DEPLOYMENT_CONFIG.poolFee!,
      deployer.address
    );
    await liquidityManager.waitForDeployment();

    // Deploy HedgeManager
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
    const hedgeManager = await HedgeManagerFactory.deploy(
      addresses.gmxExchangeRouter,
      addresses.gmxEthUsdMarket,
      addresses.usdc,
      addresses.weth,
      addresses.chainlinkEthUsdFeed,
      deployer.address
    );
    await hedgeManager.waitForDeployment();

    // Deploy RebalanceController
    const RebalanceControllerFactory = await ethers.getContractFactory("RebalanceController");
    const rebalanceController = await RebalanceControllerFactory.deploy(
      await vault.getAddress(),
      deployer.address
    );
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

    // Get USDC contract for interactions
    const usdc = await ethers.getContractAt("IERC20", addresses.usdc);

    return {
      vault,
      liquidityManager,
      hedgeManager,
      rebalanceController,
      usdc,
      deployer,
      guardian,
      user,
      addresses,
    };
  }

  describe("Contract Deployment", function () {
    it("should deploy DeltaNeutralVault with correct parameters", async function () {
      const { vault, addresses, deployer } = await loadFixture(deployAllContractsFixture);

      expect(await vault.asset()).to.equal(addresses.usdc);
      expect(await vault.name()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.vaultName);
      expect(await vault.symbol()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.vaultSymbol);
      expect(await vault.owner()).to.equal(deployer.address);
    });

    it("should deploy LiquidityManager with correct parameters", async function () {
      const { liquidityManager, addresses, deployer } =
        await loadFixture(deployAllContractsFixture);

      expect(await liquidityManager.positionManager()).to.equal(addresses.uniswapV3PositionManager);
      expect(await liquidityManager.swapRouter()).to.equal(addresses.uniswapV3SwapRouter);
      expect(await liquidityManager.factory()).to.equal(addresses.uniswapV3Factory);
      expect(await liquidityManager.baseToken()).to.equal(addresses.weth);
      expect(await liquidityManager.quoteToken()).to.equal(addresses.usdc);
      expect(await liquidityManager.poolFee()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.poolFee);
      expect(await liquidityManager.owner()).to.equal(deployer.address);
    });

    it("should deploy HedgeManager with correct parameters", async function () {
      const { hedgeManager, addresses, deployer } = await loadFixture(deployAllContractsFixture);

      expect(await hedgeManager.exchangeRouter()).to.equal(addresses.gmxExchangeRouter);
      expect(await hedgeManager.market()).to.equal(addresses.gmxEthUsdMarket);
      expect(await hedgeManager.collateralToken()).to.equal(addresses.usdc);
      expect(await hedgeManager.indexToken()).to.equal(addresses.weth);
      expect(await hedgeManager.priceFeed()).to.equal(addresses.chainlinkEthUsdFeed);
      expect(await hedgeManager.owner()).to.equal(deployer.address);
    });

    it("should deploy RebalanceController with correct parameters", async function () {
      const { rebalanceController, vault, deployer } = await loadFixture(deployAllContractsFixture);

      expect(await rebalanceController.vault()).to.equal(await vault.getAddress());
      expect(await rebalanceController.owner()).to.equal(deployer.address);
    });
  });

  describe("Contract Configuration", function () {
    it("should configure vault with all managers", async function () {
      const { vault, liquidityManager, hedgeManager, rebalanceController } =
        await loadFixture(deployAllContractsFixture);

      expect(await vault.liquidityManager()).to.equal(await liquidityManager.getAddress());
      expect(await vault.hedgeManager()).to.equal(await hedgeManager.getAddress());
      expect(await vault.rebalanceController()).to.equal(await rebalanceController.getAddress());
    });

    it("should configure LiquidityManager with vault", async function () {
      const { liquidityManager, vault } = await loadFixture(deployAllContractsFixture);

      expect(await liquidityManager.vault()).to.equal(await vault.getAddress());
    });

    it("should configure HedgeManager with vault", async function () {
      const { hedgeManager, vault } = await loadFixture(deployAllContractsFixture);

      expect(await hedgeManager.vault()).to.equal(await vault.getAddress());
    });

    it("should set guardian correctly", async function () {
      const { vault, guardian } = await loadFixture(deployAllContractsFixture);

      expect(await vault.guardian()).to.equal(guardian.address);
    });

    it("should set deposit cap correctly", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.depositCap()).to.equal(DEFAULT_DEPLOYMENT_CONFIG.initialDepositCap);
    });
  });

  describe("Access Control", function () {
    it("should allow owner to call setManagers", async function () {
      const { vault, deployer } = await loadFixture(deployAllContractsFixture);

      // Owner can update managers
      await expect(
        vault
          .connect(deployer)
          .setManagers(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.not.be.reverted;
    });

    it("should prevent non-owner from calling setManagers", async function () {
      const { vault, user } = await loadFixture(deployAllContractsFixture);

      await expect(
        vault.connect(user).setManagers(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to set deposit cap", async function () {
      const { vault, deployer } = await loadFixture(deployAllContractsFixture);

      const newCap = ethers.parseUnits("100000", 6);
      await expect(vault.connect(deployer).setDepositCap(newCap)).to.not.be.reverted;
      expect(await vault.depositCap()).to.equal(newCap);
    });

    it("should allow owner to set guardian", async function () {
      const { vault, deployer, user } = await loadFixture(deployAllContractsFixture);

      await expect(vault.connect(deployer).setGuardian(user.address)).to.not.be.reverted;
      expect(await vault.guardian()).to.equal(user.address);
    });

    it("should allow guardian to trigger circuit breaker", async function () {
      const { vault, guardian } = await loadFixture(deployAllContractsFixture);

      await expect(vault.connect(guardian).triggerCircuitBreaker()).to.not.be.reverted;
      expect(await vault.circuitBreakerTriggered()).to.be.true;
    });

    it("should prevent non-guardian/owner from triggering circuit breaker", async function () {
      const { vault, user } = await loadFixture(deployAllContractsFixture);

      await expect(vault.connect(user).triggerCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });
  });

  describe("Contract Constants", function () {
    it("should have correct vault constants", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

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
      const { hedgeManager } = await loadFixture(deployAllContractsFixture);

      expect(await hedgeManager.PRECISION()).to.equal(CONSTANTS.PRECISION);
      expect(await hedgeManager.MAX_LEVERAGE()).to.equal(CONSTANTS.MAX_LEVERAGE);
    });
  });

  describe("External Contract Integration", function () {
    it("should connect to valid Uniswap V3 pool", async function () {
      const { liquidityManager } = await loadFixture(deployAllContractsFixture);

      const pool = await liquidityManager.getPool();
      expect(pool).to.not.equal(ethers.ZeroAddress);

      // Verify pool has code
      const code = await ethers.provider.getCode(pool);
      expect(code).to.not.equal("0x");
    });

    it("should connect to valid Chainlink price feed", async function () {
      const { hedgeManager } = await loadFixture(deployAllContractsFixture);

      const priceFeed = await hedgeManager.priceFeed();
      expect(priceFeed).to.equal(ARBITRUM_MAINNET.chainlinkEthUsdFeed);

      // Verify we can get price data
      const priceFeedContract = await ethers.getContractAt("IChainlinkPriceFeed", priceFeed);
      const [, answer, , updatedAt] = await priceFeedContract.latestRoundData();
      expect(answer).to.be.gt(0);
      expect(updatedAt).to.be.gt(0);
    });
  });

  describe("RebalanceController Automation Compatibility", function () {
    it("should implement checkUpkeep correctly", async function () {
      const { rebalanceController } = await loadFixture(deployAllContractsFixture);

      // checkUpkeep should return without reverting
      // Use staticCall to simulate the call and get return values
      const result = await rebalanceController.checkUpkeep.staticCall("0x");
      const upkeepNeeded = result[0];
      const performData = result[1];
      expect(typeof upkeepNeeded).to.equal("boolean");
      expect(typeof performData).to.equal("string");
    });

    it("should have valid upkeep intervals", async function () {
      const { rebalanceController } = await loadFixture(deployAllContractsFixture);

      const minRebalance = await rebalanceController.MIN_REBALANCE_INTERVAL();
      const maxRebalance = await rebalanceController.MAX_REBALANCE_INTERVAL();
      const minCompound = await rebalanceController.MIN_COMPOUND_INTERVAL();
      const minSnapshot = await rebalanceController.MIN_SNAPSHOT_INTERVAL();

      expect(minRebalance).to.equal(CONSTANTS.MIN_REBALANCE_INTERVAL);
      expect(maxRebalance).to.equal(CONSTANTS.MAX_REBALANCE_INTERVAL);
      expect(minCompound).to.equal(CONSTANTS.MIN_COMPOUND_INTERVAL);
      expect(minSnapshot).to.equal(CONSTANTS.MIN_SNAPSHOT_INTERVAL);
    });
  });

  describe("Vault Initialization State", function () {
    it("should start with no LP position", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.lpTokenId()).to.equal(0);
    });

    it("should start with zero fees collected", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.totalFeesCollected()).to.equal(0);
    });

    it("should start with zero funding received", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.totalFundingReceived()).to.equal(0);
    });

    it("should start with circuit breaker not triggered", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.circuitBreakerTriggered()).to.be.false;
    });

    it("should start unpaused", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.paused()).to.be.false;
    });

    it("should start with zero total assets", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.totalAssets()).to.equal(0);
    });

    it("should start with zero total supply", async function () {
      const { vault } = await loadFixture(deployAllContractsFixture);

      expect(await vault.totalSupply()).to.equal(0);
    });
  });

  describe("Manager Initialization State", function () {
    it("should have LiquidityManager with no position", async function () {
      const { liquidityManager } = await loadFixture(deployAllContractsFixture);

      expect(await liquidityManager.tokenId()).to.equal(0);
      expect(await liquidityManager.liquidity()).to.equal(0);
    });

    it("should have HedgeManager with no position", async function () {
      const { hedgeManager } = await loadFixture(deployAllContractsFixture);

      expect(await hedgeManager.hasPosition()).to.be.false;
      expect(await hedgeManager.totalCollateralDeposited()).to.equal(0);
    });

    it("should have default slippage tolerances set", async function () {
      const { liquidityManager, hedgeManager } = await loadFixture(deployAllContractsFixture);

      // LiquidityManager default: 0.5%
      expect(await liquidityManager.slippageTolerance()).to.equal(5n * 10n ** 15n);

      // HedgeManager default: 1%
      expect(await hedgeManager.slippageTolerance()).to.equal(10n ** 16n);
    });
  });
});
