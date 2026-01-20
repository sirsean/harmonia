import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import {
  HedgeManager,
  MockERC20,
  MockExchangeRouter,
  MockDataStore,
  MockGMXPriceFeed,
} from "../../typechain-types";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";

describe("HedgeManager", function () {
  // Constants
  const PRECISION = BigInt(10) ** BigInt(18);
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);
  const USDC_DECIMALS = 6;
  const EXECUTION_FEE = ethers.parseEther("0.001");

  // Test amounts
  const INITIAL_COLLATERAL = BigInt(10_000) * BigInt(10) ** BigInt(USDC_DECIMALS); // 10,000 USDC
  const POSITION_SIZE_USD = BigInt(10_000) * GMX_USD_PRECISION; // $10,000 position
  const COLLATERAL_AMOUNT = BigInt(5_000) * BigInt(10) ** BigInt(USDC_DECIMALS); // 5,000 USDC

  // Mock ETH price: $2000
  const ETH_PRICE = BigInt(2000) * BigInt(10) ** BigInt(8); // Chainlink 8 decimals

  // Deploy fixture
  async function deployFixture() {
    const [owner, vault, user1] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const usdc = await MockERC20.deploy("USD Coin", "USDC", USDC_DECIMALS);
    const weth = await MockERC20.deploy("Wrapped Ether", "WETH", 18);
    await usdc.waitForDeployment();
    await weth.waitForDeployment();

    // Deploy mock GMX contracts
    const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
    const exchangeRouter = await MockExchangeRouter.deploy();
    await exchangeRouter.waitForDeployment();
    const mockRouterAddress = ethers.Wallet.createRandom().address;
    await exchangeRouter.setRouter(mockRouterAddress);

    // Deploy mock price feed
    const MockPriceFeed = await ethers.getContractFactory("MockGMXPriceFeed");
    const priceFeed = await MockPriceFeed.deploy(ETH_PRICE, 8);
    await priceFeed.waitForDeployment();

    // Mock market address
    const marketAddress = ethers.Wallet.createRandom().address;

    // Deploy HedgeManager
    const HedgeManager = await ethers.getContractFactory("HedgeManager");
    const hedgeManager = await upgrades.deployProxy(
      HedgeManager,
      [
        await exchangeRouter.getAddress(),
        marketAddress,
        await usdc.getAddress(),
        await weth.getAddress(),
        await priceFeed.getAddress(),
        owner.address,
      ],
      { kind: "uups" }
    );
    await hedgeManager.waitForDeployment();

    // Set vault
    await hedgeManager.connect(owner).setVault(vault.address);

    // Set Order Vault (mock address)
    const orderVaultAddress = ethers.Wallet.createRandom().address;
    await hedgeManager.connect(owner).setOrderVault(orderVaultAddress);

    // Mint USDC to vault
    await usdc.mint(vault.address, INITIAL_COLLATERAL);

    // Approve HedgeManager to spend vault's USDC
    await usdc.connect(vault).approve(await hedgeManager.getAddress(), ethers.MaxUint256);

    // Get DataStore address from exchange router
    const dataStoreAddress = await exchangeRouter.dataStore();
    const dataStore = await ethers.getContractAt("MockDataStore", dataStoreAddress);

    return {
      hedgeManager,
      exchangeRouter,
      dataStore,
      priceFeed,
      usdc,
      weth,
      owner,
      vault,
      user1,
      marketAddress,
      mockRouterAddress,
    };
  }

  describe("Deployment", function () {
    it("should deploy with correct parameters", async function () {
      const { hedgeManager, exchangeRouter, usdc, weth, priceFeed, owner, marketAddress } =
        await loadFixture(deployFixture);

      expect(await hedgeManager.exchangeRouter()).to.equal(await exchangeRouter.getAddress());
      expect(await hedgeManager.market()).to.equal(marketAddress);
      expect(await hedgeManager.collateralToken()).to.equal(await usdc.getAddress());
      expect(await hedgeManager.indexToken()).to.equal(await weth.getAddress());
      expect(await hedgeManager.priceFeed()).to.equal(await priceFeed.getAddress());
      expect(await hedgeManager.owner()).to.equal(owner.address);
    });

    it("should have correct constants", async function () {
      const { hedgeManager } = await loadFixture(deployFixture);

      expect(await hedgeManager.PRECISION()).to.equal(PRECISION);
      expect(await hedgeManager.GMX_USD_PRECISION()).to.equal(GMX_USD_PRECISION);
      expect(await hedgeManager.maxLeverage()).to.equal(3n * PRECISION); // 3x
      expect(await hedgeManager.minPositionSize()).to.equal(100n * GMX_USD_PRECISION); // $100
      expect(await hedgeManager.DEFAULT_SLIPPAGE()).to.equal(BigInt(1e16)); // 1%
    });

    it("should revert on zero addresses", async function () {
      const { exchangeRouter, usdc, weth, priceFeed, owner, marketAddress } =
        await loadFixture(deployFixture);
      const HedgeManager = await ethers.getContractFactory("HedgeManager");

      // Zero exchange router
      await expect(
        upgrades.deployProxy(
          HedgeManager,
          [
            ethers.ZeroAddress,
            marketAddress,
            await usdc.getAddress(),
            await weth.getAddress(),
            await priceFeed.getAddress(),
            owner.address,
          ],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(HedgeManager, "ZeroAddress");

      // Zero market
      await expect(
        upgrades.deployProxy(
          HedgeManager,
          [
            await exchangeRouter.getAddress(),
            ethers.ZeroAddress,
            await usdc.getAddress(),
            await weth.getAddress(),
            await priceFeed.getAddress(),
            owner.address,
          ],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(HedgeManager, "ZeroAddress");

      // Zero collateral token
      await expect(
        upgrades.deployProxy(
          HedgeManager,
          [
            await exchangeRouter.getAddress(),
            marketAddress,
            ethers.ZeroAddress,
            await weth.getAddress(),
            await priceFeed.getAddress(),
            owner.address,
          ],
          { kind: "uups" }
        )
      ).to.be.revertedWithCustomError(HedgeManager, "ZeroAddress");
    });

    it("should initialize with no position", async function () {
      const { hedgeManager } = await loadFixture(deployFixture);

      expect(await hedgeManager.hasPosition()).to.be.false;
      expect(await hedgeManager.getPositionSizeUsd()).to.equal(0n);
      expect(await hedgeManager.getCollateralAmount()).to.equal(0n);
    });
  });

  describe("Vault Management", function () {
    it("should allow owner to set vault", async function () {
      const { hedgeManager, owner, user1 } = await loadFixture(deployFixture);

      await hedgeManager.connect(owner).setVault(user1.address);
      expect(await hedgeManager.vault()).to.equal(user1.address);
    });

    it("should emit VaultUpdated event", async function () {
      const { hedgeManager, owner, vault, user1 } = await loadFixture(deployFixture);

      await expect(hedgeManager.connect(owner).setVault(user1.address))
        .to.emit(hedgeManager, "VaultUpdated")
        .withArgs(vault.address, user1.address);
    });

    it("should reject non-owner setting vault", async function () {
      const { hedgeManager, user1 } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(user1).setVault(user1.address)
      ).to.be.revertedWithCustomError(hedgeManager, "OwnableUnauthorizedAccount");
    });

    it("should reject zero address vault", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(owner).setVault(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(hedgeManager, "ZeroAddress");
    });
  });

  describe("Exchange Router Management", function () {
    it("should allow owner to set exchange router", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);
      const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
      const newRouter = await MockExchangeRouter.deploy();
      await newRouter.waitForDeployment();

      await hedgeManager.connect(owner).setExchangeRouter(await newRouter.getAddress());
      expect(await hedgeManager.exchangeRouter()).to.equal(await newRouter.getAddress());
    });

    it("should emit ExchangeRouterUpdated event", async function () {
      const { hedgeManager, owner, exchangeRouter } = await loadFixture(deployFixture);
      const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
      const newRouter = await MockExchangeRouter.deploy();
      await newRouter.waitForDeployment();

      await expect(hedgeManager.connect(owner).setExchangeRouter(await newRouter.getAddress()))
        .to.emit(hedgeManager, "ExchangeRouterUpdated")
        .withArgs(await exchangeRouter.getAddress(), await newRouter.getAddress());
    });

    it("should reject non-owner setting exchange router", async function () {
      const { hedgeManager, user1 } = await loadFixture(deployFixture);
      const MockExchangeRouter = await ethers.getContractFactory("MockExchangeRouter");
      const newRouter = await MockExchangeRouter.deploy();
      await newRouter.waitForDeployment();

      await expect(
        hedgeManager.connect(user1).setExchangeRouter(await newRouter.getAddress())
      ).to.be.revertedWithCustomError(hedgeManager, "OwnableUnauthorizedAccount");
    });

    it("should reject zero address exchange router", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(owner).setExchangeRouter(ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(hedgeManager, "ZeroAddress");
    });
  });

  describe("Slippage Management", function () {
    it("should allow owner to set slippage tolerance", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      const newSlippage = BigInt(2e16); // 2%
      await hedgeManager.connect(owner).setSlippageTolerance(newSlippage);
      expect(await hedgeManager.slippageTolerance()).to.equal(newSlippage);
    });

    it("should emit SlippageToleranceUpdated event", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      const defaultSlippage = BigInt(1e16); // 1%
      const newSlippage = BigInt(2e16); // 2%

      await expect(hedgeManager.connect(owner).setSlippageTolerance(newSlippage))
        .to.emit(hedgeManager, "SlippageToleranceUpdated")
        .withArgs(defaultSlippage, newSlippage);
    });

    it("should reject slippage above maximum (5%)", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      const tooHighSlippage = BigInt(6e16); // 6% > 5%
      await expect(
        hedgeManager.connect(owner).setSlippageTolerance(tooHighSlippage)
      ).to.be.revertedWithCustomError(hedgeManager, "SlippageTooHigh");
    });
  });

  describe("Execution Fee Management", function () {
    it("should allow owner to set execution fee override", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      const newFee = ethers.parseEther("0.002");
      await hedgeManager.connect(owner).setExecutionFeeOverride(newFee);
      expect(await hedgeManager.getExecutionFee()).to.equal(newFee);
    });

    it("should emit ExecutionFeeUpdated event", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      const newFee = ethers.parseEther("0.002");

      await expect(hedgeManager.connect(owner).setExecutionFeeOverride(newFee))
        .to.emit(hedgeManager, "ExecutionFeeUpdated")
        .withArgs(0n, newFee);
    });

    it("should use default fee when override is 0", async function () {
      const { hedgeManager } = await loadFixture(deployFixture);

      expect(await hedgeManager.getExecutionFee()).to.equal(EXECUTION_FEE);
    });
  });

  describe("Open Short Position", function () {
    it("should open a new short position", async function () {
      const { hedgeManager, vault, exchangeRouter, marketAddress, usdc } =
        await loadFixture(deployFixture);

      const tx = await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      await tx.wait();

      // Check that an order was created (mock auto-executes)
      expect(await hedgeManager.lastOrderKey()).to.not.equal(ethers.ZeroHash);
    });

    it("should emit ShortOpened event", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager
          .connect(vault)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "ShortOpened");
    });

    it("should transfer collateral from caller", async function () {
      const { hedgeManager, vault, usdc } = await loadFixture(deployFixture);

      const balanceBefore = await usdc.balanceOf(vault.address);

      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      const balanceAfter = await usdc.balanceOf(vault.address);
      expect(balanceBefore - balanceAfter).to.equal(COLLATERAL_AMOUNT);
    });

    it("should update total collateral deposited", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      expect(await hedgeManager.totalCollateralDeposited()).to.equal(COLLATERAL_AMOUNT);
    });

    it("should approve the underlying router for collateral", async function () {
      const { hedgeManager, vault, usdc, mockRouterAddress } = await loadFixture(deployFixture);

      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      const allowance = await usdc.allowance(await hedgeManager.getAddress(), mockRouterAddress);
      expect(allowance).to.equal(COLLATERAL_AMOUNT);
    });

    it("should reject if position already exists", async function () {
      const { hedgeManager, vault, exchangeRouter, marketAddress, usdc, dataStore } =
        await loadFixture(deployFixture);

      // First open a position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);

      // Try to open another position
      await expect(
        hedgeManager
          .connect(vault)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "PositionExists");
    });

    it("should reject position size below minimum ($100)", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      const tooSmallSize = BigInt(50) * GMX_USD_PRECISION; // $50 < $100 minimum

      await expect(
        hedgeManager
          .connect(vault)
          .openShort(tooSmallSize, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "PositionTooSmall");
    });

    it("should reject zero collateral", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(vault).openShort(POSITION_SIZE_USD, 0n, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "ZeroAmount");
    });

    it("should reject if leverage exceeds maximum (3x)", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      // Position size = $10,000, collateral = $1,000 => 10x leverage
      const highLeverageSize = BigInt(10_000) * GMX_USD_PRECISION;
      const lowCollateral = BigInt(1_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await expect(
        hedgeManager
          .connect(vault)
          .openShort(highLeverageSize, lowCollateral, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "LeverageTooHigh");
    });

    it("should reject insufficient execution fee", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(vault).openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: 0n })
      ).to.be.revertedWithCustomError(hedgeManager, "InsufficientExecutionFee");
    });

    it("should reject non-vault caller", async function () {
      const { hedgeManager, user1 } = await loadFixture(deployFixture);

      await expect(
        hedgeManager
          .connect(user1)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");
    });

    it("should allow owner to open position", async function () {
      const { hedgeManager, owner, usdc } = await loadFixture(deployFixture);

      // Mint USDC to owner and approve
      await usdc.mint(owner.address, INITIAL_COLLATERAL);
      await usdc.connect(owner).approve(await hedgeManager.getAddress(), ethers.MaxUint256);

      await expect(
        hedgeManager
          .connect(owner)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.not.be.reverted;
    });
  });

  describe("Increase Short Position", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      return fixtures;
    }

    it("should increase position size", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      const additionalSize = BigInt(5_000) * GMX_USD_PRECISION;
      const additionalCollateral = BigInt(2_500) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await expect(
        hedgeManager
          .connect(vault)
          .increaseShort(additionalSize, additionalCollateral, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "ShortIncreased");
    });

    it("should reject if no position exists", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager
          .connect(vault)
          .increaseShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "NoPosition");
    });

    it("should reject zero amounts", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      await expect(
        hedgeManager.connect(vault).increaseShort(0n, 0n, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "ZeroAmount");
    });
  });

  describe("Decrease Short Position", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      return fixtures;
    }

    it("should decrease position size", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      const decreaseSize = BigInt(3_000) * GMX_USD_PRECISION;

      await expect(
        hedgeManager.connect(vault).decreaseShort(decreaseSize, 0n, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "ShortDecreased");
    });

    it("should cap decrease at current position size", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      // Try to decrease more than position size
      const largeDecreaseSize = BigInt(20_000) * GMX_USD_PRECISION;

      await expect(
        hedgeManager.connect(vault).decreaseShort(largeDecreaseSize, 0n, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "ShortDecreased");
    });

    it("should reject if no position exists", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(vault).decreaseShort(POSITION_SIZE_USD, 0n, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "NoPosition");
    });
  });

  describe("Close Short Position", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      return fixtures;
    }

    it("should close entire position", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      await expect(hedgeManager.connect(vault).closeShort({ value: EXECUTION_FEE })).to.emit(
        hedgeManager,
        "ShortClosed"
      );
    });

    it("should reject if no position exists", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager.connect(vault).closeShort({ value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "NoPosition");
    });
  });

  describe("Adjust Hedge", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      return fixtures;
    }

    it("should increase hedge to target", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      const targetDelta = BigInt(15_000) * GMX_USD_PRECISION; // Increase from $10k to $15k

      await expect(
        hedgeManager.connect(vault).adjustHedge(targetDelta, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "HedgeAdjusted");
    });

    it("should decrease hedge to target", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      const targetDelta = BigInt(5_000) * GMX_USD_PRECISION; // Decrease from $10k to $5k

      await expect(
        hedgeManager.connect(vault).adjustHedge(targetDelta, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "HedgeAdjusted");
    });

    it("should close position when target is zero", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      await expect(hedgeManager.connect(vault).adjustHedge(0n, { value: EXECUTION_FEE }))
        .to.emit(hedgeManager, "HedgeAdjusted")
        .and.to.emit(hedgeManager, "ShortClosed");
    });

    it("should open new position if none exists", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      const targetDelta = BigInt(5_000) * GMX_USD_PRECISION;

      await expect(
        hedgeManager.connect(vault).adjustHedge(targetDelta, { value: EXECUTION_FEE })
      ).to.emit(hedgeManager, "ShortOpened");
    });

    it("should reject opening position below minimum", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      const smallTarget = BigInt(50) * GMX_USD_PRECISION; // $50 < $100 minimum

      await expect(
        hedgeManager.connect(vault).adjustHedge(smallTarget, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "PositionTooSmall");
    });
  });

  describe("Claim Funding", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      await dataStore.setUint(sizeKey, POSITION_SIZE_USD);

      return fixtures;
    }

    it("should claim funding fees", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      await expect(hedgeManager.connect(vault).claimFunding()).to.emit(
        hedgeManager,
        "FundingClaimed"
      );
    });

    it("should update total funding received", async function () {
      const { hedgeManager, vault } = await openPositionFixture();

      await hedgeManager.connect(vault).claimFunding();

      // Mock returns 0, so total should still be 0
      expect(await hedgeManager.totalFundingReceived()).to.equal(0n);
    });
  });

  describe("View Functions", function () {
    async function openPositionFixture() {
      const fixtures = await loadFixture(deployFixture);
      const { hedgeManager, vault, dataStore } = fixtures;

      // Open initial position
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in mock data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeUsdKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const sizeTokensKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "sizeInTokens"]
        )
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );

      await dataStore.setUint(sizeUsdKey, POSITION_SIZE_USD);
      // Size in tokens = $10,000 / $2000 = 5 ETH = 5e18
      await dataStore.setUint(sizeTokensKey, ethers.parseEther("5"));
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      return fixtures;
    }

    it("should return position size in USD", async function () {
      const { hedgeManager } = await openPositionFixture();

      expect(await hedgeManager.getPositionSizeUsd()).to.equal(POSITION_SIZE_USD);
    });

    it("should return position size in tokens", async function () {
      const { hedgeManager } = await openPositionFixture();

      expect(await hedgeManager.getPositionSizeTokens()).to.equal(ethers.parseEther("5"));
    });

    it("should return collateral amount", async function () {
      const { hedgeManager } = await openPositionFixture();

      expect(await hedgeManager.getCollateralAmount()).to.equal(COLLATERAL_AMOUNT);
    });

    it("should return position value", async function () {
      const { hedgeManager } = await openPositionFixture();

      const value = await hedgeManager.getPositionValue();
      // With no PnL, value should equal collateral
      expect(value).to.be.gte(COLLATERAL_AMOUNT - BigInt(1e6)); // Allow for precision loss
    });

    it("should return negative delta for short position", async function () {
      const { hedgeManager } = await openPositionFixture();

      const delta = await hedgeManager.getPositionDelta();
      expect(delta).to.be.lt(0n); // Short position has negative delta
    });

    it("should return current leverage", async function () {
      const { hedgeManager } = await openPositionFixture();

      const leverage = await hedgeManager.getCurrentLeverage();
      // $10,000 / $5,000 = 2x leverage
      expect(leverage).to.be.gte(PRECISION * 2n - BigInt(1e17)); // ~2x with tolerance
      expect(leverage).to.be.lte(PRECISION * 2n + BigInt(1e17));
    });

    it("should return true for hasPosition when position exists", async function () {
      const { hedgeManager } = await openPositionFixture();

      expect(await hedgeManager.hasPosition()).to.be.true;
    });

    it("should return position key", async function () {
      const { hedgeManager } = await loadFixture(deployFixture);

      const key = await hedgeManager.getPositionKey();
      expect(key).to.not.equal(ethers.ZeroHash);
    });

    it("should return execution fee", async function () {
      const { hedgeManager } = await loadFixture(deployFixture);

      expect(await hedgeManager.getExecutionFee()).to.equal(EXECUTION_FEE);
    });
  });

  describe("Access Control", function () {
    it("should allow vault to call protected functions", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      await expect(
        hedgeManager
          .connect(vault)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.not.be.reverted;
    });

    it("should allow owner to call protected functions", async function () {
      const { hedgeManager, owner, usdc } = await loadFixture(deployFixture);

      // Mint USDC to owner and approve
      await usdc.mint(owner.address, INITIAL_COLLATERAL);
      await usdc.connect(owner).approve(await hedgeManager.getAddress(), ethers.MaxUint256);

      await expect(
        hedgeManager
          .connect(owner)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.not.be.reverted;
    });

    it("should reject unauthorized users from protected functions", async function () {
      const { hedgeManager, user1 } = await loadFixture(deployFixture);

      await expect(
        hedgeManager
          .connect(user1)
          .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");

      await expect(
        hedgeManager
          .connect(user1)
          .increaseShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");

      await expect(
        hedgeManager.connect(user1).decreaseShort(POSITION_SIZE_USD, 0n, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");

      await expect(
        hedgeManager.connect(user1).closeShort({ value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");

      await expect(
        hedgeManager.connect(user1).adjustHedge(POSITION_SIZE_USD, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "OnlyVault");

      await expect(hedgeManager.connect(user1).claimFunding()).to.be.revertedWithCustomError(
        hedgeManager,
        "OnlyVault"
      );
    });
  });

  describe("ETH Handling", function () {
    it("should refund excess execution fee", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      const excessFee = ethers.parseEther("0.01"); // 10x execution fee
      const balanceBefore = await ethers.provider.getBalance(vault.address);

      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: excessFee });

      const balanceAfter = await ethers.provider.getBalance(vault.address);

      // Account for gas costs - should have been refunded ~0.009 ETH
      const spent = balanceBefore - balanceAfter;
      expect(spent).to.be.lt(excessFee); // Should be less than sent due to refund
    });

    it("should accept ETH via receive function", async function () {
      const { hedgeManager, owner } = await loadFixture(deployFixture);

      // Send ETH directly to contract
      await expect(
        owner.sendTransaction({
          to: await hedgeManager.getAddress(),
          value: ethers.parseEther("0.1"),
        })
      ).to.not.be.reverted;
    });
  });

  describe("Integration with Vault", function () {
    it("should work with DeltaNeutralVault contract", async function () {
      const { hedgeManager, usdc, owner, priceFeed, exchangeRouter, marketAddress, weth } =
        await loadFixture(deployFixture);

      // Deploy actual vault
      const DeltaNeutralVault = await ethers.getContractFactory("DeltaNeutralVault");
      const actualVault = await upgrades.deployProxy(
        DeltaNeutralVault,
        [await usdc.getAddress(), "Harmonia Delta Neutral", "hdnUSDC", owner.address],
        { kind: "uups" }
      );
      await actualVault.waitForDeployment();

      // Set managers
      await actualVault
        .connect(owner)
        .setManagers(ethers.ZeroAddress, await hedgeManager.getAddress(), ethers.ZeroAddress);

      // Update hedge manager's vault
      await hedgeManager.connect(owner).setVault(await actualVault.getAddress());

      // Vault should be set correctly
      expect(await hedgeManager.vault()).to.equal(await actualVault.getAddress());
    });
  });

  describe("Edge Cases", function () {
    it("should handle maximum leverage boundary", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      // 3x leverage is the maximum
      // $15,000 position with $5,000 collateral = 3x
      const maxLeverageSize = BigInt(15_000) * GMX_USD_PRECISION;
      const collateral = BigInt(5_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await expect(
        hedgeManager.connect(vault).openShort(maxLeverageSize, collateral, { value: EXECUTION_FEE })
      ).to.not.be.reverted;
    });

    it("should reject leverage just above maximum", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      // Just over 3x leverage
      const overMaxSize = BigInt(15_001) * GMX_USD_PRECISION;
      const collateral = BigInt(5_000) * BigInt(10) ** BigInt(USDC_DECIMALS);

      await expect(
        hedgeManager.connect(vault).openShort(overMaxSize, collateral, { value: EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "LeverageTooHigh");
    });

    it("should handle minimum position size boundary", async function () {
      const { hedgeManager, vault } = await loadFixture(deployFixture);

      // Exactly $100 (minimum)
      const minSize = BigInt(100) * GMX_USD_PRECISION;
      const collateral = BigInt(50) * BigInt(10) ** BigInt(USDC_DECIMALS); // 2x leverage

      await expect(
        hedgeManager.connect(vault).openShort(minSize, collateral, { value: EXECUTION_FEE })
      ).to.not.be.reverted;
    });

    it("should handle price changes in PnL calculation", async function () {
      const { hedgeManager, vault, dataStore, priceFeed } = await loadFixture(deployFixture);

      // Open position at $2000
      await hedgeManager
        .connect(vault)
        .openShort(POSITION_SIZE_USD, COLLATERAL_AMOUNT, { value: EXECUTION_FEE });

      // Set position in data store
      const positionKey = await hedgeManager.getPositionKey();
      const sizeUsdKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(["bytes32", "string"], [positionKey, "sizeInUsd"])
      );
      const sizeTokensKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "sizeInTokens"]
        )
      );
      const collateralKey = ethers.keccak256(
        ethers.AbiCoder.defaultAbiCoder().encode(
          ["bytes32", "string"],
          [positionKey, "collateralAmount"]
        )
      );

      await dataStore.setUint(sizeUsdKey, POSITION_SIZE_USD);
      await dataStore.setUint(sizeTokensKey, ethers.parseEther("5")); // 5 ETH
      await dataStore.setUint(collateralKey, COLLATERAL_AMOUNT);

      // Change price to $1800 (should be profit for short)
      const newPrice = BigInt(1800) * BigInt(10) ** BigInt(8);
      await priceFeed.setPrice(newPrice);

      const pnl = await hedgeManager.getUnrealizedPnL();
      // Price dropped, short should be in profit
      expect(pnl).to.be.gt(0n);
    });
  });
});
