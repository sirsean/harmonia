import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { DeltaNeutralVault, MockERC20 } from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("DeltaNeutralVault", function () {
  // Constants
  const PRECISION = BigInt(10) ** BigInt(18);
  const USDC_DECIMALS = 6;
  const INITIAL_BALANCE = BigInt(1_000_000) * BigInt(10) ** BigInt(USDC_DECIMALS); // 1M USDC

  // Fixture to deploy vault and mock token
  async function deployVaultFixture() {
    const [owner, user1, user2, rebalanceController] = await ethers.getSigners();

    // Deploy mock USDC
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    await usdc.waitForDeployment();

    // Mint initial USDC to users
    await usdc.mint(owner.address, INITIAL_BALANCE);
    await usdc.mint(user1.address, INITIAL_BALANCE);
    await usdc.mint(user2.address, INITIAL_BALANCE);

    // Deploy vault
    const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
    const vault = await upgrades.deployProxy(
      DeltaNeutralVault,
      [await usdc.getAddress(), "Harmonia Delta Neutral", "hdnUSDC", owner.address],
      { kind: "uups" }
    );
    await vault.waitForDeployment();

    // Approve vault to spend USDC
    await usdc.connect(owner).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(user1).approve(await vault.getAddress(), ethers.MaxUint256);
    await usdc.connect(user2).approve(await vault.getAddress(), ethers.MaxUint256);

    return { vault, usdc, owner, user1, user2, rebalanceController };
  }

  describe("Deployment", function () {
    it("should deploy with correct parameters", async function () {
      const { vault, usdc, owner } = await loadFixture(deployVaultFixture);

      expect(await vault.name()).to.equal("Harmonia Delta Neutral");
      expect(await vault.symbol()).to.equal("hdnUSDC");
      expect(await vault.asset()).to.equal(await usdc.getAddress());
      expect(await vault.owner()).to.equal(owner.address);
      expect(await vault.totalAssets()).to.equal(0n);
    });

    it("should have correct constants", async function () {
      const { vault } = await loadFixture(deployVaultFixture);

      expect(await vault.PRECISION()).to.equal(PRECISION);
      expect(await vault.deltaThreshold()).to.equal((5n * PRECISION) / 100n); // 5%
      expect(await vault.emergencyThreshold()).to.equal((20n * PRECISION) / 100n); // 20%
    });

    it("should revert on zero asset address", async function () {
      const [owner] = await ethers.getSigners();
      const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");

      await expect(
        upgrades.deployProxy(
          DeltaNeutralVault,
          [ethers.ZeroAddress, "Test", "TEST", owner.address],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(DeltaNeutralVault, "ZeroAddress");
    });

    it("should revert on zero owner address", async function () {
      const { usdc } = await loadFixture(deployVaultFixture);
      const [owner] = await ethers.getSigners();
      const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");

      // OpenZeppelin's Ownable throws OwnableInvalidOwner for zero address
      await expect(
        upgrades.deployProxy(
          DeltaNeutralVault,
          [await usdc.getAddress(), "Test", "TEST", ethers.ZeroAddress],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(DeltaNeutralVault, "OwnableInvalidOwner");
    });
  });

  describe("Deposit", function () {
    it("should accept deposits and mint shares", async function () {
      const { vault, usdc, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      const sharesBefore = await vault.balanceOf(user1.address);
      expect(sharesBefore).to.equal(0n);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      expect(sharesAfter).to.be.gt(0n);
      expect(await vault.totalAssets()).to.equal(depositAmount);
    });

    it("should mint correct shares based on exchange rate", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      // First deposit - 1:1 ratio
      await vault.connect(user1).deposit(depositAmount, user1.address);
      const shares1 = await vault.balanceOf(user1.address);

      // Shares should equal assets for initial deposit (with decimal adjustment)
      expect(shares1).to.equal(depositAmount);
    });

    it("should emit CapitalDeployed event", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await expect(vault.connect(user1).deposit(depositAmount, user1.address))
        .to.emit(vault, "CapitalDeployed")
        .withArgs(depositAmount, 0n, 0n); // LP and hedge values are 0 in Phase 3
    });

    it("should revert on zero amount deposit", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(user1).deposit(0n, user1.address)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("should respect deposit cap", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositCap = BigInt(50_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const depositAmount = BigInt(60_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(owner).setDepositCap(depositCap);

      await expect(vault.connect(user1).deposit(depositAmount, user1.address))
        .to.be.revertedWithCustomError(vault, "DepositCapExceeded")
        .withArgs(depositAmount, depositCap);
    });

    it("should allow deposit up to cap", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositCap = BigInt(50_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(owner).setDepositCap(depositCap);
      await vault.connect(user1).deposit(depositCap, user1.address);

      expect(await vault.totalAssets()).to.equal(depositCap);
    });

    it("should revert when paused", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(owner).pause();

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });
  });

  describe("Mint", function () {
    it("should mint exact shares", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const sharesToMint = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).mint(sharesToMint, user1.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });

    it("should revert on zero shares mint", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      await expect(vault.connect(user1).mint(0n, user1.address)).to.be.revertedWithCustomError(
        vault,
        "ZeroAmount"
      );
    });

    it("should respect deposit cap when minting", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositCap = BigInt(50_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const sharesToMint = BigInt(60_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(owner).setDepositCap(depositCap);

      await expect(
        vault.connect(user1).mint(sharesToMint, user1.address)
      ).to.be.revertedWithCustomError(vault, "DepositCapExceeded");
    });
  });

  describe("Withdraw", function () {
    it("should allow withdrawal of deposited assets within limits", async function () {
      const { vault, usdc, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      // Withdraw 20% which is within the 25% max single withdrawal limit
      const withdrawAmount = BigInt(2_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const balanceBefore = await usdc.balanceOf(user1.address);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
      const balanceAfter = await usdc.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
      expect(await vault.balanceOf(user1.address)).to.be.gt(0n);
    });

    it("should emit CapitalWithdrawn event", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      // Withdraw 20% which is within the 25% max single withdrawal limit
      const withdrawAmount = BigInt(2_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address))
        .to.emit(vault, "CapitalWithdrawn")
        .withArgs(withdrawAmount, 0n, 0n);
    });

    it("should allow partial withdrawal within security limits", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      // Withdraw 20% which is within the 25% max single withdrawal limit
      const withdrawAmount = BigInt(2_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      expect(await vault.totalAssets()).to.equal(depositAmount - withdrawAmount);
    });

    it("should revert on zero amount withdrawal", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(
        vault.connect(user1).withdraw(0n, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });

    it("should revert when withdrawing more than balance", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const withdrawAmount = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)).to
        .be.reverted;
    });
  });

  describe("Redeem", function () {
    it("should redeem shares for assets within security limits", async function () {
      const { vault, usdc, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const shares = await vault.balanceOf(user1.address);
      // Redeem 20% of shares which is within the 25% max single withdrawal limit
      const redeemShares = (shares * 20n) / 100n;

      const balanceBefore = await usdc.balanceOf(user1.address);
      await vault.connect(user1).redeem(redeemShares, user1.address, user1.address);
      const balanceAfter = await usdc.balanceOf(user1.address);

      // Expect to receive 20% of deposited amount
      expect(balanceAfter - balanceBefore).to.equal((depositAmount * 20n) / 100n);
    });

    it("should revert on zero shares redeem", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(
        vault.connect(user1).redeem(0n, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "ZeroAmount");
    });
  });

  describe("Multiple Users", function () {
    it("should handle multiple depositors correctly", async function () {
      const { vault, user1, user2 } = await loadFixture(deployVaultFixture);
      const deposit1 = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const deposit2 = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(deposit1, user1.address);
      await vault.connect(user2).deposit(deposit2, user2.address);

      expect(await vault.totalAssets()).to.equal(deposit1 + deposit2);
      expect(await vault.balanceOf(user1.address)).to.be.gt(0n);
      expect(await vault.balanceOf(user2.address)).to.be.gt(0n);
    });

    it("should maintain correct share ratios", async function () {
      const { vault, user1, user2 } = await loadFixture(deployVaultFixture);
      const deposit1 = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const deposit2 = BigInt(20_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(deposit1, user1.address);
      await vault.connect(user2).deposit(deposit2, user2.address);

      const shares1 = await vault.balanceOf(user1.address);
      const shares2 = await vault.balanceOf(user2.address);

      // User2 should have 2x the shares (deposited 2x the amount)
      expect(shares2).to.equal(shares1 * 2n);
    });
  });

  describe("Total Assets", function () {
    it("should return correct total assets after deposits", async function () {
      const { vault, user1, user2 } = await loadFixture(deployVaultFixture);
      const deposit1 = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const deposit2 = BigInt(5_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(deposit1, user1.address);
      expect(await vault.totalAssets()).to.equal(deposit1);

      await vault.connect(user2).deposit(deposit2, user2.address);
      expect(await vault.totalAssets()).to.equal(deposit1 + deposit2);
    });

    it("should return correct total assets after withdrawals", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      // Withdraw 20% which is within the 25% max single withdrawal limit
      const withdrawAmount = BigInt(2_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      expect(await vault.totalAssets()).to.equal(depositAmount - withdrawAmount);
    });
  });

  describe("View Functions", function () {
    it("should return 0 for LP value in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.getLPValue()).to.equal(0n);
    });

    it("should return 0 for hedge value in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.getHedgeValue()).to.equal(0n);
    });

    it("should return 0 for net delta in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.getNetDelta()).to.equal(0n);
    });

    it("should return 0 for delta ratio in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.getDeltaRatio()).to.equal(0n);
    });

    it("should not need rebalance in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.rebalanceNeeded()).to.equal(false);
    });

    it("should not be in emergency in Phase 3", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.isEmergency()).to.equal(false);
    });
  });

  describe("Admin Functions", function () {
    describe("setDepositCap", function () {
      it("should allow owner to set deposit cap", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);
        const newCap = BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

        await vault.connect(owner).setDepositCap(newCap);

        expect(await vault.depositCap()).to.equal(newCap);
      });

      it("should emit DepositCapUpdated event", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);
        const newCap = BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

        await expect(vault.connect(owner).setDepositCap(newCap))
          .to.emit(vault, "DepositCapUpdated")
          .withArgs(0n, newCap);
      });

      it("should reject non-owner setting deposit cap", async function () {
        const { vault, user1 } = await loadFixture(deployVaultFixture);
        const newCap = BigInt(100_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

        await expect(vault.connect(user1).setDepositCap(newCap)).to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount"
        );
      });
    });

    describe("setCircuitBreakerEnabled", function () {
      it("should allow owner to set circuit breaker enabled status", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);

        await vault.connect(owner).setCircuitBreakerEnabled(false);
        expect(await vault.circuitBreakerEnabled()).to.equal(false);

        await vault.connect(owner).setCircuitBreakerEnabled(true);
        expect(await vault.circuitBreakerEnabled()).to.equal(true);
      });

      it("should emit CircuitBreakerEnabled event", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);

        await expect(vault.connect(owner).setCircuitBreakerEnabled(false))
          .to.emit(vault, "CircuitBreakerEnabled")
          .withArgs(false);
      });

      it("should reject non-owner setting circuit breaker", async function () {
        const { vault, user1 } = await loadFixture(deployVaultFixture);

        await expect(
          vault.connect(user1).setCircuitBreakerEnabled(false)
        ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      });
    });

    describe("setManagers", function () {
      it("should allow owner to set managers", async function () {
        const { vault, owner, rebalanceController, usdc } = await loadFixture(deployVaultFixture);

        // Deploy MockLiquidityManager
        const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
        // Use USDC for both for simplicity, or deploy another mock
        const mockLiqMgr = await MockLiquidityManager.deploy(
          await usdc.getAddress(),
          await usdc.getAddress()
        );
        const liquidityManager = await mockLiqMgr.getAddress();

        const hedgeManager = ethers.Wallet.createRandom().address;

        await vault
          .connect(owner)
          .setManagers(liquidityManager, hedgeManager, rebalanceController.address);

        expect(await vault.liquidityManager()).to.equal(liquidityManager);
        expect(await vault.hedgeManager()).to.equal(hedgeManager);
        expect(await vault.rebalanceController()).to.equal(rebalanceController.address);
      });

      it("should emit ManagersUpdated event", async function () {
        const { vault, owner, rebalanceController, usdc } = await loadFixture(deployVaultFixture);
        const MockLiquidityManager = await ethers.getContractFactory("MockLiquidityManager");
        const mockLiqMgr = await MockLiquidityManager.deploy(
          await usdc.getAddress(),
          await usdc.getAddress()
        );
        const liquidityManager = await mockLiqMgr.getAddress();
        const hedgeManager = ethers.Wallet.createRandom().address;

        await expect(
          vault
            .connect(owner)
            .setManagers(liquidityManager, hedgeManager, rebalanceController.address)
        )
          .to.emit(vault, "ManagersUpdated")
          .withArgs(liquidityManager, hedgeManager, rebalanceController.address);
      });

      it("should reject non-owner setting managers", async function () {
        const { vault, user1, rebalanceController } = await loadFixture(deployVaultFixture);
        const liquidityManager = ethers.Wallet.createRandom().address;
        const hedgeManager = ethers.Wallet.createRandom().address;

        await expect(
          vault
            .connect(user1)
            .setManagers(liquidityManager, hedgeManager, rebalanceController.address)
        ).to.be.revertedWithCustomError(vault, "OwnableUnauthorizedAccount");
      });
    });

    describe("pause/unpause", function () {
      it("should allow owner to pause", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);

        await vault.connect(owner).pause();

        expect(await vault.paused()).to.equal(true);
      });

      it("should allow owner to unpause", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);

        await vault.connect(owner).pause();
        await vault.connect(owner).unpause();

        expect(await vault.paused()).to.equal(false);
      });

      it("should reject non-owner pause", async function () {
        const { vault, user1 } = await loadFixture(deployVaultFixture);

        await expect(vault.connect(user1).pause()).to.be.revertedWithCustomError(
          vault,
          "OwnableUnauthorizedAccount"
        );
      });
    });

    describe("emergencyUnwind", function () {
      it("should pause vault on emergency unwind", async function () {
        const { vault, owner } = await loadFixture(deployVaultFixture);

        await vault.connect(owner).emergencyUnwind();

        expect(await vault.paused()).to.equal(true);
      });

      it("should reject non-owner/non-guardian emergency unwind", async function () {
        const { vault, user1 } = await loadFixture(deployVaultFixture);

        // Now uses Unauthorized error since guardian is also allowed
        await expect(vault.connect(user1).emergencyUnwind()).to.be.revertedWithCustomError(
          vault,
          "Unauthorized"
        );
      });
    });
  });

  describe("Rebalance", function () {
    it("should allow owner to rebalance", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.connect(owner).rebalance(1000n)).to.emit(vault, "Rebalanced");
    });

    it("should allow rebalance controller to rebalance", async function () {
      const { vault, owner, user1, rebalanceController } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      await vault
        .connect(owner)
        .setManagers(ethers.ZeroAddress, ethers.ZeroAddress, rebalanceController.address);

      await expect(vault.connect(rebalanceController).rebalance(1000n)).to.emit(
        vault,
        "Rebalanced"
      );
    });

    it("should reject unauthorized rebalance", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.connect(user1).rebalance(1000n)).to.be.revertedWithCustomError(
        vault,
        "Unauthorized"
      );
    });

    it("should update lastRebalanceTime", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const timeBefore = await vault.lastRebalanceTime();
      expect(timeBefore).to.equal(0n);

      await vault.connect(owner).rebalance(1000n);

      const timeAfter = await vault.lastRebalanceTime();
      expect(timeAfter).to.be.gt(0n);
    });
  });

  describe("Fee Collection", function () {
    it("should emit FeesCollected event (with zero values in Phase 3)", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.collectFees()).to.emit(vault, "FeesCollected").withArgs(0n, 0n, 0n);
    });
  });

  describe("Funding Claims", function () {
    it("should emit FundingClaimed event (with zero value in Phase 3)", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      await expect(vault.claimFunding()).to.emit(vault, "FundingClaimed").withArgs(0n);
    });
  });

  describe("ERC-4626 Preview Functions", function () {
    it("should preview deposit correctly", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      const assets = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      const shares = await vault.previewDeposit(assets);
      expect(shares).to.equal(assets); // 1:1 for initial deposit
    });

    it("should preview mint correctly", async function () {
      const { vault } = await loadFixture(deployVaultFixture);
      const shares = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      const assets = await vault.previewMint(shares);
      expect(assets).to.equal(shares); // 1:1 for initial mint
    });

    it("should preview withdraw correctly", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const shares = await vault.previewWithdraw(depositAmount);
      expect(shares).to.equal(depositAmount);
    });

    it("should preview redeem correctly", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const shares = await vault.balanceOf(user1.address);

      const assets = await vault.previewRedeem(shares);
      expect(assets).to.equal(depositAmount);
    });
  });

  describe("Max Deposit/Mint/Withdraw/Redeem", function () {
    it("should return max deposit without cap", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);

      const maxDeposit = await vault.maxDeposit(user1.address);
      expect(maxDeposit).to.equal(ethers.MaxUint256);
    });

    it("should return max withdraw", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      const maxWithdraw = await vault.maxWithdraw(user1.address);
      expect(maxWithdraw).to.equal(depositAmount);
    });

    it("should return max redeem", async function () {
      const { vault, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const shares = await vault.balanceOf(user1.address);

      const maxRedeem = await vault.maxRedeem(user1.address);
      expect(maxRedeem).to.equal(shares);
    });
  });

  describe("Circuit Breaker Control", function () {
    it("should allow withdrawal when circuit breaker is disabled even if triggered", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);
      const withdrawAmount = BigInt(1_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();
      expect(await vault.circuitBreakerTriggered()).to.equal(true);

      // Verify withdrawal fails initially
      await expect(
        vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "CircuitBreakerActive");

      // Disable circuit breaker
      await vault.connect(owner).setCircuitBreakerEnabled(false);

      // Verify withdrawal now succeeds
      await expect(vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address)).to
        .not.be.reverted;
    });

    it("should allow redemption when circuit breaker is disabled even if triggered", async function () {
      const { vault, owner, user1 } = await loadFixture(deployVaultFixture);
      const depositAmount = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await vault.connect(user1).deposit(depositAmount, user1.address);
      const shares = await vault.balanceOf(user1.address);
      const redeemShares = (shares * 10n) / 100n; // 10%

      // Trigger circuit breaker
      await vault.connect(owner).triggerCircuitBreaker();

      // Verify redemption fails initially
      await expect(
        vault.connect(user1).redeem(redeemShares, user1.address, user1.address)
      ).to.be.revertedWithCustomError(vault, "CircuitBreakerActive");

      // Disable circuit breaker
      await vault.connect(owner).setCircuitBreakerEnabled(false);

      // Verify redemption now succeeds
      await expect(vault.connect(user1).redeem(redeemShares, user1.address, user1.address)).to.not
        .be.reverted;
    });
  });
});
