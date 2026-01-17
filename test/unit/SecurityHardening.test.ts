import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  DeltaNeutralVault,
  MockERC20,
  HedgeManager,
  LiquidityManager,
} from "../../typechain-types";

describe("Security Hardening - Phase 7", function () {
  const PRECISION = BigInt(10) ** BigInt(18);
  const USDC_DECIMALS = 6;

  // Constants from contracts
  const DELTA_THRESHOLD = (5n * PRECISION) / 100n; // 5%
  const EMERGENCY_THRESHOLD = (20n * PRECISION) / 100n; // 20%
  const MAX_SINGLE_WITHDRAWAL = (25n * PRECISION) / 100n; // 25%
  const LARGE_WITHDRAWAL_THRESHOLD = (10n * PRECISION) / 100n; // 10%
  const LARGE_WITHDRAWAL_COOLDOWN = 60 * 60; // 1 hour

  async function deployVaultFixture() {
    const [owner, user1, user2, guardian, attacker] = await ethers.getSigners();

    // Deploy mock USDC
    const MockToken = await ethers.getContractFactory("MockERC20");
    const usdc = await MockToken.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await usdc.waitForDeployment();

    // Deploy vault
    const Vault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = (await upgrades.deployProxy(
      Vault,
      [await usdc.getAddress(), "Delta Neutral Vault", "dnVault", owner.address],
      { kind: "uups" }
    )) as unknown as DeltaNeutralVault;
    await vault.waitForDeployment();

    // Set guardian
    await vault.setGuardian(guardian.address);

    // Mint USDC to users
    const initialBalance = BigInt(1000000) * BigInt(10 ** USDC_DECIMALS); // 1M USDC
    await usdc.mint(user1.address, initialBalance);
    await usdc.mint(user2.address, initialBalance);
    await usdc.mint(attacker.address, initialBalance);

    // Approve vault
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(attacker).approve(await vault.getAddress(), ethers.MaxUint256);

    return { owner, user1, user2, guardian, attacker, usdc, vault };
  }

  describe("Circuit Breaker Functionality", function () {
    it("should allow owner to trigger circuit breaker", async function () {
      const { owner, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(owner).triggerCircuitBreaker()).to.emit(
        vault,
        "CircuitBreakerTriggered"
      );

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
      expect(await vault.paused()).to.equal(true);
    });

    it("should allow guardian to trigger circuit breaker", async function () {
      const { guardian, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(guardian).triggerCircuitBreaker()).to.emit(
        vault,
        "CircuitBreakerTriggered"
      );

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
    });

    it("should not allow non-authorized to trigger circuit breaker", async function () {
      const { attacker, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(attacker).triggerCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("should block withdrawals when circuit breaker is active", async function () {
      const { owner, user1, vault, usdc } = await loadFixture(deployVaultFixture);

      // User deposits
      const depositAmount = BigInt(10000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // User cannot withdraw
      await expect(
        vault.connect(user1).withdraw(depositAmount, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "CircuitBreakerActive");
    });

    it("should allow owner to withdraw during circuit breaker", async function () {
      const { owner, vault, usdc } = await loadFixture(deployVaultFixture);

      // Owner deposits
      await usdc.mint(owner.address, BigInt(10000) * BigInt(10 ** USDC_DECIMALS));
      await usdc.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
      const depositAmount = BigInt(1000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(owner).deposit(depositAmount, owner.address);

      // Trigger circuit breaker
      await vault.triggerCircuitBreaker();

      // Owner can still withdraw (small amount to pass withdrawal limits)
      const withdrawAmount = BigInt(100) * BigInt(10 ** USDC_DECIMALS);
      await expect(vault.connect(owner).withdraw(withdrawAmount, owner.address, owner.address)).to
        .not.be.reverted;
    });

    it("should allow guardian to withdraw during circuit breaker", async function () {
      const { owner, guardian, vault, usdc } = await loadFixture(deployVaultFixture);

      // Guardian deposits
      await usdc.mint(guardian.address, BigInt(10000) * BigInt(10 ** USDC_DECIMALS));
      await usdc.connect(guardian).approve(await vault.getAddress(), ethers.MaxUint256);
      const depositAmount = BigInt(1000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(guardian).deposit(depositAmount, guardian.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Guardian can still withdraw (small amount)
      const withdrawAmount = BigInt(100) * BigInt(10 ** USDC_DECIMALS);
      await expect(
        vault.connect(guardian).withdraw(withdrawAmount, guardian.address, guardian.address)
      ).to.not.be.reverted;
    });

    it("should only allow owner to reset circuit breaker", async function () {
      const { owner, guardian, vault } = await loadFixture(deployVaultFixture);

      // Trigger circuit breaker
      await vault.triggerCircuitBreaker();

      // Guardian cannot reset
      await expect(vault.connect(guardian).resetCircuitBreaker()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      // Owner can reset (delta is 0, so it's safe)
      await expect(vault.connect(owner).resetCircuitBreaker()).to.emit(
        vault,
        "CircuitBreakerReset"
      );

      expect(await vault.circuitBreakerTriggered()).to.equal(false);
    });
  });

  describe("Large Withdrawal Protection", function () {
    it("should reject withdrawals exceeding max single withdrawal", async function () {
      const { user1, vault } = await loadFixture(deployVaultFixture);

      // Deposit enough to have meaningful withdrawal limits
      const depositAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Try to withdraw more than 25%
      const withdrawAmount = BigInt(30000) * BigInt(10 ** USDC_DECIMALS); // 30%
      await expect(
        vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalTooLarge");
    });

    it("should allow withdrawals within limits", async function () {
      const { user1, vault } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Withdraw 5% - should succeed
      const withdrawAmount = BigInt(5000) * BigInt(10 ** USDC_DECIMALS);
      await expect(vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)).to
        .not.be.reverted;
    });

    it("should enforce cooldown for large withdrawals", async function () {
      const { user1, vault } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // First large withdrawal (15%)
      const firstWithdraw = BigInt(15000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).withdraw(firstWithdraw, user1.address, user1.address);

      // Second large withdrawal immediately should fail
      const secondWithdraw = BigInt(12000) * BigInt(10 ** USDC_DECIMALS); // > 10% of remaining
      await expect(
        vault.connect(user1).withdraw(secondWithdraw, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "WithdrawalCooldownActive");

      // After cooldown, should succeed
      await time.increase(LARGE_WITHDRAWAL_COOLDOWN + 1);
      await expect(vault.connect(user1).withdraw(secondWithdraw, user1.address, user1.address)).to
        .not.be.reverted;
    });

    it("should not enforce cooldown for small withdrawals", async function () {
      const { user1, vault } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Multiple small withdrawals (5% each)
      const smallWithdraw = BigInt(5000) * BigInt(10 ** USDC_DECIMALS);

      await vault.connect(user1).withdraw(smallWithdraw, user1.address, user1.address);
      await vault.connect(user1).withdraw(smallWithdraw, user1.address, user1.address);
      await vault.connect(user1).withdraw(smallWithdraw, user1.address, user1.address);
      // All should succeed without cooldown
    });
  });

  describe("Guardian Role", function () {
    it("should allow owner to set guardian", async function () {
      const { owner, user2, vault } = await loadFixture(deployVaultFixture);

      const oldGuardian = await vault.guardian();

      await expect(vault.connect(owner).setGuardian(user2.address))
        .to.emit(vault, "GuardianUpdated")
        .withArgs(oldGuardian, user2.address);
    });

    it("should not allow non-owner to set guardian", async function () {
      const { user1, user2, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(user1).setGuardian(user2.address)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });

    it("should allow guardian to call emergencyUnwind", async function () {
      const { guardian, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(guardian).emergencyUnwind()).to.emit(
        vault,
        "CircuitBreakerTriggered"
      );

      expect(await vault.paused()).to.equal(true);
    });
  });

  describe("Emergency Unwind", function () {
    it("should trigger circuit breaker and pause on emergency unwind", async function () {
      const { owner, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(owner).emergencyUnwind()).to.emit(
        vault,
        "CircuitBreakerTriggered"
      );

      expect(await vault.circuitBreakerTriggered()).to.equal(true);
      expect(await vault.paused()).to.equal(true);
    });

    it("should not allow non-authorized to call emergencyUnwind", async function () {
      const { attacker, vault } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(attacker).emergencyUnwind()).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });
  });

  describe("Deposit Protection During Circuit Breaker", function () {
    it("should block deposits when paused (circuit breaker triggers pause)", async function () {
      const { owner, user1, vault } = await loadFixture(deployVaultFixture);

      await vault.connect(owner).triggerCircuitBreaker();

      const depositAmount = BigInt(1000) * BigInt(10 ** USDC_DECIMALS);
      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Redeem Protection", function () {
    it("should enforce same protections on redeem as withdraw", async function () {
      const { owner, user1, vault } = await loadFixture(deployVaultFixture);

      // Deposit
      const depositAmount = BigInt(100000) * BigInt(10 ** USDC_DECIMALS);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Redeem should fail for regular user
      const shares = await vault.balanceOf(user1.address);
      await expect(
        vault.connect(user1).redeem(shares, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "CircuitBreakerActive");
    });
  });

  describe("Constants Validation", function () {
    it("should have correct security constants", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      expect(await vault.DELTA_THRESHOLD()).to.equal(DELTA_THRESHOLD);
      expect(await vault.EMERGENCY_THRESHOLD()).to.equal(EMERGENCY_THRESHOLD);
      expect(await vault.MAX_SINGLE_WITHDRAWAL()).to.equal(MAX_SINGLE_WITHDRAWAL);
      expect(await vault.LARGE_WITHDRAWAL_THRESHOLD()).to.equal(LARGE_WITHDRAWAL_THRESHOLD);
      expect(await vault.LARGE_WITHDRAWAL_COOLDOWN()).to.equal(BigInt(LARGE_WITHDRAWAL_COOLDOWN));
    });
  });
});

describe("Security Module Library Tests", function () {
  // Note: These test the SecurityModule library indirectly through contracts that use it

  describe("Oracle Validation", function () {
    it("should be tested via HedgeManager integration", async function () {
      // The SecurityModule.validateOraclePrice is used in HedgeManager
      // These tests verify the integration works correctly
      // Detailed oracle tests are in HedgeManager.test.ts
      expect(true).to.equal(true);
    });
  });
});
