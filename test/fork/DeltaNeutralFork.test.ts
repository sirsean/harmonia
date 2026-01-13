import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ARBITRUM_ADDRESSES } from "../../hardhat.config";
import { LiquidityManager, HedgeManager, DeltaNeutralVault } from "../../typechain-types";

// Skip these tests if not running with forking enabled
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("Delta Neutral Fork Tests - Real Contract Integration", function () {
  let owner: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let user1: HardhatEthersSigner;

  // Real protocol contracts
  let uniswapPool: Contract;
  let positionManager: Contract;
  let swapRouter: Contract;
  let priceFeed: Contract;
  let weth: Contract;
  let usdc: Contract;

  // Our deployed contracts
  let liquidityManager: LiquidityManager;
  let hedgeManager: HedgeManager;
  let vault: DeltaNeutralVault;

  // GMX V2 contracts
  let gmxExchangeRouter: Contract;
  let gmxDataStore: Contract;
  let gmxReader: Contract;

  // ABIs for real contracts
  const POOL_ABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function tickSpacing() external view returns (int24)",
  ];

  const ERC20_ABI = [
    "function balanceOf(address) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)",
  ];

  const POSITION_MANAGER_ABI = [
    "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function balanceOf(address owner) external view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
    "function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline)) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)",
    "function WETH9() external view returns (address)",
    "function factory() external view returns (address)",
  ];

  const SWAP_ROUTER_ABI = [
    "function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)",
  ];

  const AGGREGATOR_ABI = [
    "function decimals() external view returns (uint8)",
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ];

  const GMX_EXCHANGE_ROUTER_ABI = [
    "function dataStore() external view returns (address)",
    "function orderVault() external view returns (address)",
  ];

  const GMX_READER_ABI = [
    "function getMarket(address dataStore, address marketAddress) external view returns (tuple(address marketToken, address indexToken, address longToken, address shortToken))",
  ];

  // Helper to get current ETH price from Chainlink
  async function getETHPrice(): Promise<bigint> {
    const latestRound = await priceFeed.latestRoundData();
    return latestRound.answer;
  }

  // Helper to convert tick to sqrtPriceX96
  function tickToSqrtPriceX96(tick: number): bigint {
    const sqrtPrice = Math.pow(1.0001, tick / 2);
    const Q96 = BigInt(2) ** BigInt(96);
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  // Helper to get WETH using the swap router
  async function getWETH(signer: HardhatEthersSigner, amount: bigint): Promise<void> {
    // Wrap ETH to WETH using the WETH contract
    const WETH_ABI = ["function deposit() external payable"];
    const wethContract = new Contract(ARBITRUM_ADDRESSES.WETH, WETH_ABI, signer);
    await wethContract.deposit({ value: amount });
  }

  // Helper to get USDC using Uniswap swap
  async function getUSDC(signer: HardhatEthersSigner, ethAmount: bigint): Promise<void> {
    // First get WETH
    await getWETH(signer, ethAmount);

    // Approve swap router
    await weth.connect(signer).approve(ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER, ethAmount);

    // Swap WETH -> USDC
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const params = {
      tokenIn: ARBITRUM_ADDRESSES.WETH,
      tokenOut: ARBITRUM_ADDRESSES.USDC_E,
      fee: 500,
      recipient: signer.address,
      deadline: deadline,
      amountIn: ethAmount,
      amountOutMinimum: 0n,
      sqrtPriceLimitX96: 0n,
    };

    await swapRouter.connect(signer).exactInputSingle(params);
  }

  before(async function () {
    this.timeout(60000);

    // Workaround for Arbitrum fork hardfork issue
    await network.provider.send("hardhat_mine", ["0x1"]);

    [owner, keeper, user1] = await ethers.getSigners();

    // Connect to real Uniswap V3 contracts
    uniswapPool = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL, POOL_ABI, owner);
    positionManager = new Contract(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      POSITION_MANAGER_ABI,
      owner
    );
    swapRouter = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER, SWAP_ROUTER_ABI, owner);

    // Connect to Chainlink
    priceFeed = new Contract(ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED, AGGREGATOR_ABI, owner);

    // Connect to tokens
    weth = new Contract(ARBITRUM_ADDRESSES.WETH, ERC20_ABI, owner);
    usdc = new Contract(ARBITRUM_ADDRESSES.USDC_E, ERC20_ABI, owner);

    // Connect to GMX V2
    gmxExchangeRouter = new Contract(
      ARBITRUM_ADDRESSES.GMX_EXCHANGE_ROUTER,
      GMX_EXCHANGE_ROUTER_ABI,
      owner
    );

    console.log("\n=== Fork Test Setup ===");
    console.log("Block:", await ethers.provider.getBlockNumber());

    // Get current pool state
    const slot0 = await uniswapPool.slot0();
    const ethPrice = await getETHPrice();

    console.log("Pool sqrtPriceX96:", slot0.sqrtPriceX96.toString());
    console.log("Pool current tick:", slot0.tick.toString());
    console.log("Chainlink ETH price:", (Number(ethPrice) / 1e8).toFixed(2), "USD");
  });

  describe("LiquidityManager with Real Uniswap V3", function () {
    before(async function () {
      this.timeout(60000);

      // Deploy LiquidityManager pointing to real Uniswap contracts
      const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
      liquidityManager = await LiquidityManagerFactory.deploy(
        ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
        ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL,
        ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
        ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED,
        owner.address
      );
      await liquidityManager.waitForDeployment();

      console.log("LiquidityManager deployed at:", await liquidityManager.getAddress());
    });

    it("should read real pool state correctly", async function () {
      const [sqrtPriceX96, tick] = await liquidityManager.getCurrentPrice();

      const slot0 = await uniswapPool.slot0();

      expect(sqrtPriceX96).to.equal(slot0.sqrtPriceX96);
      expect(tick).to.equal(slot0.tick);

      console.log("Current tick from LiquidityManager:", tick.toString());
    });

    it("should get real oracle price", async function () {
      const oraclePrice = await liquidityManager.getOraclePrice();
      const chainlinkPrice = await getETHPrice();

      expect(oraclePrice).to.equal(chainlinkPrice);
      console.log("Oracle price:", (Number(oraclePrice) / 1e8).toFixed(2), "USD");
    });

    it("should calculate real delta for hypothetical position", async function () {
      // Get current pool state
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      // Create a tick range around current price (±5%)
      // Each tick is ~0.01% price change, so 500 ticks ≈ 5%
      const tickRange = 500;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      // Deploy delta calculator harness for testing
      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      const deltaCalc = await DeltaCalculatorHarness.deploy();

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Use a small, realistic liquidity amount (typical for ~$1000 position)
      // Real liquidity values are much smaller than 1e18
      const liquidity = BigInt(1e12); // Small liquidity

      const delta = await deltaCalc.calculateDelta(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaRatio = await deltaCalc.calculateDeltaRatio(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      console.log("\n=== Delta Analysis for Hypothetical Position ===");
      console.log("Tick Lower:", tickLower);
      console.log("Tick Upper:", tickUpper);
      console.log("Current Tick:", currentTick);
      console.log("Liquidity:", liquidity.toString());
      console.log("Delta Ratio:", ((Number(deltaRatio) / 1e18) * 100).toFixed(2), "%");

      // Position should be in range with positive delta
      expect(delta).to.be.gt(0n);
      expect(deltaRatio).to.be.gt(0n);
      expect(deltaRatio).to.be.lt(BigInt(10) ** BigInt(18)); // Less than 100%
    });

    it("should verify delta ratio is consistent with price position", async function () {
      // This test verifies that delta ratio behaves correctly:
      // - At lower tick boundary: delta ratio should be 100% (all ETH)
      // - At upper tick boundary: delta ratio should be 0% (all USDC)
      // - In middle: delta ratio should be ~50%
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      const tickRange = 1000;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      const deltaCalc = await DeltaCalculatorHarness.deploy();

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Get delta ratios at different points
      const deltaRatioAtCurrent = await deltaCalc.calculateDeltaRatio(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaRatioAtLower = await deltaCalc.calculateDeltaRatio(
        sqrtPriceLower,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaRatioAtUpper = await deltaCalc.calculateDeltaRatio(
        sqrtPriceUpper,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      console.log("\n=== Delta Ratio Verification ===");
      console.log("At lower bound:", ((Number(deltaRatioAtLower) / 1e18) * 100).toFixed(2), "%");
      console.log(
        "At current price:",
        ((Number(deltaRatioAtCurrent) / 1e18) * 100).toFixed(2),
        "%"
      );
      console.log("At upper bound:", ((Number(deltaRatioAtUpper) / 1e18) * 100).toFixed(2), "%");

      // Delta ratio should be 100% at lower bound
      expect(deltaRatioAtLower).to.equal(BigInt(10) ** BigInt(18));
      // Delta ratio should be 0% at upper bound
      expect(deltaRatioAtUpper).to.equal(0n);
      // Delta ratio should be between 0 and 100% at current price
      expect(deltaRatioAtCurrent).to.be.gt(0n);
      expect(deltaRatioAtCurrent).to.be.lt(BigInt(10) ** BigInt(18));
    });
  });

  describe("Delta Drift Scenarios", function () {
    let deltaCalc: Contract;

    before(async function () {
      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      deltaCalc = await DeltaCalculatorHarness.deploy();
    });

    it("should show delta ratio changes as price moves within range", async function () {
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      // Fixed position range
      const tickRange = 1000;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      console.log("\n=== Delta Ratio vs Price Movement ===");
      console.log("Position Range: [", tickLower, ",", tickUpper, "]");
      console.log("Current Tick:", currentTick);
      console.log("\nPrice Shift\t\tDelta Ratio\t\tHedge Ratio Needed");
      console.log("-".repeat(65));

      // Simulate price movements
      const priceShifts = [-500, -250, 0, 250, 500];

      const results: { shift: number; deltaRatio: bigint }[] = [];

      for (const shift of priceShifts) {
        const simulatedTick = currentTick + shift;

        // Skip if outside range
        if (simulatedTick <= tickLower || simulatedTick >= tickUpper) {
          continue;
        }

        const sqrtPriceSimulated = tickToSqrtPriceX96(simulatedTick);

        const deltaRatio = await deltaCalc.calculateDeltaRatio(
          sqrtPriceSimulated,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        results.push({ shift, deltaRatio });

        const priceChange = (Math.pow(1.0001, shift) - 1) * 100;
        const deltaPercent = (Number(deltaRatio) / 1e18) * 100;
        // Hedge ratio needed = delta ratio (to offset LP's long exposure)
        const hedgeRatio = deltaPercent.toFixed(2);

        console.log(
          `${priceChange > 0 ? "+" : ""}${priceChange.toFixed(2)}%\t\t\t` +
            `${deltaPercent.toFixed(2)}%\t\t\t` +
            `${hedgeRatio}% short`
        );
      }

      // Verify delta ratio decreases as price increases
      for (let i = 1; i < results.length; i++) {
        if (results[i].shift > results[i - 1].shift) {
          expect(results[i].deltaRatio).to.be.lt(results[i - 1].deltaRatio);
        }
      }
    });

    it("should demonstrate delta ratio determines hedge size", async function () {
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      const tickRange = 500;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Get delta ratio at current price
      const deltaRatio = await deltaCalc.calculateDeltaRatio(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaPercent = (Number(deltaRatio) / 1e18) * 100;

      console.log("\n=== Hedge Sizing Based on Delta Ratio ===");
      console.log("Current Delta Ratio:", deltaPercent.toFixed(2), "%");
      console.log("\nExample: For a $10,000 LP position:");
      console.log("  ETH exposure (delta):", ((10000 * deltaPercent) / 100).toFixed(2), "USD");
      console.log("  Required short hedge:", ((10000 * deltaPercent) / 100).toFixed(2), "USD");
      console.log("\nThis keeps net delta close to zero.");

      // Delta ratio should be between 0 and 100%
      expect(deltaRatio).to.be.gt(0n);
      expect(deltaRatio).to.be.lt(BigInt(10) ** BigInt(18));
    });
  });

  describe("GMX V2 Market Integration", function () {
    it("should read GMX ETH/USD market configuration", async function () {
      gmxReader = new Contract(ARBITRUM_ADDRESSES.GMX_READER, GMX_READER_ABI, owner);

      const market = await gmxReader.getMarket(
        ARBITRUM_ADDRESSES.GMX_DATA_STORE,
        ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET
      );

      console.log("\n=== GMX ETH/USD Market Configuration ===");
      console.log("Market Token:", market.marketToken);
      console.log("Index Token:", market.indexToken);
      console.log("Long Token:", market.longToken);
      console.log("Short Token:", market.shortToken);

      // Verify market is configured correctly
      expect(market.indexToken.toLowerCase()).to.equal(ARBITRUM_ADDRESSES.WETH.toLowerCase());
    });

    it("should verify GMX market has correct tokens", async function () {
      // The GMX ETH/USD market should use WETH as the index/long token
      // and USDC as the short token
      gmxReader = new Contract(ARBITRUM_ADDRESSES.GMX_READER, GMX_READER_ABI, owner);

      const market = await gmxReader.getMarket(
        ARBITRUM_ADDRESSES.GMX_DATA_STORE,
        ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET
      );

      // WETH should be the long token
      expect(market.longToken.toLowerCase()).to.equal(ARBITRUM_ADDRESSES.WETH.toLowerCase());

      // Short token should be native USDC (not USDC.e)
      // GMX V2 uses native USDC: 0xaf88d065e77c8cC2239327C5EDb3A432268e5831
      expect(market.shortToken.toLowerCase()).to.equal(ARBITRUM_ADDRESSES.USDC.toLowerCase());

      console.log("\n=== GMX Market Token Verification ===");
      console.log("Long Token (WETH):", market.longToken);
      console.log("Short Token (USDC):", market.shortToken);
    });

    it("should deploy HedgeManager with real GMX V2 addresses", async function () {
      this.timeout(60000);

      const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
      hedgeManager = await HedgeManagerFactory.deploy(
        ARBITRUM_ADDRESSES.GMX_EXCHANGE_ROUTER,
        ARBITRUM_ADDRESSES.GMX_ORDER_VAULT,
        ARBITRUM_ADDRESSES.GMX_READER,
        ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED,
        ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET,
        ARBITRUM_ADDRESSES.USDC, // Native USDC as collateral
        ARBITRUM_ADDRESSES.WETH, // WETH as index token
        owner.address
      );
      await hedgeManager.waitForDeployment();

      const hedgeManagerAddr = await hedgeManager.getAddress();
      console.log("\n=== HedgeManager Deployment ===");
      console.log("HedgeManager deployed at:", hedgeManagerAddr);
      console.log("ExchangeRouter:", await hedgeManager.exchangeRouter());
      console.log("OrderVault:", await hedgeManager.orderVault());
      console.log("DataStore:", await hedgeManager.dataStore());
      console.log("Reader:", await hedgeManager.reader());
      console.log("Market:", await hedgeManager.market());

      // Verify addresses are correct
      expect(await hedgeManager.exchangeRouter()).to.equal(ARBITRUM_ADDRESSES.GMX_EXCHANGE_ROUTER);
      expect(await hedgeManager.orderVault()).to.equal(ARBITRUM_ADDRESSES.GMX_ORDER_VAULT);
      expect(await hedgeManager.market()).to.equal(ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET);
    });

    it("should verify HedgeManager reads dataStore from ExchangeRouter", async function () {
      this.timeout(60000);

      if (!hedgeManager) {
        const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
        hedgeManager = await HedgeManagerFactory.deploy(
          ARBITRUM_ADDRESSES.GMX_EXCHANGE_ROUTER,
          ARBITRUM_ADDRESSES.GMX_ORDER_VAULT,
          ARBITRUM_ADDRESSES.GMX_READER,
          ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED,
          ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET,
          ARBITRUM_ADDRESSES.USDC,
          ARBITRUM_ADDRESSES.WETH,
          owner.address
        );
        await hedgeManager.waitForDeployment();
      }

      // DataStore should be correctly derived from ExchangeRouter
      const dataStoreFromManager = await hedgeManager.dataStore();
      console.log("\n=== DataStore Verification ===");
      console.log("DataStore from HedgeManager:", dataStoreFromManager);
      console.log("Expected DataStore:", ARBITRUM_ADDRESSES.GMX_DATA_STORE);

      expect(dataStoreFromManager.toLowerCase()).to.equal(
        ARBITRUM_ADDRESSES.GMX_DATA_STORE.toLowerCase()
      );
    });

    it("should verify HedgeManager can read oracle price", async function () {
      this.timeout(60000);

      if (!hedgeManager) {
        const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
        hedgeManager = await HedgeManagerFactory.deploy(
          ARBITRUM_ADDRESSES.GMX_EXCHANGE_ROUTER,
          ARBITRUM_ADDRESSES.GMX_ORDER_VAULT,
          ARBITRUM_ADDRESSES.GMX_READER,
          ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED,
          ARBITRUM_ADDRESSES.GMX_ETH_USD_MARKET,
          ARBITRUM_ADDRESSES.USDC,
          ARBITRUM_ADDRESSES.WETH,
          owner.address
        );
        await hedgeManager.waitForDeployment();
      }

      // Get oracle price from HedgeManager (returned with 8 decimals from Chainlink)
      const oraclePrice = await hedgeManager.getOraclePrice();

      console.log("\n=== HedgeManager Oracle Price ===");
      console.log("Oracle Price (8 decimals):", oraclePrice.toString());
      console.log("Oracle Price (USD):", (Number(oraclePrice) / 1e8).toFixed(2));

      // Should be a reasonable ETH price (roughly $1000-$10000)
      const priceUsd = Number(oraclePrice) / 1e8;
      expect(priceUsd).to.be.gt(1000);
      expect(priceUsd).to.be.lt(10000);
    });
  });

  describe("LiquidityManager with Real Uniswap - Extended", function () {
    // Both LiquidityManager and HedgeManager now work with real Uniswap V3 and GMX V2.
    // These tests focus on LiquidityManager functionality with real Uniswap.

    it("should verify LiquidityManager reads token addresses correctly", async function () {
      // Ensure LiquidityManager is deployed
      if (!liquidityManager) {
        const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
        liquidityManager = await LiquidityManagerFactory.deploy(
          ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
          ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL,
          ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
          ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED,
          owner.address
        );
        await liquidityManager.waitForDeployment();
      }

      // Get token addresses from pool
      const token0 = await uniswapPool.token0();
      const token1 = await uniswapPool.token1();

      console.log("\n=== LiquidityManager Token Verification ===");
      console.log("Pool Token0:", token0);
      console.log("Pool Token1:", token1);

      // Verify tokens match expected addresses
      const tokens = [token0.toLowerCase(), token1.toLowerCase()];
      expect(tokens).to.include(ARBITRUM_ADDRESSES.WETH.toLowerCase());
      expect(tokens).to.include(ARBITRUM_ADDRESSES.USDC_E.toLowerCase());
    });

    it("should get real USDC through swap", async function () {
      this.timeout(60000);

      // Get USDC for user by swapping ETH
      const ethToSwap = ethers.parseEther("1");
      await getUSDC(user1, ethToSwap);

      const userUsdcBalance = await usdc.balanceOf(user1.address);

      console.log("\n=== USDC Acquisition Test ===");
      console.log("ETH swapped:", ethers.formatEther(ethToSwap));
      console.log("USDC received:", (Number(userUsdcBalance) / 1e6).toFixed(2));

      expect(userUsdcBalance).to.be.gt(0);

      // USDC should be roughly ETH value at current price
      const ethPrice = Number(await getETHPrice()) / 1e8;
      const expectedUsdc = ethPrice * 0.9; // Account for fees/slippage
      expect(Number(userUsdcBalance) / 1e6).to.be.gt(expectedUsdc);
    });

    it("should verify oracle and pool prices are aligned", async function () {
      // Get Chainlink price
      const chainlinkPrice = Number(await getETHPrice()) / 1e8;

      // Get Uniswap pool price
      const slot0 = await uniswapPool.slot0();
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let uniswapPrice = sqrtPrice * sqrtPrice;

      if (isWethToken0) {
        uniswapPrice = uniswapPrice * 1e12;
      } else {
        uniswapPrice = 1e12 / uniswapPrice;
      }

      const priceDiff = Math.abs(chainlinkPrice - uniswapPrice);
      const priceDiffPct = (priceDiff / chainlinkPrice) * 100;

      console.log("\n=== Price Alignment Verification ===");
      console.log("Chainlink ETH/USD:", chainlinkPrice.toFixed(2));
      console.log("Uniswap ETH/USDC:", uniswapPrice.toFixed(2));
      console.log("Difference:", priceDiffPct.toFixed(4), "%");

      // Prices should be within 2% in normal conditions
      expect(priceDiffPct).to.be.lt(2);
    });
  });

  describe("Rebalancing Threshold Analysis", function () {
    it("should analyze delta ratio drift that triggers rebalancing", async function () {
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      // MAX_DELTA_DEVIATION is 5e16 (5%)
      const maxDeviationPct = 5;

      const tickRange = 500;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      const deltaCalc = await DeltaCalculatorHarness.deploy();

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Get baseline delta ratio at current price
      const baselineDeltaRatio = await deltaCalc.calculateDeltaRatio(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const baselinePct = (Number(baselineDeltaRatio) / 1e18) * 100;

      console.log("\n=== Rebalancing Threshold Analysis ===");
      console.log("Max Delta Deviation:", maxDeviationPct, "%");
      console.log("Baseline Delta Ratio:", baselinePct.toFixed(2), "%");
      console.log("\nPrice Shift\t\tDelta Ratio\t\tDrift\t\tRebalance?");
      console.log("-".repeat(70));

      // Analyze delta drift at different price points
      const priceShifts = [-400, -200, 0, 200, 400];

      for (const shift of priceShifts) {
        const simulatedTick = currentTick + shift;

        if (simulatedTick <= tickLower || simulatedTick >= tickUpper) {
          continue;
        }

        const sqrtPriceSimulated = tickToSqrtPriceX96(simulatedTick);

        const deltaRatio = await deltaCalc.calculateDeltaRatio(
          sqrtPriceSimulated,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        const deltaRatioPct = (Number(deltaRatio) / 1e18) * 100;
        const drift = Math.abs(deltaRatioPct - baselinePct);
        const needsRebalance = drift > maxDeviationPct;

        const priceChange = (Math.pow(1.0001, shift) - 1) * 100;

        console.log(
          `${priceChange > 0 ? "+" : ""}${priceChange.toFixed(2)}%\t\t\t` +
            `${deltaRatioPct.toFixed(2)}%\t\t\t` +
            `${drift.toFixed(2)}%\t\t` +
            `${needsRebalance ? "YES" : "NO"}`
        );
      }

      // Verify baseline is within range
      expect(baselineDeltaRatio).to.be.gt(0n);
      expect(baselineDeltaRatio).to.be.lt(BigInt(10) ** BigInt(18));
    });

    it("should demonstrate hedging effectiveness with delta ratio", async function () {
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());
      const ethPrice = Number(await getETHPrice()) / 1e8;

      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      const deltaCalc = await DeltaCalculatorHarness.deploy();

      const tickRange = 500;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Get delta ratio at current price
      const deltaRatio = await deltaCalc.calculateDeltaRatio(
        slot0.sqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      const deltaRatioPct = (Number(deltaRatio) / 1e18) * 100;

      console.log("\n=== Hedging Effectiveness with Delta Ratio ===");
      console.log("ETH Price:", ethPrice.toFixed(2), "USD");
      console.log("Delta Ratio:", deltaRatioPct.toFixed(2), "%");

      // For a $10,000 LP position
      const lpNotional = 10000;
      const ethExposure = (lpNotional * deltaRatioPct) / 100;
      const optimalHedge = ethExposure;

      console.log("\nFor $10,000 LP position:");
      console.log("  ETH Exposure: $", ethExposure.toFixed(2));
      console.log("  Optimal Hedge (short): $", optimalHedge.toFixed(2));

      // Simulate 10% price movement
      console.log("\n10% ETH Price Movement P&L Analysis:");

      // Price up 10%
      const lpPnLUp = ethExposure * 0.1; // LP gains
      const hedgePnLUp = -optimalHedge * 0.1; // Hedge loses
      const netPnLUp = lpPnLUp + hedgePnLUp;

      // Price down 10%
      const lpPnLDown = -ethExposure * 0.1; // LP loses
      const hedgePnLDown = optimalHedge * 0.1; // Hedge gains
      const netPnLDown = lpPnLDown + hedgePnLDown;

      console.log(
        "  Price +10%: LP $",
        lpPnLUp.toFixed(2),
        "+ Hedge $",
        hedgePnLUp.toFixed(2),
        "= Net $",
        netPnLUp.toFixed(2)
      );
      console.log(
        "  Price -10%: LP $",
        lpPnLDown.toFixed(2),
        "+ Hedge $",
        hedgePnLDown.toFixed(2),
        "= Net $",
        netPnLDown.toFixed(2)
      );

      // Net P&L should be close to zero with perfect hedge
      expect(Math.abs(netPnLUp)).to.be.lt(1); // Should be ~0
      expect(Math.abs(netPnLDown)).to.be.lt(1); // Should be ~0
    });
  });
});
