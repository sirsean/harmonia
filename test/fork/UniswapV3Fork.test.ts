import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ARBITRUM_ADDRESSES, HISTORICAL_BLOCKS } from "../../hardhat.config";

// Skip these tests if not running with forking enabled
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("Uniswap V3 Fork Tests", function () {
  let signer: HardhatEthersSigner;
  let uniswapPool: Contract;
  let positionManager: Contract;
  let weth: Contract;
  let usdc: Contract;

  // Pool interface ABI
  const POOL_ABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function tickSpacing() external view returns (int24)",
  ];

  // ERC20 ABI
  const ERC20_ABI = [
    "function balanceOf(address) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function approve(address spender, uint256 amount) external returns (bool)",
  ];

  // Position Manager ABI
  const POSITION_MANAGER_ABI = [
    "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function balanceOf(address owner) external view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
  ];

  before(async function () {
    // Get signer
    [signer] = await ethers.getSigners();

    // Connect to Uniswap V3 ETH/USDC pool
    uniswapPool = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL, POOL_ABI, signer);

    // Connect to Position Manager
    positionManager = new Contract(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      POSITION_MANAGER_ABI,
      signer
    );

    // Connect to tokens
    weth = new Contract(ARBITRUM_ADDRESSES.WETH, ERC20_ABI, signer);
    usdc = new Contract(ARBITRUM_ADDRESSES.USDC, ERC20_ABI, signer);
  });

  describe("Pool State Reading", function () {
    it("should read current pool state", async function () {
      const slot0 = await uniswapPool.slot0();
      const liquidity = await uniswapPool.liquidity();
      const fee = await uniswapPool.fee();

      console.log("Pool State:");
      console.log("  sqrtPriceX96:", slot0.sqrtPriceX96.toString());
      console.log("  Current tick:", slot0.tick.toString());
      console.log("  Liquidity:", liquidity.toString());
      console.log("  Fee:", fee.toString(), "bps");

      // Basic sanity checks
      expect(slot0.sqrtPriceX96).to.be.gt(0);
      expect(liquidity).to.be.gt(0);
      expect(fee).to.equal(500); // 0.05% fee tier
    });

    it("should have correct token ordering", async function () {
      const token0 = await uniswapPool.token0();
      const token1 = await uniswapPool.token1();

      // In Uniswap V3, tokens are ordered by address
      // WETH and USDC should be in the expected positions
      console.log("Token0:", token0);
      console.log("Token1:", token1);

      // One should be WETH and one should be USDC
      const tokens = [token0.toLowerCase(), token1.toLowerCase()];
      expect(tokens).to.include(ARBITRUM_ADDRESSES.WETH.toLowerCase());
      expect(tokens).to.include(ARBITRUM_ADDRESSES.USDC.toLowerCase());
    });

    it("should calculate approximate ETH price from sqrtPriceX96", async function () {
      const slot0 = await uniswapPool.slot0();
      const sqrtPriceX96 = slot0.sqrtPriceX96;

      // Get token ordering
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      // Calculate price
      // price = (sqrtPrice / 2^96)^2
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(sqrtPriceX96) / Number(Q96);
      let price = sqrtPrice * sqrtPrice;

      // Adjust for token decimals (WETH: 18, USDC: 6)
      // If WETH is token0: price = USDC/WETH * 10^12
      // If WETH is token1: price = WETH/USDC / 10^12
      if (isWethToken0) {
        price = price * 1e12; // USDC per WETH
      } else {
        price = 1e12 / price; // USDC per WETH (inverted)
      }

      console.log("Calculated ETH price:", price.toFixed(2), "USDC");

      // ETH should be worth between $100 and $100,000 (sanity check)
      expect(price).to.be.gt(100);
      expect(price).to.be.lt(100000);
    });
  });

  describe("Delta Calculator Integration", function () {
    let deltaCalculator: Contract;

    before(async function () {
      const DeltaCalculatorHarness = await ethers.getContractFactory("DeltaCalculatorHarness");
      deltaCalculator = await DeltaCalculatorHarness.deploy();
      await deltaCalculator.waitForDeployment();
    });

    it("should calculate delta for a hypothetical position around current price", async function () {
      // Get current price
      const slot0 = await uniswapPool.slot0();
      const currentSqrtPriceX96 = slot0.sqrtPriceX96;
      const currentTick = slot0.tick;

      // Create a range around current price (±10%)
      // Each tick represents a 0.01% price change
      const tickSpacing = await uniswapPool.tickSpacing();
      const tickRange = 1000; // About ±10%

      const tickLower =
        Math.floor((currentTick - tickRange) / Number(tickSpacing)) * Number(tickSpacing);
      const tickUpper =
        Math.ceil((currentTick + tickRange) / Number(tickSpacing)) * Number(tickSpacing);

      // Convert ticks to sqrtPriceX96 using the formula:
      // sqrtPrice = 1.0001^(tick/2) * 2^96
      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      // Calculate delta with 1e18 liquidity
      const liquidity = BigInt(10) ** BigInt(18);

      const delta = await deltaCalculator.calculateDelta(
        currentSqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      const deltaRatio = await deltaCalculator.calculateDeltaRatio(
        currentSqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper
      );

      console.log("Position Analysis:");
      console.log("  Tick Lower:", tickLower);
      console.log("  Tick Upper:", tickUpper);
      console.log("  Current Tick:", currentTick);
      console.log("  Delta (base token amount):", delta.toString());
      console.log("  Delta Ratio:", ((Number(deltaRatio) / 1e18) * 100).toFixed(2), "%");

      // Position should be in range
      expect(delta).to.be.gt(0);
      expect(deltaRatio).to.be.gt(0);
      expect(deltaRatio).to.be.lt(BigInt(10) ** BigInt(18));
    });

    it("should calculate gamma for in-range position", async function () {
      const slot0 = await uniswapPool.slot0();
      const currentSqrtPriceX96 = slot0.sqrtPriceX96;
      const currentTick = slot0.tick;

      const tickSpacing = await uniswapPool.tickSpacing();
      const tickRange = 1000;

      const tickLower =
        Math.floor((currentTick - tickRange) / Number(tickSpacing)) * Number(tickSpacing);
      const tickUpper =
        Math.ceil((currentTick + tickRange) / Number(tickSpacing)) * Number(tickSpacing);

      const sqrtPriceLower = tickToSqrtPriceX96(tickLower);
      const sqrtPriceUpper = tickToSqrtPriceX96(tickUpper);

      const liquidity = BigInt(10) ** BigInt(18);

      const gamma = await deltaCalculator.calculateGamma(
        currentSqrtPriceX96,
        sqrtPriceLower,
        sqrtPriceUpper,
        liquidity
      );

      console.log("Gamma:", gamma.toString());

      // Gamma should be negative (LP positions are short volatility)
      expect(gamma).to.be.lt(0);
    });
  });

  describe("Historical Block Testing", function () {
    it("should test at a historical block with different market conditions", async function () {
      // This test demonstrates the ability to test at specific historical blocks
      // The actual block number will depend on your fork configuration

      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);

      console.log("Current Fork Block:", blockNumber);
      console.log("Block Timestamp:", new Date(Number(block!.timestamp) * 1000).toISOString());

      // Read pool state at this historical block
      const slot0 = await uniswapPool.slot0();
      const liquidity = await uniswapPool.liquidity();

      console.log("Historical Pool State:");
      console.log("  sqrtPriceX96:", slot0.sqrtPriceX96.toString());
      console.log("  Tick:", slot0.tick.toString());
      console.log("  Liquidity:", liquidity.toString());

      // This test passes if we can successfully read historical state
      expect(slot0.sqrtPriceX96).to.be.gt(0);
    });
  });

  describe("Scenario Testing", function () {
    it("should simulate delta changes as price moves", async function () {
      const deltaCalculator = await (
        await ethers.getContractFactory("DeltaCalculatorHarness")
      ).deploy();

      // Define a fixed range
      const sqrtPriceLower = tickToSqrtPriceX96(-200000); // ~$500
      const sqrtPriceUpper = tickToSqrtPriceX96(-180000); // ~$8000
      const liquidity = BigInt(10) ** BigInt(18);

      // Test delta at different price points
      const pricePoints = [-195000, -192000, -190000, -188000, -185000];

      console.log("\nDelta vs Price Analysis:");
      console.log("Tick\t\tDelta Ratio");

      for (const tick of pricePoints) {
        const sqrtPrice = tickToSqrtPriceX96(tick);
        const deltaRatio = await deltaCalculator.calculateDeltaRatio(
          sqrtPrice,
          sqrtPriceLower,
          sqrtPriceUpper
        );

        console.log(`${tick}\t\t${((Number(deltaRatio) / 1e18) * 100).toFixed(2)}%`);
      }

      // Verify delta decreases as price increases
      const deltaLow = await deltaCalculator.calculateDeltaRatio(
        tickToSqrtPriceX96(-195000),
        sqrtPriceLower,
        sqrtPriceUpper
      );
      const deltaHigh = await deltaCalculator.calculateDeltaRatio(
        tickToSqrtPriceX96(-185000),
        sqrtPriceLower,
        sqrtPriceUpper
      );

      expect(deltaLow).to.be.gt(deltaHigh);
    });
  });
});

// Helper function to convert tick to sqrtPriceX96
function tickToSqrtPriceX96(tick: number): bigint {
  // sqrtPrice = 1.0001^(tick/2)
  // sqrtPriceX96 = sqrtPrice * 2^96
  const sqrtPrice = Math.pow(1.0001, tick / 2);
  const Q96 = BigInt(2) ** BigInt(96);
  return BigInt(Math.floor(sqrtPrice * Number(Q96)));
}
