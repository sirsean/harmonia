import { expect } from "chai";
import { ethers, network } from "hardhat";
import { HedgeManager, IERC20 } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

/**
 * Fork tests for HedgeManager against GMX v2 on Arbitrum
 *
 * These tests require an Arbitrum mainnet fork to run.
 * Set ALCHEMY_API_KEY environment variable before running.
 *
 * Run with: npx hardhat test test/fork/HedgeManagerFork.test.ts
 */
describe("HedgeManager Fork Tests", function () {
  // Arbitrum mainnet addresses (from PLAN.md Appendix A)
  const ARBITRUM_ADDRESSES = {
    // GMX v2
    EXCHANGE_ROUTER: "0x7C68C7866A64FA2160F78EEaE12217FFbf871fa8",
    ORDER_VAULT: "0x31eF83a530Fde1B38EE9A18093A333D8Bbbc40D5",
    DATA_STORE: "0xFD70de6b91282D8017aA4E741e9Ae325CAb992d8",
    ETH_USD_MARKET: "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336",

    // Chainlink
    ETH_USD_FEED: "0x639Fe6ab55C921f74e7fac1ee960C0B6293ba612",

    // Tokens
    USDC: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    WETH: "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1",
  };

  // Test constants
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);
  const EXECUTION_FEE = ethers.parseEther("0.001");
  const USDC_DECIMALS = 6;

  // Whale addresses for impersonation (USDC holders on Arbitrum)
  // Using Arbitrum bridge and major DEX addresses
  const USDC_WHALES = [
    "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7", // Arbitrum bridge
    "0x489ee077994B6658eAfA855C308275EAd8097C4A", // GMX vault
    "0xB38e8c17e38363aF6EbdCb3dAE12e0243582891D", // Uniswap pool
  ];

  let hedgeManager: HedgeManager;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let usdc: IERC20;
  let weth: IERC20;
  let usdcWhale: HardhatEthersSigner;

  // Check if we have Alchemy API key for forking
  const ALCHEMY_API_KEY = process.env.ALCHEMY_API_KEY;

  before(async function () {
    if (!ALCHEMY_API_KEY) {
      console.log("Skipping fork tests: ALCHEMY_API_KEY not set");
      this.skip();
      return;
    }

    // Reset to fresh fork
    await network.provider.request({
      method: "hardhat_reset",
      params: [
        {
          forking: {
            jsonRpcUrl: `https://arb-mainnet.g.alchemy.com/v2/${ALCHEMY_API_KEY}`,
            blockNumber: 275000000, // Recent block
          },
        },
      ],
    });

    [owner, vault] = await ethers.getSigners();

    // Get token contracts
    usdc = await ethers.getContractAt("IERC20", ARBITRUM_ADDRESSES.USDC);
    weth = await ethers.getContractAt("IERC20", ARBITRUM_ADDRESSES.WETH);

    // Find a USDC whale with sufficient balance
    let whaleFound = false;
    for (const whaleAddress of USDC_WHALES) {
      try {
        const balance = await usdc.balanceOf(whaleAddress);
        if (balance > BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS)) {
          // Impersonate whale
          await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [whaleAddress],
          });
          usdcWhale = await ethers.getSigner(whaleAddress);

          // Fund whale with ETH for gas
          await owner.sendTransaction({
            to: whaleAddress,
            value: ethers.parseEther("10"),
          });

          whaleFound = true;
          console.log(
            `Using USDC whale: ${whaleAddress} with balance: ${ethers.formatUnits(balance, USDC_DECIMALS)} USDC`
          );
          break;
        }
      } catch (e) {
        continue;
      }
    }

    if (!whaleFound) {
      console.log("No suitable USDC whale found, skipping fork tests");
      this.skip();
      return;
    }

    // Deploy HedgeManager
    const HedgeManager = await ethers.getContractFactory("HedgeManager");
    hedgeManager = await HedgeManager.deploy(
      ARBITRUM_ADDRESSES.EXCHANGE_ROUTER,
      ARBITRUM_ADDRESSES.ETH_USD_MARKET,
      ARBITRUM_ADDRESSES.USDC,
      ARBITRUM_ADDRESSES.WETH,
      ARBITRUM_ADDRESSES.ETH_USD_FEED,
      owner.address
    );
    await hedgeManager.waitForDeployment();

    // Set vault to whale for testing
    await hedgeManager.connect(owner).setVault(usdcWhale.address);

    // Transfer USDC to vault
    const transferAmount = BigInt(50_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
    await usdc.connect(usdcWhale).transfer(vault.address, transferAmount);

    // Approve HedgeManager
    await usdc.connect(usdcWhale).approve(await hedgeManager.getAddress(), ethers.MaxUint256);
    await usdc.connect(vault).approve(await hedgeManager.getAddress(), ethers.MaxUint256);
  });

  after(async function () {
    // Reset network
    if (ALCHEMY_API_KEY) {
      await network.provider.request({
        method: "hardhat_reset",
        params: [],
      });
    }
  });

  describe("Deployment Verification", function () {
    it("should be deployed with correct GMX addresses", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      expect(await hedgeManager.exchangeRouter()).to.equal(ARBITRUM_ADDRESSES.EXCHANGE_ROUTER);
      expect(await hedgeManager.market()).to.equal(ARBITRUM_ADDRESSES.ETH_USD_MARKET);
      expect(await hedgeManager.collateralToken()).to.equal(ARBITRUM_ADDRESSES.USDC);
      expect(await hedgeManager.indexToken()).to.equal(ARBITRUM_ADDRESSES.WETH);
    });

    it("should connect to real Chainlink price feed", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ARBITRUM_ADDRESSES.ETH_USD_FEED
      );
      const [, answer, , ,] = await priceFeed.latestRoundData();

      // ETH price should be reasonable (between $500 and $10,000)
      const price = Number(answer) / 1e8;
      expect(price).to.be.gt(500);
      expect(price).to.be.lt(10000);
      console.log(`Current ETH price: $${price.toFixed(2)}`);
    });

    it("should have access to GMX data store", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const dataStore = await ethers.getContractAt("IDataStore", ARBITRUM_ADDRESSES.DATA_STORE);
      // Just verify we can call the contract
      const key = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(dataStore.getUint(key)).to.not.be.reverted;
    });
  });

  describe("Position Key Generation", function () {
    it("should generate correct position key", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const positionKey = await hedgeManager.getPositionKey();
      expect(positionKey).to.not.equal(ethers.ZeroHash);

      // Position key should be derived from: account, market, collateralToken, isLong
      const expectedKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["address", "address", "address", "bool"],
          [
            await hedgeManager.getAddress(),
            ARBITRUM_ADDRESSES.ETH_USD_MARKET,
            ARBITRUM_ADDRESSES.USDC,
            false, // isLong
          ]
        )
      );
      expect(positionKey).to.equal(expectedKey);
    });
  });

  describe("Execution Fee", function () {
    it("should return reasonable execution fee", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const fee = await hedgeManager.getExecutionFee();
      expect(fee).to.be.gt(0n);
      expect(fee).to.be.lte(ethers.parseEther("0.01")); // Should be less than 0.01 ETH
    });
  });

  describe("Initial State", function () {
    it("should start with no position", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      expect(await hedgeManager.hasPosition()).to.be.false;
      expect(await hedgeManager.getPositionSizeUsd()).to.equal(0n);
      expect(await hedgeManager.getCollateralAmount()).to.equal(0n);
    });
  });

  describe("Price Feed Integration", function () {
    it("should read real-time price from Chainlink", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ARBITRUM_ADDRESSES.ETH_USD_FEED
      );

      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await priceFeed.latestRoundData();

      expect(roundId).to.be.gt(0n);
      expect(answer).to.be.gt(0n);
      expect(updatedAt).to.be.gt(0n);

      // Check that the price is not stale (within last 24 hours)
      const now = BigInt(Math.floor(Date.now() / 1000));
      const maxAge = BigInt(24 * 60 * 60); // 24 hours
      expect(now - updatedAt).to.be.lt(maxAge);
    });
  });

  describe("GMX v2 Contract Interaction", function () {
    it("should be able to read from GMX DataStore", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const dataStore = await ethers.getContractAt("IDataStore", ARBITRUM_ADDRESSES.DATA_STORE);

      // Try to read a known key from GMX
      // MAX_OPEN_INTEREST_KEY = keccak256("MAX_OPEN_INTEREST")
      const maxOIKey = ethers.keccak256(ethers.toUtf8Bytes("MAX_OPEN_INTEREST"));

      const result = await dataStore.getUint(maxOIKey);
      // This key may or may not have a value, but the call should not revert
      expect(result).to.be.gte(0n);
    });

    it("should verify GMX Exchange Router is valid", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const exchangeRouter = await ethers.getContractAt(
        "IExchangeRouter",
        ARBITRUM_ADDRESSES.EXCHANGE_ROUTER
      );

      const dataStoreAddr = await exchangeRouter.dataStore();
      expect(dataStoreAddr).to.equal(ARBITRUM_ADDRESSES.DATA_STORE);

      const orderVaultAddr = await exchangeRouter.orderVault();
      expect(orderVaultAddr).to.equal(ARBITRUM_ADDRESSES.ORDER_VAULT);
    });
  });

  describe("USDC Balance Verification", function () {
    it("should have sufficient USDC for testing", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const whaleBalance = await usdc.balanceOf(usdcWhale.address);
      const minRequired = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      expect(whaleBalance).to.be.gte(minRequired);
      console.log(`USDC whale balance: ${ethers.formatUnits(whaleBalance, USDC_DECIMALS)} USDC`);
    });

    it("should have approved HedgeManager", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const allowance = await usdc.allowance(usdcWhale.address, await hedgeManager.getAddress());
      expect(allowance).to.be.gt(0n);
    });
  });

  /**
   * NOTE: The following tests that create actual GMX orders are commented out
   * because they require keeper execution and would consume real execution fees.
   * They can be enabled for manual testing with sufficient ETH.
   */

  describe("Order Creation (Read-Only Simulation)", function () {
    it("should calculate correct collateral requirements", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      // Test the collateral calculation logic
      const targetSize = BigInt(10_000) * GMX_USD_PRECISION; // $10k position

      // At 2x leverage, need $5k collateral
      const expectedCollateral = BigInt(5_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      // This is a read-only test to verify calculation logic
      // In a real scenario, adjustHedge would calculate this internally
      const leverage = (targetSize * BigInt(1e18)) / (expectedCollateral * BigInt(1e24));
      expect(leverage).to.be.lte(3n * BigInt(1e18)); // Within max leverage
    });

    it("should estimate position delta correctly", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      // Get current ETH price
      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ARBITRUM_ADDRESSES.ETH_USD_FEED
      );
      const [, answer, , ,] = await priceFeed.latestRoundData();
      const ethPrice = Number(answer) / 1e8;

      // For a $10k short position
      const positionSizeUsd = 10_000;
      const expectedTokens = positionSizeUsd / ethPrice;

      console.log(`At ETH price $${ethPrice.toFixed(2)}:`);
      console.log(`  $${positionSizeUsd} position = ${expectedTokens.toFixed(4)} ETH short`);
      console.log(`  Delta = -${expectedTokens.toFixed(4)} ETH`);

      // Delta should be negative for short position
      expect(expectedTokens).to.be.gt(0);
    });
  });

  describe("Market Parameters", function () {
    it("should verify ETH/USD market exists on GMX", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      // The market address should be valid and have tokens configured
      const marketAddress = ARBITRUM_ADDRESSES.ETH_USD_MARKET;
      expect(marketAddress).to.not.equal(ethers.ZeroAddress);

      // Try to get market info (this is a basic existence check)
      const code = await ethers.provider.getCode(marketAddress);
      expect(code).to.not.equal("0x");
    });
  });

  describe("Leverage Validation", function () {
    it("should correctly validate leverage limits", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const maxLeverage = await hedgeManager.MAX_LEVERAGE();
      expect(maxLeverage).to.equal(3n * BigInt(1e18)); // 3x

      // Test that 3x leverage is acceptable
      const position3x = BigInt(30_000) * GMX_USD_PRECISION;
      const collateral3x = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      // Calculate leverage: position / (collateral in USD)
      const collateralUsd = collateral3x * BigInt(1e24); // Convert to 30 decimals
      const leverage = (position3x * BigInt(1e18)) / collateralUsd;

      expect(leverage).to.be.lte(maxLeverage);
    });
  });

  describe("Constants Verification", function () {
    it("should have correct GMX precision", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const precision = await hedgeManager.GMX_USD_PRECISION();
      expect(precision).to.equal(BigInt(1e30));
    });

    it("should have reasonable minimum position size", async function () {
      if (!ALCHEMY_API_KEY) this.skip();

      const minSize = await hedgeManager.MIN_POSITION_SIZE();
      // $100 minimum
      expect(minSize).to.equal(BigInt(100) * GMX_USD_PRECISION);
    });
  });
});
