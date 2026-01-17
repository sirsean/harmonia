import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
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
    // MockPool constructor sets price to ~2000 (assuming token0=WETH)
    // We must adjust if token0=USDC
    await uniFactory.createPool(await weth.getAddress(), await usdc.getAddress(), 500);
    const poolAddress = await uniFactory.getPool(
      await weth.getAddress(),
      await usdc.getAddress(),
      500
    );
    const MockPool = await ethers.getContractFactory("MockUniswapV3Pool");
    const uniPool = MockPool.attach(poolAddress) as any as MockUniswapV3Pool;

    const token0 = await uniPool.token0();
    const isWethToken0 = token0.toLowerCase() === (await weth.getAddress()).toLowerCase();

    if (!isWethToken0) {
      // token0 is USDC. Price should be 1/2000 WETH per USDC.
      // sqrt(1/2000) * 2^96 = sqrt(0.0005) * 2^96
      // sqrt(5e-4) approx 0.02236
      // 0.02236 * 2^96 approx 1.77e27
      // 1771595571142957102961017161
      // Tick: log1.0001(0.0005) = -7601 (approx)
      // -log1.0001(2000) = -76012.
      await uniPool.setSqrtPriceX96(BigInt("1771595571142957102961017161"));
      await uniPool.setCurrentTick(-76012);
    } else {
      // Ensure default is correct (2000)
      await uniPool.setSqrtPriceX96(BigInt("3543191142285914205922034323"));
      await uniPool.setCurrentTick(76012);
    }

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
    const liquidityManager = (await upgrades.deployProxy(
      LiquidityManager,
      [
        await positionManager.getAddress(),
        await swapRouter.getAddress(),
        await uniFactory.getAddress(),
        await weth.getAddress(),
        await usdc.getAddress(),
        500, // 0.05%
        owner.address,
      ],
      { kind: "uups" }
    )) as unknown as LiquidityManager;
    await liquidityManager.waitForDeployment();

    // Set price feed for LiquidityManager
    await liquidityManager.setPriceFeed(await priceFeed.getAddress());

    const HedgeManager = await ethers.getContractFactory("HedgeManager");
    const hedgeManager = (await upgrades.deployProxy(
      HedgeManager,
      [
        await gmxRouter.getAddress(),
        ethers.Wallet.createRandom().address, // random market
        await usdc.getAddress(),
        await weth.getAddress(),
        await priceFeed.getAddress(),
        owner.address,
      ],
      { kind: "uups" }
    )) as unknown as HedgeManager;
    await hedgeManager.waitForDeployment();

    // 5. Deploy Vault
    const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = (await upgrades.deployProxy(
      DeltaNeutralVault,
      [await usdc.getAddress(), "Harmonia Vault", "hUSDC", owner.address],
      { kind: "uups" }
    )) as unknown as DeltaNeutralVault;
    await vault.waitForDeployment();

    // 6. Deploy Rebalance Controller
    const RebalanceController = await ethers.getContractFactory("RebalanceController");
    const controller = (await upgrades.deployProxy(
      RebalanceController,
      [await vault.getAddress(), owner.address],
      { kind: "uups" }
    )) as unknown as RebalanceController;
    await controller.waitForDeployment();

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

    await weth.mint(await swapRouter.getAddress(), BigInt(1000) * BigInt(10) ** BigInt(18));

    // Fund Vault with ETH for execution fees
    await owner.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("10.0"),
    });

    // Deposit into vault
    await vault.deposit(INITIAL_VAULT_ASSETS, owner.address);

    // Fund Managers with tokens to simulate holding positions (Mock PM usually holds tokens but we need to approve)

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

    // 1. Initial position is already created by vault.deposit in fixture
    expect(await liquidityManager.isInRange()).to.be.true;

    // Get current ticks
    const posInfo1 = await liquidityManager.getPositionInfo();
    const currentTickLower = Number(posInfo1._tickLower);
    const currentTickUpper = Number(posInfo1._tickUpper);

    // 2. Move price out of range
    // Move 2000 ticks away (range is +/- 200 by default)
    const newTick = currentTickUpper + 2000;
    await uniPool.setCurrentTick(newTick);

    // Also update sqrtPriceX96 to match rough price change
    // If tick increases, price increases (token1/token0 increases).
    // Just muliply price by some factor? Or set a fixed large/small price based on token0.
    // To be safe, just set a very different price.
    // If we assume default direction (2000 USDC/ETH), higher tick = higher price (more USDC per ETH).
    // If we assume inverse (0.0005 ETH/USDC), higher tick = higher price (more ETH per USDC).
    // Either way, shifting tick by 2000 is enough to be out of range (width 400).
    // And increasing price means we move to the right.

    // We need valid sqrtPrice for Delta calculation.
    // Let's just double the price.
    // sqrt(2*P) * 2^96 = sqrt(2) * sqrt(P) * 2^96 = 1.414 * oldSqrtPrice.
    const oldSqrtPrice = (await uniPool.slot0())[0];
    const newSqrtPrice = (oldSqrtPrice * 1414n) / 1000n;
    await uniPool.setSqrtPriceX96(newSqrtPrice);

    expect(await liquidityManager.isInRange()).to.be.false;

    // 3. Trigger rebalance via owner
    // ... (rest of test)

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

    // Verify new range is centered around new tick
    const posInfo = await liquidityManager.getPositionInfo();
    const newTickLower = posInfo._tickLower;
    const newTickUpper = posInfo._tickUpper;

    // With default multiplier 20 and spacing 10, half width = 200 ticks.
    // Check if range includes newTick and is centered (roughly)
    // Uniswap ticks align to spacing.
    expect(newTick).to.be.gte(Number(newTickLower));
    expect(newTick).to.be.lte(Number(newTickUpper));

    const newHedgeSize = await hedgeManager.getPositionSizeUsd();
    // It should be non-zero if we have delta.
    expect(newHedgeSize).to.be.gt(0);
  });

  it("should respect range width multiplier", async function () {
    const { vault, liquidityManager, uniPool, owner } = await loadFixture(deployFixture);

    // Set wider multiplier: 100 (half width 1000 ticks)
    await vault.setRangeWidthMultiplier(100);

    // Current position is tight (20 multiplier).
    // Move tick slightly out of old range but within new range?
    // No, we want to Trigger rebalance.
    // If we are in range, rebalance might only adjust hedge?
    // But rebalance() calls _executeRebalance which calls adjustRange IF (!inRange).
    // So we must be out of range.

    // Get current ticks
    const posInfo1 = await liquidityManager.getPositionInfo();
    const currentTickUpper = Number(posInfo1._tickUpper);

    // Move out of range
    const newTick = currentTickUpper + 500;
    await uniPool.setCurrentTick(newTick);

    const oldSqrtPrice = (await uniPool.slot0())[0];
    const newSqrtPrice = (oldSqrtPrice * 110n) / 100n; // +10%
    await uniPool.setSqrtPriceX96(newSqrtPrice);

    // Fund Vault with ETH
    await owner.sendTransaction({
      to: await vault.getAddress(),
      value: ethers.parseEther("1.0"),
    });

    await vault.rebalance(0);

    const posInfo = await liquidityManager.getPositionInfo();
    // Center around newTick. Half width 100 * 10 = 1000.
    const expectedHalfWidth = 1000;
    const width = Number(posInfo._tickUpper) - Number(posInfo._tickLower);

    expect(width).to.equal(expectedHalfWidth * 2);
  });
});
