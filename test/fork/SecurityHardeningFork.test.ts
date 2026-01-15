import { expect } from "chai";
import { ethers, network } from "hardhat";
import { time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ADDRESSES, PRECISION } from "../helpers/constants";
import { DeltaNeutralVault, IERC20 } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

// Only run on Arbitrum fork when ALCHEMY_API_KEY is configured
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("Security Hardening Fork Tests", function () {
  const USDC_DECIMALS = 6;
  // Multiple whale addresses for fallback
  const USDC_WHALES = [
    "0x489ee077994B6658eAfA855C308275EAd8097C4A", // Aave treasury
    "0xF977814e90dA44bFA03b6295A0616a897441aceC", // Binance
    "0x62383739D68Dd0F844103Db8dFb05a7EdED5BBE6", // Arbitrum bridge
    "0x47c031236e19d024b42f8AE6780E44A573170703", // Known holder
    "0xF89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit
    "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3", // USDC holder
  ];

  let owner: HardhatEthersSigner;
  let guardian: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let attacker: HardhatEthersSigner;
  let usdc: IERC20;
  let vault: DeltaNeutralVault;
  let whale: HardhatEthersSigner;

  before(async function () {
    // Workaround for Arbitrum fork issues
    await network.provider.send("hardhat_mine", ["0x1"]);

    [owner, guardian, user1, attacker] = await ethers.getSigners();

    // Get USDC contract
    usdc = await ethers.getContractAt("IERC20", ADDRESSES.USDC);

    // Find a working whale with sufficient balance
    const fundAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS); // 100k USDC
    let whaleFound = false;

    for (const whaleAddress of USDC_WHALES) {
      try {
        const balance = await usdc.balanceOf(whaleAddress);
        if (balance >= fundAmount * 3n) {
          await network.provider.request({
            method: "hardhat_impersonateAccount",
            params: [whaleAddress],
          });
          whale = await ethers.getSigner(whaleAddress);
          await owner.sendTransaction({ to: whaleAddress, value: ethers.parseEther("10") });

          // Verify transfer works
          await usdc.connect(whale).transfer(user1.address, fundAmount);
          await usdc.connect(whale).transfer(attacker.address, fundAmount);

          console.log(`Using whale: ${whaleAddress}`);
          whaleFound = true;
          break;
        }
      } catch {
        continue;
      }
    }

    if (!whaleFound) {
      console.log("No suitable USDC whale found, skipping security fork tests");
      this.skip();
      return;
    }

    // Deploy vault
    const Vault = await ethers.getContractFactory("DeltaNeutralVault");
    vault = (await Vault.deploy(
      ADDRESSES.USDC,
      "Delta Neutral Vault",
      "dnVault",
      owner.address
    )) as DeltaNeutralVault;
    await vault.waitForDeployment();

    // Set guardian
    await vault.setGuardian(guardian.address);

    // Approve vault
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(attacker).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
  });

  describe("Circuit Breaker with Real Oracle", function () {
    it("should trigger circuit breaker and block operations", async function () {
      // User deposits
      const depositAmount = BigInt(50000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
      expect(await vault.paused()).to.equal(true);

      // New deposits should fail (paused)
      await expect(
        vault.connect(attacker).deposit(BigInt(1000) * BigInt(10 ** USDC_DECIMALS), attacker.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Reset for other tests
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });

    it("should allow owner to withdraw during circuit breaker", async function () {
      // Fund and deposit as owner
      await usdc.connect(whale).transfer(owner.address, BigInt(10000) * BigInt(10 ** USDC_DECIMALS));
      await vault.connect(owner).deposit(BigInt(10000) * BigInt(10 ** USDC_DECIMALS), owner.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Owner can still withdraw (within limits)
      const smallWithdraw = BigInt(1000) * BigInt(10 ** USDC_DECIMALS);
      await expect(vault.connect(owner).withdraw(smallWithdraw, owner.address, owner.address)).to.not
        .be.reverted;

      // Reset for other tests
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });
  });

  describe("Large Withdrawal Protection on Mainnet", function () {
    it("should enforce withdrawal limits with real balances", async function () {
      // Check user1 has balance
      const user1Balance = await vault.balanceOf(user1.address);
      if (user1Balance === 0n) {
        // Deposit if needed
        const bal = await usdc.balanceOf(user1.address);
        if (bal >= BigInt(50000) * BigInt(10 ** USDC_DECIMALS)) {
          await vault.connect(user1).deposit(BigInt(50000) * BigInt(10 ** USDC_DECIMALS), user1.address);
        }
      }

      const totalAssets = await vault.totalAssets();
      if (totalAssets === 0n) {
        this.skip();
        return;
      }

      // Try to withdraw 30% (exceeds 25% limit)
      const largeWithdraw = (totalAssets * 30n) / 100n;
      await expect(
        vault.connect(user1).withdraw(largeWithdraw, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalTooLarge");
    });

    it("should enforce cooldown between large withdrawals", async function () {
      const totalAssets = await vault.totalAssets();
      if (totalAssets < BigInt(20000) * BigInt(10 ** USDC_DECIMALS)) {
        this.skip();
        return;
      }

      // First large withdrawal (15% > 10% threshold)
      const largeWithdraw = (totalAssets * 15n) / 100n;
      await vault.connect(user1).withdraw(largeWithdraw, user1.address, user1.address);

      // Second large withdrawal immediately should fail
      const remaining = await vault.totalAssets();
      const secondWithdraw = (remaining * 15n) / 100n;
      await expect(
        vault.connect(user1).withdraw(secondWithdraw, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalCooldownActive");

      // After 1 hour, should succeed
      await time.increase(3601);
      await expect(
        vault.connect(user1).withdraw(secondWithdraw, user1.address, user1.address)
      ).to.not.be.reverted;
    });
  });

  describe("Oracle Staleness with Real Chainlink", function () {
    it("should deploy HedgeManager with real Chainlink feed", async function () {
      const HedgeManager = await ethers.getContractFactory("HedgeManager");

      await expect(
        HedgeManager.deploy(
          ADDRESSES.GMX_EXCHANGE_ROUTER,
          ADDRESSES.GMX_ETH_USD_MARKET,
          ADDRESSES.USDC,
          ADDRESSES.WETH,
          ADDRESSES.CHAINLINK_ETH_USD_FEED,
          owner.address
        )
      ).to.not.be.reverted;
    });

    it("should verify Chainlink feed is returning valid data", async function () {
      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ADDRESSES.CHAINLINK_ETH_USD_FEED
      );

      const [roundId, answer, , updatedAt, answeredInRound] = await priceFeed.latestRoundData();

      // Verify price is reasonable (ETH should be between $500 and $50,000)
      const price = Number(answer) / 1e8;
      expect(price).to.be.gt(500);
      expect(price).to.be.lt(50000);

      // Get block timestamp for fork context
      const blockTimestamp = await time.latest();

      // Verify data is reasonably fresh (within 24 hours for historical fork)
      // Fork tests may use historical data, so we're more lenient
      expect(Number(updatedAt)).to.be.gt(blockTimestamp - 86400);

      // Verify round is complete
      expect(answeredInRound).to.be.gte(roundId);
    });
  });

  describe("TWAP Validation with Real Pool", function () {
    it("should deploy LiquidityManager with TWAP validation", async function () {
      const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
      const liquidityManager = await LiquidityManager.deploy(
        ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
        ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
        ADDRESSES.UNISWAP_V3_FACTORY,
        ADDRESSES.WETH,
        ADDRESSES.USDC,
        3000,
        owner.address
      );
      await liquidityManager.waitForDeployment();

      await liquidityManager.setTWAPValidation(true);
      expect(await liquidityManager.twapValidationEnabled()).to.equal(true);
    });

    it("should compare spot and TWAP deviation", async function () {
      const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
      const liquidityManager = await LiquidityManager.deploy(
        ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
        ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
        ADDRESSES.UNISWAP_V3_FACTORY,
        ADDRESSES.WETH,
        ADDRESSES.USDC,
        500,
        owner.address
      );
      await liquidityManager.waitForDeployment();

      const deviation = await liquidityManager.getSpotTWAPDeviation();
      // Deviation should be small under normal conditions (< 5%)
      expect(deviation).to.be.lte((5n * PRECISION) / 100n);
    });
  });

  describe("Emergency Unwind Simulation", function () {
    it("should execute emergency unwind and pause vault", async function () {
      // Reset state if needed
      if (await vault.paused()) {
        await vault.connect(owner).unpause();
      }
      if (await vault.circuitBreakerTriggered()) {
        await vault.connect(owner).resetCircuitBreaker();
      }

      await expect(vault.connect(owner).emergencyUnwind()).to.emit(vault, "CircuitBreakerTriggered");

      expect(await vault.paused()).to.equal(true);
      expect(await vault.circuitBreakerTriggered()).to.equal(true);

      // Reset
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });

    it("should allow guardian to trigger emergency unwind", async function () {
      await expect(vault.connect(guardian).emergencyUnwind()).to.emit(
        vault,
        "CircuitBreakerTriggered"
      );

      expect(await vault.circuitBreakerTriggered()).to.equal(true);

      // Reset
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });
  });

  describe("Access Control Verification", function () {
    it("should reject unauthorized guardian changes", async function () {
      await expect(
        vault.connect(attacker).setGuardian(attacker.address)
      ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should reject unauthorized circuit breaker trigger", async function () {
      await expect(vault.connect(attacker).triggerCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("should reject unauthorized circuit breaker reset", async function () {
      await vault.connect(owner).triggerCircuitBreaker();

      await expect(vault.connect(guardian).resetCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.connect(attacker).resetCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      // Reset
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });
  });

  describe("Gas Usage Verification", function () {
    it("should measure circuit breaker trigger gas", async function () {
      // Reset if needed
      if (await vault.circuitBreakerTriggered()) {
        await vault.connect(owner).unpause();
        await vault.connect(owner).resetCircuitBreaker();
      }

      const tx = await vault.connect(owner).triggerCircuitBreaker();
      const receipt = await tx.wait();

      expect(receipt?.gasUsed).to.be.lt(100000n);
      console.log(`Circuit breaker trigger gas: ${receipt?.gasUsed}`);

      // Reset
      await vault.connect(owner).unpause();
      await vault.connect(owner).resetCircuitBreaker();
    });

    it("should measure withdrawal with security checks gas", async function () {
      const totalAssets = await vault.totalAssets();
      if (totalAssets < BigInt(10000) * BigInt(10 ** USDC_DECIMALS)) {
        this.skip();
        return;
      }

      // Measure withdrawal gas (5% of assets)
      const withdrawAmount = (totalAssets * 5n) / 100n;
      const tx = await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
      const receipt = await tx.wait();

      expect(receipt?.gasUsed).to.be.lt(200000n);
      console.log(`Withdrawal with security checks gas: ${receipt?.gasUsed}`);
    });
  });
});
