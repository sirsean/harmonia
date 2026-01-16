import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  DeltaNeutralVault,
  LiquidityManager,
  HedgeManager,
  MockERC20,
  MockUniswapV3Pool,
  MockUniswapV3Factory,
  MockNonfungiblePositionManager,
  MockSwapRouter,
  MockExchangeRouter,
  MockGMXPriceFeed,
  RebalanceController,
} from "../../typechain-types";

describe("Rebalance Integration", function () {
  // Constants
  const PRECISION = BigInt(10) ** BigInt(18);
  const USDC_DECIMALS = 6;
  const WETH_DECIMALS = 18;
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);

  // Initial Prices
  // ETH = $2000
  const ETH_PRICE = BigInt(2000) * BigInt(10) ** BigInt(18);
  const ETH_PRICE_CHAINLINK = BigInt(2000) * BigInt(10) ** BigInt(8);

  // Initial amounts
  const INITIAL_VAULT_ASSETS = BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS); // $100k

  async function deployFixture() {
    const [owner, user] = await ethers.getSigners();

    // 1. Deploy Tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", WETH_DECIMALS);
    await usdc.waitForDeployment();
    await weth.waitForDeployment();

    // 2. Deploy Uniswap Mocks
    const MockUniswapFactory = await ethers.getContractFactory("MockUniswapV3Factory");
    const uniFactory = await MockUniswapFactory.deploy();

    // Create Pool ETH/USDC 0.05%
    // MockPool constructor sets price to ~2000
    // But we need to ensure token0/token1 order.
    // LiquidityManager sorts them. MockFactory does too.
    await uniFactory.createPool(await weth.getAddress(), await usdc.getAddress(), 500);
    const poolAddress = await uniFactory.getPool(
      await weth.getAddress(),
      await usdc.getAddress(),
      500
    );
    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const uniPool = MockPool.attach(poolAddress) as any as MockUniswapV3Pool; // Type cast for simplicity

    const MockPositionManager = await ethers.getContractFactory("MockNonfungiblePositionManager");
    const positionManager = await MockPositionManager.deploy();
    await positionManager.setFactory(await uniFactory.getAddress());

    const MockRouter = await ethers.getContractFactory("MockSwapRouter");
    const swapRouter = await MockRouter.deploy();

    // 3. Deploy GMX Mocks
    const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
    const gmxRouter = await MockExchangeRouter.deploy();

    const MockPriceFeed = await ethers.getContractFactory("MockGMXPriceFeed");
    const priceFeed = await MockPriceFeed.deploy(ETH_PRICE_CHAINLINK, 8);

    // 4. Deploy Managers
    const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
    const liquidityManager = await LiquidityManager.deploy(
      await positionManager.getAddress(),
      await swapRouter.getAddress(),
      await uniFactory.getAddress(),
      await weth.getAddress(),
      await usdc.getAddress(),
      500, // 0.05%
      owner.address
    );
    // Set price feed for LiquidityManager
    await liquidityManager.setPriceFeed(await priceFeed.getAddress());

    const HedgeManager = await ethers.getContractFactory("HedgeManager");
    const hedgeManager = await HedgeManager.deploy(
      await gmxRouter.getAddress(),
      ethers.Wallet.createRandom().address, // random market
      await usdc.getAddress(),
      await weth.getAddress(),
      await priceFeed.getAddress(),
      owner.address
    );

    // 5. Deploy Vault
    const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = await DeltaNeutralVault.deploy(
      await usdc.getAddress(),
      "Harmonia Vault",
      "hUSDC",
      owner.address
    );

    // 6. Deploy Rebalance Controller
    const RebalanceController = await ethers.getContractFactory("RebalanceController");
    const controller = await RebalanceController.deploy(await vault.getAddress(), owner.address);

    // 7. Wire up everything
    await vault.setManagers(
      await liquidityManager.getAddress(),
      await hedgeManager.getAddress(),
      await controller.getAddress()
    );
    await liquidityManager.setVault(await vault.getAddress());
    await hedgeManager.setVault(await vault.getAddress());

    // 8. Fund Vault & Users
    await usdc.mint(owner.address, INITIAL_VAULT_ASSETS * 2n);
    await weth.mint(owner.address, BigInt(100) * BigInt(10) ** BigInt(18));

    await usdc.approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.approve(await liquidityManager.getAddress(), ethers.MaxUint256);
    await weth.approve(await liquidityManager.getAddress(), ethers.MaxUint256);

    // Deposit into vault
    await vault.deposit(INITIAL_VAULT_ASSETS, owner.address);

    // Fund Managers with tokens to simulate holding positions (Mock PM usually holds tokens but we need to approve)
    await usdc.mint(
      await liquidityManager.getAddress(),
      BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS)
    );
    await weth.mint(await liquidityManager.getAddress(), BigInt(100) * BigInt(10) ** BigInt(18));

    // Fund HedgeManager for collateral
    await usdc.mint(
      await hedgeManager.getAddress(),
      BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS)
    );

    return {
      vault,
      liquidityManager,
      hedgeManager,
      controller,
      uniPool,
      usdc,
      weth,
      priceFeed,
      owner,
    };
  }

  it("should detect out-of-range and rebalance", async function () {
    const { vault, liquidityManager, hedgeManager, uniPool, owner, controller, weth, usdc } =
      await loadFixture(deployFixture);

    // 1. Open an initial position via LiquidityManager (as owner)
    // Tick spacing for 500 fee is 10.
    // Current tick ~74959 (2000 USD/ETH? check mock).
    // Let's check mock default. MockUniswapV3Pool default currentTick is 74959.
    // Range: +/- 1000 ticks. 73960 to 75960. (Must be multiple of 10).
    const tickLower = 74000;
    const tickUpper = 76000;

    const token0 = await uniPool.token0();
    const isToken0Weth = token0.toLowerCase() === (await weth.getAddress()).toLowerCase();

    const amount0 = isToken0Weth
      ? BigInt(10) * BigInt(10) ** BigInt(18)
      : BigInt(20000) * BigInt(10) ** BigInt(6);
    const amount1 = isToken0Weth
      ? BigInt(20000) * BigInt(10) ** BigInt(6)
      : BigInt(10) * BigInt(10) ** BigInt(18);

    await liquidityManager.mintPosition(
      tickLower,
      tickUpper,
      amount0,
      amount1,
      Math.floor(Date.now() / 1000) + 3600
    );

    expect(await liquidityManager.isInRange()).to.be.true;

    // 2. Move price out of range
    // Increase price -> Tick increases. Move to 77000.
    await uniPool.setCurrentTick(77000);
    // Also update sqrtPriceX96 to match roughly (not strictly needed for isInRange but needed for delta calc)
    // sqrt(1.0001^77000) * 2^96.
    // We can just set a high price.
    // MockPool doesn't automatically sync tick and sqrtPrice.
    // DeltaCalculator uses sqrtPrice. isInRange uses tick.
    // Set a very high sqrtPrice (e.g. $3000).
    // sqrt(3000) * 2^96 = 433465...
    // sqrt(2000) * 2^96 = 354319...
    await uniPool.setSqrtPriceX96(BigInt("4334650000000000000000000000"));

    expect(await liquidityManager.isInRange()).to.be.false;

    // 3. Trigger rebalance via owner
    // This should:
    // a) Call adjustRange on LiquidityManager
    // b) Calculate new delta
    // c) Call adjustHedge on HedgeManager

    // Seed LiquidityManager with MASSIVE WETH to allow minting new position (simulating swap or inventory)
    // Needs to be enough to generate >$100 hedge given MockNPM's liquidity formula
    await weth.mint(
      await liquidityManager.getAddress(),
      BigInt(1_000_000) * BigInt(10) ** BigInt(18)
    );

    // Fund Vault with more USDC for collateral (needs > 200k)
    await usdc.mint(
      await vault.getAddress(),
      BigInt(500_000) * BigInt(10) ** BigInt(USDC_DECIMALS)
    );

    // Fund Vault with ETH for execution fees
    await owner.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    // We expect RangeAdjusted event from LiquidityManager
    // We expect HedgeAdjusted event from HedgeManager

    await expect(vault.connect(owner).rebalance(0))
      .to.emit(liquidityManager, "RangeAdjusted")
      .and.to.emit(hedgeManager, "HedgeAdjusted");

    // Verify new range is centered around new tick (77000)
    const posInfo = await liquidityManager.getPositionInfo();
    const newTickLower = posInfo._tickLower;
    const newTickUpper = posInfo._tickUpper;

    // With default multiplier 20 and spacing 10, half width = 200 ticks.
    // 77000 is multiple of 10.
    // Lower should be 76800, Upper 77200.
    expect(newTickLower).to.equal(76800);
    expect(newTickUpper).to.equal(77200);

    // Verify hedge was adjusted
    // Since we moved price up (ETH expensive), LP is now 100% USDC (sold ETH).
    // Delta should be 0.
    // So Hedge should be reduced to 0 (close short).

    // Wait, if price is ABOVE range (77000 > 76000), we hold all USDC.
    // Delta is 0.
    // BUT we just rebalanced to NEW range [76800, 77200].
    // Now we are IN range again.
    // So Delta should be non-zero (approx 0.5 * Liquidity?).
    // So Hedge should have been increased/opened to match new positive Delta.

    const newHedgeSize = await hedgeManager.getPositionSizeUsd();
    expect(newHedgeSize).to.be.gt(0);
  });

  it("should respect range width multiplier", async function () {
    const { vault, liquidityManager, uniPool, owner } = await loadFixture(deployFixture);

    // Set wider multiplier: 100 (half width 1000 ticks)
    await vault.setRangeWidthMultiplier(100);

    // Move tick to 80000
    await uniPool.setCurrentTick(80000);

    // Mock liquidity manager needs a position to adjust, so let's mint one first
    // But we can just rely on the fact that rebalance will fail if no position exists?
    // Wait, LiquidityManager.adjustRange reverts if no position.
    await liquidityManager.mintPosition(79000, 81000, 100, 100, Date.now() + 3600);

    // Move out of that range
    await uniPool.setCurrentTick(82000);
    await uniPool.setSqrtPriceX96(BigInt("4500000000000000000000000000")); // approx

    // Fund Vault with ETH
    await owner.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    await vault.rebalance(0);

    const posInfo = await liquidityManager.getPositionInfo();
    // Center 82000. Half width 100 * 10 = 1000.
    expect(posInfo._tickLower).to.equal(81000);
    expect(posInfo._tickUpper).to.equal(83000);
  });
});
