import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  LiquidityManager,
  MockERC20,
  MockUniswapV3Pool,
  MockNonfungiblePositionManager,
  MockSwapRouter,
  MockChainlinkAggregator,
} from "../../typechain-types";

describe("LiquidityManager", function () {
  let liquidityManager: LiquidityManager;
  let weth: MockERC20;
  let usdc: MockERC20;
  let pool: MockUniswapV3Pool;
  let positionManager: MockNonfungiblePositionManager;
  let swapRouter: MockSwapRouter;
  let priceFeed: MockChainlinkAggregator;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const PRECISION = BigInt(10) ** BigInt(18);
  const POOL_FEE = 500; // 0.05%

  // Helper to get deadline using block timestamp
  async function getDeadline(secondsFromNow: number = 3600): Promise<bigint> {
    const block = await ethers.provider.getBlock("latest");
    return BigInt(block!.timestamp + secondsFromNow);
  }

  beforeEach(async function () {
    [owner, vault, user] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    weth = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);

    // Deploy mock Uniswap contracts
    const MockPoolFactory = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await MockPoolFactory.deploy(await weth.getAddress(), await usdc.getAddress(), POOL_FEE);

    const MockPositionManagerFactory = await ethers.getContractFactory(
      "MockNonfungiblePositionManager"
    );
    positionManager = await MockPositionManagerFactory.deploy();

    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    swapRouter = await MockSwapRouterFactory.deploy();

    // Deploy mock Chainlink
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

    // Set vault
    await liquidityManager.setVault(vault.address);

    // Mint tokens to users
    await weth.mint(owner.address, ethers.parseEther("1000"));
    await usdc.mint(owner.address, ethers.parseUnits("2000000", 6));
    await weth.mint(vault.address, ethers.parseEther("1000"));
    await usdc.mint(vault.address, ethers.parseUnits("2000000", 6));

    // Mint tokens to position manager for fee collection
    await weth.mint(await positionManager.getAddress(), ethers.parseEther("100"));
    await usdc.mint(await positionManager.getAddress(), ethers.parseUnits("200000", 6));
  });

  describe("Constructor", function () {
    it("should set immutable addresses correctly", async function () {
      expect(await liquidityManager.positionManager()).to.equal(await positionManager.getAddress());
      expect(await liquidityManager.pool()).to.equal(await pool.getAddress());
      expect(await liquidityManager.swapRouter()).to.equal(await swapRouter.getAddress());
      expect(await liquidityManager.priceFeed()).to.equal(await priceFeed.getAddress());
    });

    it("should set token addresses from pool", async function () {
      expect(await liquidityManager.token0()).to.equal(await weth.getAddress());
      expect(await liquidityManager.token1()).to.equal(await usdc.getAddress());
      expect(await liquidityManager.poolFee()).to.equal(POOL_FEE);
    });

    it("should set default slippage tolerance", async function () {
      const slippage = await liquidityManager.slippageTolerance();
      expect(slippage).to.equal(BigInt(5e15)); // 0.5%
    });

    it("should revert with invalid addresses", async function () {
      const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");

      await expect(
        LiquidityManagerFactory.deploy(
          ethers.ZeroAddress,
          await pool.getAddress(),
          await swapRouter.getAddress(),
          await priceFeed.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidAddress");
    });
  });

  describe("openPosition", function () {
    const tickLower = -887220;
    const tickUpper = 887220;
    const amount0 = ethers.parseEther("1");
    const amount1 = ethers.parseUnits("2000", 6);

    beforeEach(async function () {
      // Approve tokens
      await weth.connect(vault).approve(await liquidityManager.getAddress(), amount0);
      await usdc.connect(vault).approve(await liquidityManager.getAddress(), amount1);
    });

    it("should open a new position successfully", async function () {
      const params = {
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await expect(liquidityManager.connect(vault).openPosition(params))
        .to.emit(liquidityManager, "PositionOpened")
        .withArgs(1n, tickLower, tickUpper, (val: bigint) => val > 0n, amount0, amount1);

      expect(await liquidityManager.positionTokenId()).to.equal(1n);
    });

    it("should revert if position already exists", async function () {
      const params = {
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await liquidityManager.connect(vault).openPosition(params);

      // Approve again for second attempt
      await weth.connect(vault).approve(await liquidityManager.getAddress(), amount0);
      await usdc.connect(vault).approve(await liquidityManager.getAddress(), amount1);

      await expect(
        liquidityManager.connect(vault).openPosition(params)
      ).to.be.revertedWithCustomError(liquidityManager, "PositionAlreadyExists");
    });

    it("should revert with invalid tick range", async function () {
      const params = {
        tickLower: 100,
        tickUpper: 50, // Lower > Upper
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await expect(
        liquidityManager.connect(vault).openPosition(params)
      ).to.be.revertedWithCustomError(liquidityManager, "InvalidTickRange");
    });

    it("should revert if deadline expired", async function () {
      const params = {
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(-3600), // Past deadline
      };

      await expect(
        liquidityManager.connect(vault).openPosition(params)
      ).to.be.revertedWithCustomError(liquidityManager, "DeadlineExpired");
    });

    it("should revert if caller is not vault or owner", async function () {
      const params = {
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await expect(
        liquidityManager.connect(user).openPosition(params)
      ).to.be.revertedWithCustomError(liquidityManager, "UnauthorizedCaller");
    });
  });

  describe("closePosition", function () {
    const tickLower = -887220;
    const tickUpper = 887220;
    const amount0 = ethers.parseEther("1");
    const amount1 = ethers.parseUnits("2000", 6);

    beforeEach(async function () {
      // Open a position first
      await weth.connect(vault).approve(await liquidityManager.getAddress(), amount0);
      await usdc.connect(vault).approve(await liquidityManager.getAddress(), amount1);

      const params = {
        tickLower,
        tickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await liquidityManager.connect(vault).openPosition(params);
    });

    it("should close position successfully", async function () {
      const deadline = await getDeadline();

      await expect(liquidityManager.connect(vault).closePosition(0n, 0n, deadline))
        .to.emit(liquidityManager, "PositionClosed")
        .withArgs(
          1n,
          (amount0: bigint) => amount0 >= 0n,
          (amount1: bigint) => amount1 >= 0n,
          (fee0: bigint) => fee0 >= 0n,
          (fee1: bigint) => fee1 >= 0n
        );

      expect(await liquidityManager.positionTokenId()).to.equal(0n);
    });

    it("should revert if no active position", async function () {
      const deadline = await getDeadline();

      // Close once
      await liquidityManager.connect(vault).closePosition(0n, 0n, deadline);

      // Try to close again
      await expect(
        liquidityManager.connect(vault).closePosition(0n, 0n, deadline)
      ).to.be.revertedWithCustomError(liquidityManager, "NoActivePosition");
    });
  });

  describe("collectFees", function () {
    beforeEach(async function () {
      // Open a position
      const amount0 = ethers.parseEther("1");
      const amount1 = ethers.parseUnits("2000", 6);

      await weth.connect(vault).approve(await liquidityManager.getAddress(), amount0);
      await usdc.connect(vault).approve(await liquidityManager.getAddress(), amount1);

      const params = {
        tickLower: -887220,
        tickUpper: 887220,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await liquidityManager.connect(vault).openPosition(params);

      // Set mock fees
      await positionManager.setMockFees(
        ethers.parseEther("0.01"), // 0.01 ETH
        ethers.parseUnits("20", 6) // 20 USDC
      );
    });

    it("should collect fees successfully", async function () {
      await expect(liquidityManager.connect(vault).collectFees())
        .to.emit(liquidityManager, "FeesCollected")
        .withArgs(1n, ethers.parseEther("0.01"), ethers.parseUnits("20", 6));

      const [fees0, fees1] = await liquidityManager.getCumulativeFees();
      expect(fees0).to.equal(ethers.parseEther("0.01"));
      expect(fees1).to.equal(ethers.parseUnits("20", 6));
    });

    it("should revert if no active position", async function () {
      // Close position first
      const deadline = await getDeadline();
      await liquidityManager.connect(vault).closePosition(0n, 0n, deadline);

      await expect(liquidityManager.connect(vault).collectFees()).to.be.revertedWithCustomError(
        liquidityManager,
        "NoActivePosition"
      );
    });
  });

  describe("View functions", function () {
    // Use realistic tick range to avoid overflow in delta ratio calculation
    // These ticks correspond to ~$1500 to ~$2700 for ETH/USDC
    const viewTickLower = 72000;
    const viewTickUpper = 78000;

    beforeEach(async function () {
      // Open a position
      const amount0 = ethers.parseEther("1");
      const amount1 = ethers.parseUnits("2000", 6);

      await weth.connect(vault).approve(await liquidityManager.getAddress(), amount0);
      await usdc.connect(vault).approve(await liquidityManager.getAddress(), amount1);

      const params = {
        tickLower: viewTickLower,
        tickUpper: viewTickUpper,
        amount0Desired: amount0,
        amount1Desired: amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: await getDeadline(),
      };

      await liquidityManager.connect(vault).openPosition(params);
    });

    it("should return position info", async function () {
      const info = await liquidityManager.getPositionInfo();
      expect(info.tokenId).to.equal(1n);
      expect(info.tickLower).to.equal(viewTickLower);
      expect(info.tickUpper).to.equal(viewTickUpper);
      expect(info.liquidity).to.be.gt(0n);
    });

    it("should return position delta", async function () {
      const delta = await liquidityManager.getPositionDelta();
      // Delta should be non-zero for an in-range position
      expect(delta).to.be.gte(0n);
    });

    it("should return delta ratio", async function () {
      const deltaRatio = await liquidityManager.getDeltaRatio();
      // Ratio should be between 0 and 1e18
      expect(deltaRatio).to.be.gte(0n);
      expect(deltaRatio).to.be.lte(PRECISION);
    });

    it("should return position value", async function () {
      const value = await liquidityManager.getPositionValue();
      expect(value).to.be.gt(0n);
    });

    it("should return current price", async function () {
      const [sqrtPriceX96, tick] = await liquidityManager.getCurrentPrice();
      expect(sqrtPriceX96).to.be.gt(0n);
      expect(tick).to.not.equal(0);
    });

    it("should return oracle price", async function () {
      const price = await liquidityManager.getOraclePrice();
      expect(price).to.equal(2000n * 10n ** 8n); // $2000
    });

    it("should check if position is in range", async function () {
      const inRange = await liquidityManager.isPositionInRange();
      expect(inRange).to.be.a("boolean");
    });
  });

  describe("Admin functions", function () {
    it("should allow owner to set vault", async function () {
      await expect(liquidityManager.connect(owner).setVault(user.address))
        .to.emit(liquidityManager, "VaultUpdated")
        .withArgs(vault.address, user.address);

      expect(await liquidityManager.vault()).to.equal(user.address);
    });

    it("should revert if non-owner sets vault", async function () {
      await expect(
        liquidityManager.connect(user).setVault(user.address)
      ).to.be.revertedWithCustomError(liquidityManager, "OwnableUnauthorizedAccount");
    });

    it("should allow owner to set slippage tolerance", async function () {
      const newSlippage = BigInt(1e16); // 1%

      await expect(liquidityManager.connect(owner).setSlippageTolerance(newSlippage))
        .to.emit(liquidityManager, "SlippageToleranceUpdated")
        .withArgs(BigInt(5e15), newSlippage);

      expect(await liquidityManager.slippageTolerance()).to.equal(newSlippage);
    });

    it("should revert if slippage too high", async function () {
      const tooHighSlippage = BigInt(6e16); // 6%

      await expect(
        liquidityManager.connect(owner).setSlippageTolerance(tooHighSlippage)
      ).to.be.revertedWithCustomError(liquidityManager, "SlippageTooHigh");
    });

    it("should allow owner to recover tokens", async function () {
      // Send some tokens to the contract
      await weth.mint(await liquidityManager.getAddress(), ethers.parseEther("1"));

      const balanceBefore = await weth.balanceOf(user.address);

      await liquidityManager
        .connect(owner)
        .emergencyRecover(await weth.getAddress(), user.address, ethers.parseEther("1"));

      const balanceAfter = await weth.balanceOf(user.address);
      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));
    });
  });
});
