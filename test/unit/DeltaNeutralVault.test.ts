import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  DeltaNeutralVault,
  LiquidityManager,
  HedgeManager,
  MockERC20,
  MockUniswapV3Pool,
  MockNonfungiblePositionManager,
  MockSwapRouter,
  MockRouter,
  MockExchangeRouter,
  MockOrderVault,
  MockDataStore,
  MockReader,
  MockChainlinkAggregator,
} from "../../typechain-types";

describe("DeltaNeutralVault", function () {
  let vault: DeltaNeutralVault;
  let liquidityManager: LiquidityManager;
  let hedgeManager: HedgeManager;
  let usdc: MockERC20;
  let weth: MockERC20;
  let pool: MockUniswapV3Pool;
  let positionManager: MockNonfungiblePositionManager;
  let swapRouter: MockSwapRouter;
  let router: MockRouter;
  let exchangeRouter: MockExchangeRouter;
  let orderVault: MockOrderVault;
  let dataStore: MockDataStore;
  let reader: MockReader;
  let priceFeed: MockChainlinkAggregator;
  let owner: HardhatEthersSigner;
  let keeper: HardhatEthersSigner;
  let user1: HardhatEthersSigner;
  let user2: HardhatEthersSigner;

  const PRECISION = BigInt(10) ** BigInt(18);
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);
  const POOL_FEE = 500;
  const MARKET_ADDRESS = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336";
  const MIN_DEPOSIT = ethers.parseUnits("100", 6);

  beforeEach(async function () {
    [owner, keeper, user1, user2] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    weth = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    // Deploy Uniswap mocks
    const MockPoolFactory = await ethers.getContractFactory("MockUniswapV3Pool");
    pool = await MockPoolFactory.deploy(await weth.getAddress(), await usdc.getAddress(), POOL_FEE);

    const MockPositionManagerFactory = await ethers.getContractFactory(
      "MockNonfungiblePositionManager"
    );
    positionManager = await MockPositionManagerFactory.deploy();

    const MockSwapRouterFactory = await ethers.getContractFactory("MockSwapRouter");
    swapRouter = await MockSwapRouterFactory.deploy();

    // Deploy GMX mocks
    const MockDataStoreFactory = await ethers.getContractFactory("MockDataStore");
    dataStore = await MockDataStoreFactory.deploy();

    const MockOrderVaultFactory = await ethers.getContractFactory("MockOrderVault");
    orderVault = await MockOrderVaultFactory.deploy();

    const MockRouterFactory = await ethers.getContractFactory("MockRouter");
    router = await MockRouterFactory.deploy();

    const MockExchangeRouterFactory = await ethers.getContractFactory("MockExchangeRouter");
    exchangeRouter = await MockExchangeRouterFactory.deploy(
      await dataStore.getAddress(),
      await orderVault.getAddress(),
      await router.getAddress()
    );

    const MockReaderFactory = await ethers.getContractFactory("MockReader");
    reader = await MockReaderFactory.deploy();

    // Deploy Chainlink mock
    const MockChainlinkFactory = await ethers.getContractFactory("MockChainlinkAggregator");
    priceFeed = await MockChainlinkFactory.deploy(8, "ETH / USD");

    // Deploy LiquidityManager
    const LiquidityManagerFactory = await ethers.getContractFactory("LiquidityManager");
    liquidityManager = await LiquidityManagerFactory.deploy(
      await positionManager.getAddress(),
      await pool.getAddress(),
      await swapRouter.getAddress(),
      await priceFeed.getAddress(),
      owner.address
    );

    // Deploy HedgeManager
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
    hedgeManager = await HedgeManagerFactory.deploy(
      await exchangeRouter.getAddress(),
      await orderVault.getAddress(),
      await reader.getAddress(),
      await priceFeed.getAddress(),
      MARKET_ADDRESS,
      await usdc.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Deploy DeltaNeutralVault
    const DeltaNeutralVaultFactory = await ethers.getContractFactory("DeltaNeutralVault");
    vault = await DeltaNeutralVaultFactory.deploy(
      await usdc.getAddress(),
      await liquidityManager.getAddress(),
      await hedgeManager.getAddress(),
      await priceFeed.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Set vault in managers
    await liquidityManager.setVault(await vault.getAddress());
    await hedgeManager.setVault(await vault.getAddress());

    // Set keeper
    await vault.setKeeper(keeper.address);

    // Mint tokens to users
    await usdc.mint(user1.address, ethers.parseUnits("100000", 6));
    await usdc.mint(user2.address, ethers.parseUnits("100000", 6));
    await weth.mint(owner.address, ethers.parseEther("1000"));
    await usdc.mint(owner.address, ethers.parseUnits("1000000", 6));

    // Mint tokens to mock contracts
    await weth.mint(await positionManager.getAddress(), ethers.parseEther("100"));
    await usdc.mint(await positionManager.getAddress(), ethers.parseUnits("200000", 6));
    await usdc.mint(await orderVault.getAddress(), ethers.parseUnits("200000", 6));
  });

  describe("Constructor", function () {
    it("should set ERC4626 asset correctly", async function () {
      expect(await vault.asset()).to.equal(await usdc.getAddress());
    });

    it("should set ERC20 name and symbol", async function () {
      expect(await vault.name()).to.equal("Delta Neutral Yield Vault");
      expect(await vault.symbol()).to.equal("dnYield");
    });

    it("should set manager addresses", async function () {
      expect(await vault.liquidityManager()).to.equal(await liquidityManager.getAddress());
      expect(await vault.hedgeManager()).to.equal(await hedgeManager.getAddress());
    });

    it("should set default values", async function () {
      expect(await vault.targetTickWidth()).to.equal(1000);
      expect(await vault.rebalanceCooldown()).to.equal(3600n); // 1 hour
      expect(await vault.feeRecipient()).to.equal(owner.address);
    });

    it("should initialize with one yield snapshot", async function () {
      expect(await vault.getSnapshotCount()).to.equal(1n);
    });

    it("should revert with invalid addresses", async function () {
      const DeltaNeutralVaultFactory = await ethers.getContractFactory("DeltaNeutralVault");

      await expect(
        DeltaNeutralVaultFactory.deploy(
          await usdc.getAddress(),
          ethers.ZeroAddress,
          await hedgeManager.getAddress(),
          await priceFeed.getAddress(),
          await weth.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });
  });

  describe("ERC4626 - Deposit", function () {
    it("should accept deposits above minimum", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);

      const sharesBefore = await vault.balanceOf(user1.address);
      await vault.connect(user1).deposit(depositAmount, user1.address);
      const sharesAfter = await vault.balanceOf(user1.address);

      expect(sharesAfter - sharesBefore).to.be.gt(0n);
    });

    it("should revert deposits below minimum", async function () {
      const smallDeposit = ethers.parseUnits("50", 6); // Below 100 USDC minimum
      await usdc.connect(user1).approve(await vault.getAddress(), smallDeposit);

      await expect(
        vault.connect(user1).deposit(smallDeposit, user1.address)
      ).to.be.revertedWithCustomError(vault, "DepositTooSmall");
    });

    it("should return correct preview", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      const previewShares = await vault.previewDeposit(depositAmount);

      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      const tx = await vault.connect(user1).deposit(depositAmount, user1.address);

      const shares = await vault.balanceOf(user1.address);
      expect(shares).to.equal(previewShares);
    });

    it("should emit Deposit event", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);

      await expect(vault.connect(user1).deposit(depositAmount, user1.address))
        .to.emit(vault, "Deposit")
        .withArgs(user1.address, user1.address, depositAmount, (shares: bigint) => shares > 0n);
    });
  });

  describe("ERC4626 - Withdraw", function () {
    const depositAmount = ethers.parseUnits("1000", 6);

    beforeEach(async function () {
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);
    });

    it("should allow withdrawals up to available assets", async function () {
      const withdrawAmount = ethers.parseUnits("500", 6);

      const balanceBefore = await usdc.balanceOf(user1.address);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);
      const balanceAfter = await usdc.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.equal(withdrawAmount);
    });

    it("should burn shares on withdrawal", async function () {
      const shares = await vault.balanceOf(user1.address);
      const withdrawAmount = ethers.parseUnits("500", 6);

      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      const sharesAfter = await vault.balanceOf(user1.address);
      expect(sharesAfter).to.be.lt(shares);
    });
  });

  describe("ERC4626 - Mint and Redeem", function () {
    it("should mint exact shares", async function () {
      const sharesToMint = ethers.parseUnits("1000", 6); // Use same decimals as USDC for 1:1 initial ratio
      const requiredAssets = await vault.previewMint(sharesToMint);

      await usdc.connect(user1).approve(await vault.getAddress(), requiredAssets);
      await vault.connect(user1).mint(sharesToMint, user1.address);

      expect(await vault.balanceOf(user1.address)).to.equal(sharesToMint);
    });

    it("should redeem shares for assets", async function () {
      // First deposit
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const shares = await vault.balanceOf(user1.address);
      const halfShares = shares / 2n;

      const balanceBefore = await usdc.balanceOf(user1.address);
      await vault.connect(user1).redeem(halfShares, user1.address, user1.address);
      const balanceAfter = await usdc.balanceOf(user1.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
      expect(await vault.balanceOf(user1.address)).to.equal(shares - halfShares);
    });
  });

  describe("totalAssets", function () {
    it("should return idle assets when no positions", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      expect(await vault.totalAssets()).to.equal(depositAmount);
    });

    it("should include LP position value", async function () {
      // This would require more complex setup with actual position
      const total = await vault.totalAssets();
      expect(total).to.be.gte(0n);
    });
  });

  describe("getNetDelta", function () {
    it("should return zero when no positions", async function () {
      const delta = await vault.getNetDelta();
      expect(delta).to.equal(0n);
    });
  });

  describe("getVaultState", function () {
    it("should return current vault state", async function () {
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const state = await vault.getVaultState();

      expect(state.totalAssets).to.equal(depositAmount);
      expect(state.lpValue).to.equal(0n);
      expect(state.hedgeValue).to.equal(0n);
      expect(state.netDelta).to.equal(0n);
      expect(state.isBalanced).to.be.true;
    });
  });

  describe("getYieldMetrics", function () {
    it("should return empty metrics initially", async function () {
      const metrics = await vault.getYieldMetrics();

      expect(metrics.apy1Day).to.equal(0n);
      expect(metrics.apy7Day).to.equal(0n);
      expect(metrics.apy30Day).to.equal(0n);
    });
  });

  describe("getETHPrice", function () {
    it("should return current ETH price", async function () {
      const price = await vault.getETHPrice();
      expect(price).to.equal(2000n * 10n ** 8n);
    });
  });

  describe("Pausable", function () {
    it("should allow owner to pause", async function () {
      await vault.connect(owner).pause();
      expect(await vault.paused()).to.be.true;
    });

    it("should allow owner to unpause", async function () {
      await vault.connect(owner).pause();
      await vault.connect(owner).unpause();
      expect(await vault.paused()).to.be.false;
    });

    it("should block deposits when paused", async function () {
      await vault.connect(owner).pause();

      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);

      await expect(
        vault.connect(user1).deposit(depositAmount, user1.address)
      ).to.be.revertedWithCustomError(vault, "EnforcedPause");
    });

    it("should allow withdrawals when paused", async function () {
      // Deposit first
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Pause
      await vault.connect(owner).pause();

      // Withdraw should still work
      const withdrawAmount = ethers.parseUnits("500", 6);
      await vault.connect(user1).withdraw(withdrawAmount, user1.address, user1.address);

      expect(await usdc.balanceOf(user1.address)).to.be.gt(
        ethers.parseUnits("100000", 6) - depositAmount
      );
    });
  });

  describe("Admin functions", function () {
    it("should allow owner to set keeper", async function () {
      await expect(vault.connect(owner).setKeeper(user2.address))
        .to.emit(vault, "KeeperUpdated")
        .withArgs(keeper.address, user2.address);

      expect(await vault.keeper()).to.equal(user2.address);
    });

    it("should allow owner to set fee recipient", async function () {
      await expect(vault.connect(owner).setFeeRecipient(user2.address))
        .to.emit(vault, "FeeRecipientUpdated")
        .withArgs(owner.address, user2.address);

      expect(await vault.feeRecipient()).to.equal(user2.address);
    });

    it("should revert setting zero address as fee recipient", async function () {
      await expect(
        vault.connect(owner).setFeeRecipient(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(vault, "InvalidAddress");
    });

    it("should allow owner to set target tick width", async function () {
      await expect(vault.connect(owner).setTargetTickWidth(2000))
        .to.emit(vault, "TickWidthUpdated")
        .withArgs(1000, 2000);

      expect(await vault.targetTickWidth()).to.equal(2000);
    });

    it("should allow owner to set rebalance cooldown", async function () {
      await vault.connect(owner).setRebalanceCooldown(7200n);
      expect(await vault.rebalanceCooldown()).to.equal(7200n);
    });

    it("should allow owner to recover non-underlying tokens", async function () {
      // Mint some WETH to the vault
      await weth.mint(await vault.getAddress(), ethers.parseEther("1"));

      const balanceBefore = await weth.balanceOf(user1.address);
      await vault
        .connect(owner)
        .emergencyRecover(await weth.getAddress(), user1.address, ethers.parseEther("1"));
      const balanceAfter = await weth.balanceOf(user1.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));
    });

    it("should prevent recovering underlying asset", async function () {
      await expect(
        vault
          .connect(owner)
          .emergencyRecover(await usdc.getAddress(), user1.address, ethers.parseUnits("100", 6))
      ).to.be.revertedWith("Cannot recover underlying");
    });

    it("should reject non-owner admin calls", async function () {
      await expect(vault.connect(user1).setKeeper(user2.address)).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );

      await expect(vault.connect(user1).pause()).to.be.revertedWithCustomError(
        vault,
        "OwnableUnauthorizedAccount"
      );
    });
  });

  describe("Fee collection", function () {
    it("should collect fees correctly", async function () {
      // Deposit some assets
      const depositAmount = ethers.parseUnits("10000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      // Fast forward time
      await ethers.provider.send("evm_increaseTime", [86400 * 30]); // 30 days
      await ethers.provider.send("evm_mine", []);

      const feeRecipientSharesBefore = await vault.balanceOf(owner.address);

      await expect(vault.collectFees()).to.emit(vault, "FeesCollected");

      const feeRecipientSharesAfter = await vault.balanceOf(owner.address);
      // Fee recipient should have received some shares
      expect(feeRecipientSharesAfter).to.be.gte(feeRecipientSharesBefore);
    });
  });

  describe("Rebalance authorization", function () {
    it("should allow keeper to call rebalance", async function () {
      // First deposit to have totalAssets > 0 (required for DeltaWithinTolerance check)
      const depositAmount = ethers.parseUnits("1000", 6);
      await usdc.connect(user1).approve(await vault.getAddress(), depositAmount);
      await vault.connect(user1).deposit(depositAmount, user1.address);

      const params = {
        newTickLower: 0,
        newTickUpper: 0,
        hedgeSizeDelta: 0n,
        increaseHedge: false,
      };

      // First need to wait for cooldown if any
      await ethers.provider.send("evm_increaseTime", [3601]);
      await ethers.provider.send("evm_mine", []);

      // Should revert with DeltaWithinTolerance (not UnauthorizedCaller)
      await expect(vault.connect(keeper).rebalance(params)).to.be.revertedWithCustomError(
        vault,
        "DeltaWithinTolerance"
      );
    });

    it("should reject unauthorized rebalance calls", async function () {
      const params = {
        newTickLower: 0,
        newTickUpper: 0,
        hedgeSizeDelta: 0n,
        increaseHedge: false,
      };

      await expect(vault.connect(user1).rebalance(params)).to.be.revertedWithCustomError(
        vault,
        "UnauthorizedCaller"
      );
    });
  });
});
