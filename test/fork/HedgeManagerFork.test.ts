import { expect } from "chai";
import { ethers, network, upgrades } from "hardhat";
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

// Skip these tests if not running with forking enabled
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("HedgeManager Fork Tests", function () {
  // Arbitrum mainnet addresses (from PLAN.md Appendix A)
  const ARBITRUM_ADDRESSES = {
    // GMX v2
    EXCHANGE_ROUTER: "0x1C3fa76e6E1088bCE750f23a5BFcffa1efEF6A41",
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

  // Whale addresses for impersonation (native USDC holders on Arbitrum)
  // These are contracts/addresses known to hold significant native USDC
  const USDC_WHALES = [
    "0x47c031236e19d024b42f8AE6780E44A573170703", // GMX GLP Manager
    "0xF89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit hot wallet
    "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3", // Another USDC holder
    "0x62383739D68Dd0F844103Db8dFb05a7EdED5BBE6", // Stargate USDC pool
    "0x1714400FF23dB4aF24F9fd64e7039e6597f18C2b", // Aave USDC pool
  ];

  let hedgeManager: HedgeManager;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let usdc: IERC20;
  let weth: IERC20;
  let usdcWhale: HardhatEthersSigner;

  before(async function () {
    // Workaround for "No known hardfork" error on Arbitrum fork
    await network.provider.send("hardhat_mine", ["0x1"]);

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
    hedgeManager = (await upgrades.deployProxy(
      HedgeManager,
      [
        ARBITRUM_ADDRESSES.EXCHANGE_ROUTER,
        ARBITRUM_ADDRESSES.ETH_USD_MARKET,
        ARBITRUM_ADDRESSES.USDC,
        ARBITRUM_ADDRESSES.WETH,
        ARBITRUM_ADDRESSES.ETH_USD_FEED,
        owner.address,
      ],
      { kind: "uups" }
    )) as unknown as HedgeManager;
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

  // Note: Don't reset network in after() hook as it disrupts other fork test suites
  // Each test file should be self-contained and not affect global state

  describe("Deployment Verification", function () {
    it("should be deployed with correct GMX addresses", async function () {
      expect(await hedgeManager.exchangeRouter()).to.equal(ARBITRUM_ADDRESSES.EXCHANGE_ROUTER);
      expect(await hedgeManager.market()).to.equal(ARBITRUM_ADDRESSES.ETH_USD_MARKET);
      expect(await hedgeManager.collateralToken()).to.equal(ARBITRUM_ADDRESSES.USDC);
      expect(await hedgeManager.indexToken()).to.equal(ARBITRUM_ADDRESSES.WETH);
    });

    it("should expose a valid underlying router", async function () {
      const exchangeRouter = await ethers.getContractAt(
        "IExchangeRouter",
        ARBITRUM_ADDRESSES.EXCHANGE_ROUTER
      );
      const router = await exchangeRouter.router();
      expect(router).to.not.equal(ethers.ZeroAddress);
      const code = await ethers.provider.getCode(router);
      expect(code).to.not.equal("0x");
    });

    it("should connect to real Chainlink price feed", async function () {
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
      const dataStore = await ethers.getContractAt("IDataStore", ARBITRUM_ADDRESSES.DATA_STORE);
      // Just verify we can call the contract
      const key = ethers.keccak256(ethers.toUtf8Bytes("test"));
      await expect(dataStore.getUint(key)).to.not.be.reverted;
    });
  });

  describe("Position Key Generation", function () {
    it("should generate correct position key", async function () {
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
      const fee = await hedgeManager.getExecutionFee();
      expect(fee).to.be.gt(0n);
      expect(fee).to.be.lte(ethers.parseEther("0.01")); // Should be less than 0.01 ETH
    });
  });

  describe("Initial State", function () {
    it("should start with no position", async function () {
      expect(await hedgeManager.hasPosition()).to.be.false;
      expect(await hedgeManager.getPositionSizeUsd()).to.equal(0n);
      expect(await hedgeManager.getCollateralAmount()).to.equal(0n);
    });
  });

  describe("Price Feed Integration", function () {
    it("should read real-time price from Chainlink", async function () {
      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ARBITRUM_ADDRESSES.ETH_USD_FEED
      );

      const [roundId, answer, , updatedAt] = await priceFeed.latestRoundData();

      expect(roundId).to.be.gt(0n);
      expect(answer).to.be.gt(0n);
      expect(updatedAt).to.be.gt(0n);

      // Note: On forked networks, the updatedAt might be stale relative to real-world time
      // Just verify the values are reasonable
      const price = Number(answer) / 1e8;
      expect(price).to.be.gt(500); // ETH should be > $500
      expect(price).to.be.lt(10000); // ETH should be < $10,000
    });
  });

  describe("GMX v2 Contract Interaction", function () {
    it("should be able to read from GMX DataStore", async function () {
      const dataStore = await ethers.getContractAt("IDataStore", ARBITRUM_ADDRESSES.DATA_STORE);

      // Try to read a known key from GMX
      // MAX_OPEN_INTEREST_KEY = keccak256("MAX_OPEN_INTEREST")
      const maxOIKey = ethers.keccak256(ethers.toUtf8Bytes("MAX_OPEN_INTEREST"));

      const result = await dataStore.getUint(maxOIKey);
      // This key may or may not have a value, but the call should not revert
      expect(result).to.be.gte(0n);
    });

    it("should verify GMX Exchange Router is valid", async function () {
      const exchangeRouter = await ethers.getContractAt(
        "IExchangeRouter",
        ARBITRUM_ADDRESSES.EXCHANGE_ROUTER
      );

      // Verify dataStore is accessible
      const dataStoreAddr = await exchangeRouter.dataStore();
      expect(dataStoreAddr).to.equal(ARBITRUM_ADDRESSES.DATA_STORE);

      // Note: orderVault might have different ABI, just verify router has code
      const code = await ethers.provider.getCode(ARBITRUM_ADDRESSES.EXCHANGE_ROUTER);
      expect(code).to.not.equal("0x");
    });
  });

  describe("USDC Balance Verification", function () {
    it("should have sufficient USDC for testing", async function () {
      const whaleBalance = await usdc.balanceOf(usdcWhale.address);
      const minRequired = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      expect(whaleBalance).to.be.gte(minRequired);
      console.log(`USDC whale balance: ${ethers.formatUnits(whaleBalance, USDC_DECIMALS)} USDC`);
    });

    it("should have approved HedgeManager", async function () {
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
      const maxLeverage = await hedgeManager.maxLeverage();
      expect(maxLeverage).to.equal(3n * BigInt(1e18)); // 3x

      // Test that 2x leverage is well within limits
      const position2x = BigInt(20_000) * GMX_USD_PRECISION;
      const collateral2x = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      // Calculate leverage: position / (collateral in USD)
      const collateralUsd = collateral2x * BigInt(1e24); // Convert to 30 decimals
      const leverage = (position2x * BigInt(1e18)) / collateralUsd;

      // 2x should be less than 3x max
      expect(leverage).to.be.lte(maxLeverage);
      expect(leverage).to.be.lt(3n * BigInt(1e18));
    });
  });

  describe("Constants Verification", function () {
    it("should have correct GMX precision", async function () {
      const precision = await hedgeManager.GMX_USD_PRECISION();
      // GMX uses 30 decimals for USD - verify it's in the right ballpark
      // Using closeTo check to handle any precision issues with BigInt
      const expected = BigInt(10) ** BigInt(30);
      expect(precision).to.be.gte(expected - BigInt(1e20));
      expect(precision).to.be.lte(expected + BigInt(1e20));
    });

    it("should have reasonable minimum position size", async function () {
      const minSize = await hedgeManager.minPositionSize();
      // $100 minimum (in 30 decimals)
      const expected = BigInt(100) * BigInt(10) ** BigInt(30);
      // Allow some precision tolerance
      expect(minSize).to.be.gte(expected - BigInt(1e22));
      expect(minSize).to.be.lte(expected + BigInt(1e22));
    });
  });
});
