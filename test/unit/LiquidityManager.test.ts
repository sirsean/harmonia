import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  LiquidityManager,
  MockERC20,
  MockNonfungiblePositionManager,
  MockSwapRouter,
  MockUniswapV3Factory,
  MockUniswapV3Pool,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("LiquidityManager", function () {
  // Constants
  const PRECISION = BigInt(10) ** BigInt(18);
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const POOL_FEE = 500; // 0.05%
  const INITIAL_WETH = BigInt(100) * BigInt(10) ** BigInt(WETH_DECIMALS); // 100 WETH
  const INITIAL_USDC = BigInt(200_000) * BigInt(10) ** BigInt(USDC_DECIMALS); // 200k USDC

  // Tick range for ~$1800 - $2200 range when ETH is ~$2000
  const TICK_LOWER = 74000;
  const TICK_UPPER = 76000;

  // Deploy fixture
  async function deployFixture() {
    const [owner, vault, user1] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", WETH_DECIMALS);
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await weth.waitForDeployment();
    await usdc.waitForDeployment();

    // Ensure token order (token0 < token1)
    const wethAddress = await weth.getAddress();
    const usdcAddress = await usdc.getAddress();
    const [token0, token1] =
      wethAddress.toLowerCase() < usdcAddress.toLowerCase() ? [weth, usdc] : [usdc, weth];
    const [token0Address, token1Address] =
      wethAddress.toLowerCase() < usdcAddress.toLowerCase()
        ? [wethAddress, usdcAddress]
        : [usdcAddress, wethAddress];

    // Deploy mock Uniswap contracts
    const MockFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const factory = await MockFactory.deploy();
    await factory.waitForDeployment();

    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const pool = await MockPool.deploy(token0Address, token1Address, POOL_FEE);
    await pool.waitForDeployment();

    // Register pool in factory
    await factory.setPool(token0Address, token1Address, POOL_FEE, await pool.getAddress());

    const MockPositionManager = await ethers.getContractFactory("MockNonfungiblePositionManager");
    const positionManager = await MockPositionManager.deploy();
    await positionManager.waitForDeployment();
    await positionManager.setFactory(await factory.getAddress());

    const MockRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockRouter.deploy();
    await swapRouter.waitForDeployment();

    // Deploy LiquidityManager
    const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
    const liquidityManager = await LiquidityManager.deploy(
      await positionManager.getAddress(),
      await swapRouter.getAddress(),
      await factory.getAddress(),
      wethAddress,
      usdcAddress,
      POOL_FEE,
      owner.address
    );
    await liquidityManager.waitForDeployment();

    // Set vault
    await liquidityManager.connect(owner).setVault(vault.address);

    // Mint tokens to vault
    await weth.mint(vault.address, INITIAL_WETH);
    await usdc.mint(vault.address, INITIAL_USDC);

    // Mint tokens to position manager for simulate decreaseLiquidity returns
    await weth.mint(await positionManager.getAddress(), INITIAL_WETH * 10n);
    await usdc.mint(await positionManager.getAddress(), INITIAL_USDC * 10n);

    // Approve LiquidityManager to spend vault tokens
    await weth.connect(vault).approve(await liquidityManager.getAddress(), ethers.MaxUint256);
    await usdc.connect(vault).approve(await liquidityManager.getAddress(), ethers.MaxUint256);

    return {
      liquidityManager,
      positionManager,
      swapRouter,
      factory,
      pool,
      weth,
      usdc,
      token0,
      token1,
      token0Address,
      token1Address,
      owner,
      vault,
      user1,
    };
  }

  describe("Deployment", function () {
    it("should deploy with correct parameters", async function () {
      const { liquidityManager, positionManager, swapRouter, factory, weth, usdc, owner } =
        await loadFixture(deployFixture);

      expect(await liquidityManager.positionManager()).to.equal(await positionManager.getAddress());
      expect(await liquidityManager.swapRouter()).to.equal(await swapRouter.getAddress());
      expect(await liquidityManager.factory()).to.equal(await factory.getAddress());
      expect(await liquidityManager.baseToken()).to.equal(await weth.getAddress());
      expect(await liquidityManager.quoteToken()).to.equal(await usdc.getAddress());
      expect(await liquidityManager.poolFee()).to.equal(POOL_FEE);
      expect(await liquidityManager.owner()).to.equal(owner.address);
    });

    it("should have correct constants", async function () {
      const { liquidityManager } = await loadFixture(deployFixture);

      expect(await liquidityManager.PRECISION()).to.equal(PRECISION);
      expect(await liquidityManager.MAX_SLIPPAGE()).to.equal(BigInt(1e16)); // 1%
      expect(await liquidityManager.DEFAULT_SLIPPAGE()).to.equal(BigInt(5e15)); // 0.5%
    });

    it("should revert on zero addresses", async function () {
      const { swapRouter, factory, weth, usdc, owner, positionManager } =
        await loadFixture(deployFixture);
      const LiquidityManager = await ethers.getContractFactory("LiquidityManager");

      await expect(
        LiquidityManager.deploy(
          ethers.ZeroAddress,
          await swapRouter.getAddress(),
          await factory.getAddress(),
          await weth.getAddress(),
          await usdc.getAddress(),
          POOL_FEE,
          owner.address
        )
      ).to.be.revertedWithCustomError(LiquidityManager, "ZeroAddress");

      await expect(
        LiquidityManager.deploy(
          await positionManager.getAddress(),
          ethers.ZeroAddress,
          await factory.getAddress(),
          await weth.getAddress(),
          await usdc.getAddress(),
          POOL_FEE,
          owner.address
        )
      ).to.be.revertedWithCustomError(LiquidityManager, "ZeroAddress");
    });

    it("should initialize with no position", async function () {
      const { liquidityManager } = await loadFixture(deployFixture);

      expect(await liquidityManager.tokenId()).to.equal(0n);
      expect(await liquidityManager.liquidity()).to.equal(0n);
    });
  });

  describe("Vault Management", function () {
    it("should allow owner to set vault", async function () {
      const { liquidityManager, owner, user1 } = await loadFixture(deployFixture);

      await liquidityManager.connect(owner).setVault(user1.address);
      expect(await liquidityManager.vault()).to.equal(user1.address);
    });

    it("should emit VaultUpdated event", async function () {
      const { liquidityManager, owner, vault, user1 } = await loadFixture(deployFixture);

      await expect(liquidityManager.connect(owner).setVault(user1.address))
        .to.emit(liquidityManager, "VaultUpdated")
        .withArgs(vault.address, user1.address);
    });

    it("should reject non-owner setting vault", async function () {
      const { liquidityManager, user1 } = await loadFixture(deployFixture);

      await expect(
        liquidityManager.connect(user1).setVault(user1.address)
      ).to.be.revertedWithCustomError(liquidityManager, "OwnableUnauthorizedAccount");
    });

    it("should reject zero address vault", async function () {
      const { liquidityManager, owner } = await loadFixture(deployFixture);

      await expect(
        liquidityManager.connect(owner).setVault(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(liquidityManager, "ZeroAddress");
    });
  });

  describe("Slippage Management", function () {
    it("should allow owner to set slippage tolerance", async function () {
      const { liquidityManager, owner } = await loadFixture(deployFixture);

      const newSlippage = BigInt(3e15); // 0.3%
      await liquidityManager.connect(owner).setSlippageTolerance(newSlippage);
      expect(await liquidityManager.slippageTolerance()).to.equal(newSlippage);
    });

    it("should emit SlippageToleranceUpdated event", async function () {
      const { liquidityManager, owner } = await loadFixture(deployFixture);

      const defaultSlippage = BigInt(5e15);
      const newSlippage = BigInt(3e15);

      await expect(liquidityManager.connect(owner).setSlippageTolerance(newSlippage))
        .to.emit(liquidityManager, "SlippageToleranceUpdated")
        .withArgs(defaultSlippage, newSlippage);
    });

    it("should reject slippage above maximum", async function () {
      const { liquidityManager, owner } = await loadFixture(deployFixture);

      const tooHighSlippage = BigInt(2e16); // 2% > MAX_SLIPPAGE (1%)
      await expect(
        liquidityManager.connect(owner).setSlippageTolerance(tooHighSlippage)
      ).to.be.revertedWithCustomError(liquidityManager, "SlippageTooHigh");
    });
  });

  describe("Mint Position", function () {
    it("should mint a new position", async function () {
      const { liquidityManager, vault, weth, usdc, token0Address, token1Address } =
        await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      // Determine correct amounts based on token order
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      expect(await liquidityManager.tokenId()).to.be.gt(0n);
      expect(await liquidityManager.liquidity()).to.be.gt(0n);
      expect(await liquidityManager.tickLower()).to.equal(TICK_LOWER);
      expect(await liquidityManager.tickUpper()).to.equal(TICK_UPPER);
    });

    it("should emit PositionMinted event", async function () {
      const { liquidityManager, vault, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager
          .connect(vault)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.emit(liquidityManager, "PositionMinted");
    });

    it("should reject if position already exists", async function () {
      const { liquidityManager, vault, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      await expect(
        liquidityManager
          .connect(vault)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "PositionExists");
    });

    it("should reject invalid tick range", async function () {
      const { liquidityManager, vault, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      // tickLower >= tickUpper
      await expect(
        liquidityManager
          .connect(vault)
          .mintPosition(TICK_UPPER, TICK_LOWER, amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTickRange");
    });

    it("should reject zero amounts", async function () {
      const { liquidityManager, vault } = await loadFixture(deployFixture);

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).mintPosition(TICK_LOWER, TICK_UPPER, 0n, 0n, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "ZeroAmount");
    });

    it("should reject expired deadline", async function () {
      const { liquidityManager, vault, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) - 1; // Expired

      await expect(
        liquidityManager
          .connect(vault)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "DeadlineExpired");
    });

    it("should reject non-vault caller", async function () {
      const { liquidityManager, user1, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager
          .connect(user1)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "OnlyVault");
    });
  });

  describe("Increase Liquidity", function () {
    async function mintPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      return fixtures;
    }

    it("should increase liquidity in existing position", async function () {
      const { liquidityManager, vault, weth, usdc } = await mintPositionFixture();

      const liquidityBefore = await liquidityManager.liquidity();

      const wethAmount = BigInt(5) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await liquidityManager.connect(vault).increaseLiquidity(amount0, amount1, deadline);

      expect(await liquidityManager.liquidity()).to.be.gt(liquidityBefore);
    });

    it("should emit LiquidityIncreased event", async function () {
      const { liquidityManager, vault, weth, usdc } = await mintPositionFixture();

      const wethAmount = BigInt(5) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).increaseLiquidity(amount0, amount1, deadline)
      ).to.emit(liquidityManager, "LiquidityIncreased");
    });

    it("should reject if no position exists", async function () {
      const { liquidityManager, vault, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(5) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).increaseLiquidity(amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "NoPosition");
    });
  });

  describe("Decrease Liquidity", function () {
    async function mintPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      return fixtures;
    }

    it("should decrease liquidity", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const liquidityBefore = await liquidityManager.liquidity();
      const liquidityToRemove = liquidityBefore / 2n;

      const deadline = (await time.latest()) + 3600;

      await liquidityManager.connect(vault).decreaseLiquidity(liquidityToRemove, deadline);

      expect(await liquidityManager.liquidity()).to.equal(liquidityBefore - liquidityToRemove);
    });

    it("should emit LiquidityDecreased event", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const liquidityToRemove = (await liquidityManager.liquidity()) / 2n;
      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).decreaseLiquidity(liquidityToRemove, deadline)
      ).to.emit(liquidityManager, "LiquidityDecreased");
    });

    it("should reject if no position exists", async function () {
      const { liquidityManager, vault } = await loadFixture(deployFixture);

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).decreaseLiquidity(1000n, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "NoPosition");
    });

    it("should reject zero liquidity removal", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager.connect(vault).decreaseLiquidity(0n, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "ZeroAmount");
    });
  });

  describe("Collect Fees", function () {
    async function mintPositionWithFeesFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc, positionManager } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      // Simulate fee accumulation
      const tokenId = await liquidityManager.tokenId();
      const fees0 = BigInt(1) * BigInt(10) ** BigInt(WETH_DECIMALS); // 1 WETH
      const fees1 = BigInt(2000) * BigInt(10) ** BigInt(USDC_DECIMALS); // 2000 USDC

      const [feesToken0, feesToken1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [fees0, fees1]
          : [fees1, fees0];

      await positionManager.setTokensOwed(tokenId, feesToken0, feesToken1);

      return { ...fixtures, fees0: feesToken0, fees1: feesToken1 };
    }

    it("should collect accumulated fees", async function () {
      const { liquidityManager, vault, fees0, fees1 } = await mintPositionWithFeesFixture();

      const [amount0, amount1] = await liquidityManager.connect(vault).collectFees.staticCall();

      expect(amount0).to.equal(fees0);
      expect(amount1).to.equal(fees1);
    });

    it("should emit FeesCollected event", async function () {
      const { liquidityManager, vault, fees0, fees1 } = await mintPositionWithFeesFixture();
      const tokenId = await liquidityManager.tokenId();

      await expect(liquidityManager.connect(vault).collectFees())
        .to.emit(liquidityManager, "FeesCollected")
        .withArgs(tokenId, fees0, fees1);
    });

    it("should update total fees collected", async function () {
      const { liquidityManager, vault, fees0, fees1 } = await mintPositionWithFeesFixture();

      await liquidityManager.connect(vault).collectFees();

      expect(await liquidityManager.totalFeesCollected0()).to.equal(fees0);
      expect(await liquidityManager.totalFeesCollected1()).to.equal(fees1);
    });

    it("should reject if no position exists", async function () {
      const { liquidityManager, vault } = await loadFixture(deployFixture);

      await expect(liquidityManager.connect(vault).collectFees()).to.be.revertedWithCustomError(
        liquidityManager,
        "NoPosition"
      );
    });
  });

  describe("Adjust Range", function () {
    async function mintPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      return fixtures;
    }

    it("should adjust position range", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const oldTokenId = await liquidityManager.tokenId();
      const newTickLower = 73000;
      const newTickUpper = 77000;

      const deadline = (await time.latest()) + 3600;

      await liquidityManager.connect(vault).adjustRange(newTickLower, newTickUpper, deadline);

      expect(await liquidityManager.tokenId()).to.not.equal(oldTokenId);
      expect(await liquidityManager.tickLower()).to.equal(newTickLower);
      expect(await liquidityManager.tickUpper()).to.equal(newTickUpper);
    });

    it("should emit RangeAdjusted event", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const oldTokenId = await liquidityManager.tokenId();
      const newTickLower = 73000;
      const newTickUpper = 77000;

      const deadline = (await time.latest()) + 3600;

      const tx = await liquidityManager
        .connect(vault)
        .adjustRange(newTickLower, newTickUpper, deadline);
      const receipt = await tx.wait();

      // Check event emission
      const event = receipt?.logs.find(
        (log) => log.topics[0] === liquidityManager.interface.getEvent("RangeAdjusted")!.topicHash
      );
      expect(event).to.not.be.undefined;
    });

    it("should reject invalid new tick range", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      const deadline = (await time.latest()) + 3600;

      // newTickLower >= newTickUpper
      await expect(
        liquidityManager.connect(vault).adjustRange(77000, 73000, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTickRange");
    });
  });

  describe("Close Position", function () {
    async function mintPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      return fixtures;
    }

    it("should close position completely", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();

      await liquidityManager.connect(vault).closePosition();

      expect(await liquidityManager.tokenId()).to.equal(0n);
      expect(await liquidityManager.liquidity()).to.equal(0n);
      expect(await liquidityManager.tickLower()).to.equal(0);
      expect(await liquidityManager.tickUpper()).to.equal(0);
    });

    it("should emit PositionClosed event", async function () {
      const { liquidityManager, vault } = await mintPositionFixture();
      const tokenId = await liquidityManager.tokenId();

      await expect(liquidityManager.connect(vault).closePosition()).to.emit(
        liquidityManager,
        "PositionClosed"
      );
    });

    it("should reject if no position exists", async function () {
      const { liquidityManager, vault } = await loadFixture(deployFixture);

      await expect(liquidityManager.connect(vault).closePosition()).to.be.revertedWithCustomError(
        liquidityManager,
        "NoPosition"
      );
    });
  });

  describe("View Functions", function () {
    async function mintPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { liquidityManager, vault, weth, usdc } = fixtures;

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;
      await liquidityManager
        .connect(vault)
        .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline);

      return fixtures;
    }

    it("should return position value", async function () {
      const { liquidityManager } = await mintPositionFixture();

      const value = await liquidityManager.getPositionValue();
      expect(value).to.be.gt(0n);
    });

    it("should return 0 for position value when no position", async function () {
      const { liquidityManager } = await loadFixture(deployFixture);

      expect(await liquidityManager.getPositionValue()).to.equal(0n);
    });

    it("should return position delta", async function () {
      const { liquidityManager } = await mintPositionFixture();

      const delta = await liquidityManager.getPositionDelta();
      // Delta should be non-zero when in range
      expect(delta).to.not.equal(0n);
    });

    it("should return position delta ratio", async function () {
      const { liquidityManager } = await mintPositionFixture();

      const deltaRatio = await liquidityManager.getPositionDeltaRatio();
      // Should be between 0 and 1e18
      expect(deltaRatio).to.be.gte(0n);
      expect(deltaRatio).to.be.lte(PRECISION);
    });

    it("should return token amounts", async function () {
      const { liquidityManager } = await mintPositionFixture();

      const [amount0, amount1] = await liquidityManager.getTokenAmounts();
      // At least one should be non-zero
      expect(amount0 + amount1).to.be.gt(0n);
    });

    it("should return position info", async function () {
      const { liquidityManager } = await mintPositionFixture();

      const [tokenId, tickLower, tickUpper, liquidity] = await liquidityManager.getPositionInfo();

      expect(tokenId).to.be.gt(0n);
      expect(tickLower).to.equal(TICK_LOWER);
      expect(tickUpper).to.equal(TICK_UPPER);
      expect(liquidity).to.be.gt(0n);
    });

    it("should check if position is in range", async function () {
      const { liquidityManager, pool } = await mintPositionFixture();

      // Set pool tick to be in range
      await pool.setCurrentTick(75000); // Between TICK_LOWER and TICK_UPPER

      expect(await liquidityManager.isInRange()).to.be.true;
    });

    it("should return false for isInRange when out of range", async function () {
      const { liquidityManager, pool } = await mintPositionFixture();

      // Set pool tick to be outside range
      await pool.setCurrentTick(80000); // Above TICK_UPPER

      expect(await liquidityManager.isInRange()).to.be.false;
    });

    it("should return pool address", async function () {
      const { liquidityManager, pool } = await loadFixture(deployFixture);

      expect(await liquidityManager.getPool()).to.equal(await pool.getAddress());
    });
  });

  describe("Access Control", function () {
    it("should allow owner to call vault functions", async function () {
      const { liquidityManager, owner, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      // Mint tokens to owner
      await weth.mint(owner.address, wethAmount);
      await usdc.mint(owner.address, usdcAmount);

      // Approve
      await weth.connect(owner).approve(await liquidityManager.getAddress(), ethers.MaxUint256);
      await usdc.connect(owner).approve(await liquidityManager.getAddress(), ethers.MaxUint256);

      const deadline = (await time.latest()) + 3600;

      // Owner can call vault functions
      await expect(
        liquidityManager
          .connect(owner)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.not.be.reverted;
    });

    it("should reject unauthorized users from vault functions", async function () {
      const { liquidityManager, user1, weth, usdc } = await loadFixture(deployFixture);

      const wethAmount = BigInt(10) * BigInt(10) ** BigInt(WETH_DECIMALS);
      const usdcAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const wethAddress = await weth.getAddress();
      const [amount0, amount1] =
        wethAddress.toLowerCase() < (await usdc.getAddress()).toLowerCase()
          ? [wethAmount, usdcAmount]
          : [usdcAmount, wethAmount];

      const deadline = (await time.latest()) + 3600;

      await expect(
        liquidityManager
          .connect(user1)
          .mintPosition(TICK_LOWER, TICK_UPPER, amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "OnlyVault");

      await expect(
        liquidityManager.connect(user1).increaseLiquidity(amount0, amount1, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "OnlyVault");

      await expect(
        liquidityManager.connect(user1).decreaseLiquidity(1000n, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "OnlyVault");

      await expect(liquidityManager.connect(user1).collectFees()).to.be.revertedWithCustomError(
        liquidityManager,
        "OnlyVault"
      );

      await expect(
        liquidityManager.connect(user1).adjustRange(73000, 77000, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "OnlyVault");

      await expect(liquidityManager.connect(user1).closePosition()).to.be.revertedWithCustomError(
        liquidityManager,
        "OnlyVault"
      );
    });
  });

  describe("Integration with Vault", function () {
    it("should work with vault contract", async function () {
      const { liquidityManager, vault, weth, usdc, owner } = await loadFixture(deployFixture);

      // Deploy actual vault
      const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
      const actualVault = await DeltaNeutralVault.deploy(
        await usdc.getAddress(),
        "Harmonia Delta Neutral",
        "hdnUSDC",
        owner.address
      );
      await actualVault.waitForDeployment();

      // Set managers
      await actualVault
        .connect(owner)
        .setManagers(await liquidityManager.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress);

      // Update liquidity manager's vault
      await liquidityManager.connect(owner).setVault(await actualVault.getAddress());

      // Deposit to vault (assets remain idle since we're not fully deploying)
      await usdc.mint(owner.address, BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS));
      await usdc.connect(owner).approve(await actualVault.getAddress(), ethers.MaxUint256);
      await actualVault
        .connect(owner)
        .deposit(BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS), owner.address);

      // Vault should report 0 LP value initially (no position minted yet)
      expect(await actualVault.getLPValue()).to.equal(0n);
    });
  });
});
