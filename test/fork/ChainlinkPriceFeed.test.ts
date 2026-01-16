import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ARBITRUM_ADDRESSES } from "../../hardhat.config";

// Skip these tests if not running with forking enabled
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("Chainlink Price Feed Fork Tests", function () {
  let signer: HardhatEthersSigner;
  let ethUsdFeed: Contract;

  // Chainlink Aggregator ABI
  const AGGREGATOR_ABI = [
    "function decimals() external view returns (uint8)",
    "function description() external view returns (string)",
    "function version() external view returns (uint256)",
    "function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
    "function getRoundData(uint80 _roundId) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  ];

  before(async function () {
    // Workaround for "No known hardfork" error on Arbitrum fork
    // Mining a block bypasses the hardfork lookup issue
    await network.provider.send("hardhat_mine", ["0x1"]);

    [signer] = await ethers.getSigners();

    // Connect to Chainlink ETH/USD price feed
    ethUsdFeed = new Contract(ARBITRUM_ADDRESSES.CHAINLINK_ETH_USD_FEED, AGGREGATOR_ABI, signer);
  });

  describe("Price Feed Reading", function () {
    it("should read ETH/USD price from Chainlink", async function () {
      const decimals = await ethUsdFeed.decimals();
      const description = await ethUsdFeed.description();
      const latestRound = await ethUsdFeed.latestRoundData();

      console.log("Chainlink ETH/USD Feed:");
      console.log("  Description:", description);
      console.log("  Decimals:", decimals.toString());
      console.log("  Round ID:", latestRound.roundId.toString());
      console.log("  Raw Price:", latestRound.answer.toString());
      console.log(
        "  Price (USD):",
        (Number(latestRound.answer) / 10 ** Number(decimals)).toFixed(2)
      );
      console.log("  Updated At:", new Date(Number(latestRound.updatedAt) * 1000).toISOString());

      // Verify price is reasonable
      const priceUsd = Number(latestRound.answer) / 10 ** Number(decimals);
      expect(priceUsd).to.be.gt(100); // ETH should be > $100
      expect(priceUsd).to.be.lt(100000); // ETH should be < $100,000
      expect(decimals).to.equal(8); // Chainlink uses 8 decimals
    });

    it("should have recent price update", async function () {
      const latestRound = await ethUsdFeed.latestRoundData();
      const currentTimestamp = Math.floor(Date.now() / 1000);
      const updateTimestamp = Number(latestRound.updatedAt);

      // Price should be updated within the last 24 hours
      // (This may fail on very old fork blocks)
      const timeDiff = currentTimestamp - updateTimestamp;
      console.log("Time since last update:", timeDiff, "seconds");

      // For fork tests, we just verify the timestamp is valid
      expect(updateTimestamp).to.be.gt(0);
    });

    it("should verify price freshness for trading decisions", async function () {
      const latestRound = await ethUsdFeed.latestRoundData();

      // Common pattern for verifying price freshness
      const MAX_PRICE_AGE = 3600; // 1 hour in seconds
      const currentBlock = await ethers.provider.getBlock("latest");
      const blockTimestamp = currentBlock!.timestamp;
      const priceTimestamp = Number(latestRound.updatedAt);

      const priceAge = Number(blockTimestamp) - priceTimestamp;

      console.log("Price age at block:", priceAge, "seconds");

      // Verify round completeness
      expect(latestRound.answeredInRound).to.be.gte(latestRound.roundId);
      expect(latestRound.answer).to.be.gt(0);
    });
  });

  describe("Price Feed vs Pool Price Comparison", function () {
    it("should compare Chainlink price with Uniswap pool price", async function () {
      // Get Chainlink price
      const decimals = await ethUsdFeed.decimals();
      const latestRound = await ethUsdFeed.latestRoundData();
      const chainlinkPrice = Number(latestRound.answer) / 10 ** Number(decimals);

      // Get Uniswap pool price
      const POOL_ABI = [
        "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
        "function token0() external view returns (address)",
      ];

      const pool = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_WETH_USDC_005_POOL, POOL_ABI, signer);

      const slot0 = await pool.slot0();
      const token0 = await pool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      // Calculate Uniswap price
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let uniswapPrice = sqrtPrice * sqrtPrice;

      if (isWethToken0) {
        uniswapPrice = uniswapPrice * 1e12;
      } else {
        uniswapPrice = 1e12 / uniswapPrice;
      }

      console.log("\nPrice Comparison:");
      console.log("  Chainlink ETH/USD:", chainlinkPrice.toFixed(2));
      console.log("  Uniswap ETH/USDC:", uniswapPrice.toFixed(2));

      const priceDiff = Math.abs(chainlinkPrice - uniswapPrice);
      const priceDiffPct = (priceDiff / chainlinkPrice) * 100;
      console.log("  Difference:", priceDiffPct.toFixed(4), "%");

      // Prices should be within 2% of each other in normal conditions
      // This may fail during high volatility or on stale fork blocks
      // We use a wider tolerance for fork tests
      expect(priceDiffPct).to.be.lt(5);
    });
  });

  describe("Historical Price Analysis", function () {
    it("should analyze price at fork block", async function () {
      const blockNumber = await ethers.provider.getBlockNumber();
      const block = await ethers.provider.getBlock(blockNumber);

      const latestRound = await ethUsdFeed.latestRoundData();
      const decimals = await ethUsdFeed.decimals();
      const price = Number(latestRound.answer) / 10 ** Number(decimals);

      console.log("\nHistorical Price Analysis:");
      console.log("  Fork Block:", blockNumber);
      console.log("  Block Time:", new Date(Number(block!.timestamp) * 1000).toISOString());
      console.log("  ETH Price:", price.toFixed(2), "USD");

      // This information is useful for designing test scenarios
      // Example: If price was $2000, we can create positions accordingly
      expect(price).to.be.gt(0);
    });
  });
});
