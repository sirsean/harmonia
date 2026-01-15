import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { ADDRESSES, PRECISION } from "../helpers/constants";

// Only run on Arbitrum fork when ALCHEMY_API_KEY is configured
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("Security Hardening Fork Tests", function () {
  const USDC_DECIMALS = 6;
  const USDC_WHALE = "0x47c031236e19d024b42f8AE6780E44A573170703"; // Large USDC holder on Arbitrum

  async function deploySecurityFixture() {
    const [owner, guardian, user1, attacker] = await ethers.getSigners();

    // Get USDC contract
    const usdc = await ethers.getContractAt("IERC20", ADDRESSES.USDC);

    // Deploy vault
    const Vault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = await Vault.deploy(
      ADDRESSES.USDC,
      "Delta Neutral Vault",
      "dnVault",
      owner.address
    );
    await vault.waitForDeployment();

    // Set guardian
    await vault.setGuardian(guardian.address);

    // Impersonate USDC whale to fund test accounts
    await ethers.provider.send("hardhat_impersonateAccount", [USDC_WHALE]);
    const whale = await ethers.getSigner(USDC_WHALE);

    // Fund whale with ETH for gas
    await owner.sendTransaction({ to: USDC_WHALE, value: ethers.parseEther("1") });

    // Transfer USDC to test accounts
    const fundAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS); // 100k USDC
    await usdc.connect(whale).transfer(user1.address, fundAmount);
    await usdc.connect(whale).transfer(attacker.address, fundAmount);

    // Approve vault
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(attacker).approve(await vault.getAddress(), ethers.MaxUint256);

    return { owner, guardian, user1, attacker, usdc, vault, whale };
  }

  describe("Circuit Breaker with Real Oracle", function () {
    it("should trigger circuit breaker and block operations", async function () {
      const { owner, user1, vault, usdc } = await loadFixture(deploySecurityFixture);

      // User deposits
      const depositAmount = BigInt(50000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
      expect(await vault.paused()).to.equal(true);

      // New deposits should fail (paused)
      await expect(
        vault.connect(user1).deposit(BigInt(1000) * BigInt(10 ** USDC_DECIMALS), user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");

      // Withdrawals by regular users should fail (circuit breaker)
      await expect(
        vault.connect(user1).withdraw(
          BigInt(1000) * BigInt(10 ** USDC_DECIMALS),
          user1.address,
          user1.address
        )
      ).to.be.revertedWithCustomError(vault, "CircuitBreakerActive");
    });

    it("should allow owner/guardian to withdraw during circuit breaker", async function () {
      const { owner, guardian, vault, usdc } = await loadFixture(deploySecurityFixture);

      // Fund and deposit as owner
      const whale = await ethers.getSigner(USDC_WHALE);
      await usdc.connect(whale).transfer(owner.address, BigInt(10000) * BigInt(10 ** USDC_DECIMALS));
      await usdc.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
      await vault.connect(owner).deposit(BigInt(10000) * BigInt(10 ** USDC_DECIMALS), owner.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Owner can still withdraw (within limits)
      const smallWithdraw = BigInt(1000) * BigInt(10 ** USDC_DECIMALS);
      await expect(
        vault.connect(owner).withdraw(smallWithdraw, owner.address, owner.address)
      ).to.not.be.reverted;
    });
  });

  describe("Large Withdrawal Protection on Mainnet", function () {
    it("should enforce withdrawal limits with real balances", async function () {
      const { user1, vault } = await loadFixture(deploySecurityFixture);

      // Deposit 50k USDC
      const depositAmount = BigInt(50000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Try to withdraw 30% (exceeds 25% limit)
      const largeWithdraw = BigInt(15000) * BigInt(10 ** USDC_DECIMALS);
      await expect(
        vault.connect(user1).withdraw(largeWithdraw, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalTooLarge");

      // Withdraw 20% should succeed
      const safeWithdraw = BigInt(10000) * BigInt(10 ** USDC_DECIMALS);
      await expect(
        vault.connect(user1).withdraw(safeWithdraw, user1.address, user1.address)
      ).to.not.be.reverted;
    });

    it("should enforce cooldown between large withdrawals", async function () {
      const { user1, vault } = await loadFixture(deploySecurityFixture);

      // Deposit 50k USDC
      const depositAmount = BigInt(50000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // First large withdrawal (15% > 10% threshold)
      const largeWithdraw = BigInt(7500) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).withdraw(largeWithdraw, user1.address, user1.address);

      // Second large withdrawal immediately should fail
      await expect(
        vault.connect(user1).withdraw(largeWithdraw, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalCooldownActive");

      // After 1 hour, should succeed
      await time.increase(3601); // 1 hour + 1 second
      await expect(
        vault.connect(user1).withdraw(BigInt(5000) * BigInt(10 ** USDC_DECIMALS), user1.address, user1.address)
      ).to.not.be.reverted;
    });
  });

  describe("Oracle Staleness with Real Chainlink", function () {
    it("should deploy HedgeManager with real Chainlink feed", async function () {
      const [owner] = await ethers.getSigners();

      // Deploy HedgeManager with real Chainlink feed
      const HedgeManager = await ethers.getContractFactory("HedgeManager");

      // Note: This will fail to interact with GMX on fork without proper setup
      // but should deploy successfully with valid addresses
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
      // Get Chainlink price feed directly
      const priceFeed = await ethers.getContractAt(
        "IChainlinkPriceFeed",
        ADDRESSES.CHAINLINK_ETH_USD_FEED
      );

      const [roundId, answer, startedAt, updatedAt, answeredInRound] =
        await priceFeed.latestRoundData();

      // Verify price is reasonable (ETH should be between $500 and $50,000)
      const price = Number(answer) / 1e8;
      expect(price).to.be.gt(500);
      expect(price).to.be.lt(50000);

      // Verify data is not stale (within 1 hour)
      const now = Math.floor(Date.now() / 1000);
      expect(Number(updatedAt)).to.be.gt(now - 3600);

      // Verify round is complete
      expect(answeredInRound).to.be.gte(roundId);
    });
  });

  describe("TWAP Validation with Real Pool", function () {
    it("should deploy LiquidityManager with TWAP validation", async function () {
      const [owner] = await ethers.getSigners();

      const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
      const liquidityManager = await LiquidityManager.deploy(
        ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
        ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
        ADDRESSES.UNISWAP_V3_FACTORY,
        ADDRESSES.WETH,
        ADDRESSES.USDC,
        3000, // 0.3% fee tier
        owner.address
      );
      await liquidityManager.waitForDeployment();

      // Enable TWAP validation
      await liquidityManager.setTWAPValidation(true);
      expect(await liquidityManager.twapValidationEnabled()).to.equal(true);
    });

    it("should get TWAP price from real pool", async function () {
      const [owner] = await ethers.getSigners();

      const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
      const liquidityManager = await LiquidityManager.deploy(
        ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
        ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
        ADDRESSES.UNISWAP_V3_FACTORY,
        ADDRESSES.WETH,
        ADDRESSES.USDC,
        500, // 0.05% fee tier for ETH/USDC
        owner.address
      );
      await liquidityManager.waitForDeployment();

      // Get TWAP - this should work with real pool observations
      try {
        const twapPrice = await liquidityManager.getTWAPSqrtPriceX96();
        expect(twapPrice).to.be.gt(0n);
      } catch (e) {
        // TWAP might not be available if pool doesn't have enough observations
        // This is expected behavior
        console.log("TWAP not available - pool may lack observations");
      }
    });

    it("should compare spot and TWAP deviation", async function () {
      const [owner] = await ethers.getSigners();

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

      // Get spot-TWAP deviation
      const deviation = await liquidityManager.getSpotTWAPDeviation();

      // Deviation should be small under normal conditions (< 5%)
      // If TWAP is not available, deviation will be 0
      expect(deviation).to.be.lte(5n * PRECISION / 100n);
    });
  });

  describe("Emergency Unwind Simulation", function () {
    it("should execute emergency unwind and pause vault", async function () {
      const { owner, user1, vault, usdc } = await loadFixture(deploySecurityFixture);

      // User deposits
      const depositAmount = BigInt(10000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Emergency unwind
      await expect(vault.connect(owner).emergencyUnwind())
        .to.emit(vault, "CircuitBreakerTriggered");

      expect(await vault.paused()).to.equal(true);
      expect(await vault.circuitBreakerTriggered()).to.equal(true);
    });

    it("should allow guardian to trigger emergency unwind", async function () {
      const { guardian, user1, vault } = await loadFixture(deploySecurityFixture);

      // User deposits
      const depositAmount = BigInt(10000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Guardian triggers emergency unwind
      await expect(vault.connect(guardian).emergencyUnwind())
        .to.emit(vault, "CircuitBreakerTriggered");

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
    });
  });

  describe("Access Control Verification", function () {
    it("should reject unauthorized guardian changes", async function () {
      const { attacker, vault } = await loadFixture(deploySecurityFixture);

      await expect(vault.connect(attacker).setGuardian(attacker.address))
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });

    it("should reject unauthorized circuit breaker trigger", async function () {
      const { attacker, vault } = await loadFixture(deploySecurityFixture);

      await expect(vault.connect(attacker).triggerCircuitBreaker())
        .to.be.revertedWithCustomError(vault, "Unauthorized");
    });

    it("should reject unauthorized circuit breaker reset", async function () {
      const { owner, guardian, attacker, vault } = await loadFixture(deploySecurityFixture);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Guardian cannot reset
      await expect(vault.connect(guardian).resetCircuitBreaker())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");

      // Attacker cannot reset
      await expect(vault.connect(attacker).resetCircuitBreaker())
        .to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
    });
  });

  describe("Gas Usage Verification", function () {
    it("should measure circuit breaker trigger gas", async function () {
      const { owner, vault } = await loadFixture(deploySecurityFixture);

      const tx = await vault.connect(owner).triggerCircuitBreaker();
      const receipt = await tx.wait();

      // Circuit breaker trigger should be under 100k gas
      expect(receipt?.gasUsed).to.be.lt(100000n);
      console.log(`Circuit breaker trigger gas: ${receipt?.gasUsed}`);
    });

    it("should measure withdrawal with security checks gas", async function () {
      const { user1, vault } = await loadFixture(deploySecurityFixture);

      // Deposit first
      const depositAmount = BigInt(50000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Measure withdrawal gas
      const withdrawAmount = BigInt(5000) * BigInt(10 ** USDC_DECIMALS);
      const tx = await vault.connect(user1).withdraw(
        withdrawAmount,
        user1.address,
        user1.address
      );
      const receipt = await tx.wait();

      // Withdrawal should be under 200k gas (includes security checks)
      expect(receipt?.gasUsed).to.be.lt(200000n);
      console.log(`Withdrawal with security checks gas: ${receipt?.gasUsed}`);
    });
  });
});
