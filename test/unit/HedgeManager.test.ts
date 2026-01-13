import { expect } from "chai";
import { ethers } from "hardhat";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import {
  HedgeManager,
  MockERC20,
  MockExchangeRouter,
  MockOrderVault,
  MockDataStore,
  MockReader,
  MockChainlinkAggregator,
} from "../../typechain-types";

describe("HedgeManager", function () {
  let hedgeManager: HedgeManager;
  let usdc: MockERC20;
  let weth: MockERC20;
  let exchangeRouter: MockExchangeRouter;
  let orderVault: MockOrderVault;
  let dataStore: MockDataStore;
  let reader: MockReader;
  let priceFeed: MockChainlinkAggregator;
  let owner: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let user: HardhatEthersSigner;

  const PRECISION = BigInt(10) ** BigInt(18);
  const GMX_USD_PRECISION = BigInt(10) ** BigInt(30);
  const MARKET_ADDRESS = "0x70d95587d40A2caf56bd97485aB3Eec10Bee6336";
  const MIN_EXECUTION_FEE = ethers.parseEther("0.001");

  beforeEach(async function () {
    [owner, vault, user] = await ethers.getSigners();

    // Deploy mock tokens
    const MockERC20Factory = await ethers.getContractFactory("MockERC20");
    usdc = await MockERC20Factory.deploy("USD Coin", "USDC", 6);
    weth = await MockERC20Factory.deploy("Wrapped Ether", "WETH", 18);

    // Deploy GMX mocks
    const MockDataStoreFactory = await ethers.getContractFactory("MockDataStore");
    dataStore = await MockDataStoreFactory.deploy();

    const MockOrderVaultFactory = await ethers.getContractFactory("MockOrderVault");
    orderVault = await MockOrderVaultFactory.deploy();

    const MockExchangeRouterFactory = await ethers.getContractFactory("MockExchangeRouter");
    exchangeRouter = await MockExchangeRouterFactory.deploy(
      await dataStore.getAddress(),
      await orderVault.getAddress()
    );

    const MockReaderFactory = await ethers.getContractFactory("MockReader");
    reader = await MockReaderFactory.deploy();

    // Deploy mock Chainlink
    const MockChainlinkFactory = await ethers.getContractFactory("MockChainlinkAggregator");
    priceFeed = await MockChainlinkFactory.deploy(8, "ETH / USD");

    // Deploy HedgeManager
    const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");
    hedgeManager = await HedgeManagerFactory.deploy(
      await exchangeRouter.getAddress(),
      await reader.getAddress(),
      await priceFeed.getAddress(),
      MARKET_ADDRESS,
      await usdc.getAddress(),
      await weth.getAddress(),
      owner.address
    );

    // Set vault
    await hedgeManager.setVault(vault.address);

    // Mint tokens
    await usdc.mint(owner.address, ethers.parseUnits("1000000", 6));
    await usdc.mint(vault.address, ethers.parseUnits("1000000", 6));
    await usdc.mint(await orderVault.getAddress(), ethers.parseUnits("1000000", 6));
  });

  describe("Constructor", function () {
    it("should set immutable addresses correctly", async function () {
      expect(await hedgeManager.exchangeRouter()).to.equal(await exchangeRouter.getAddress());
      expect(await hedgeManager.reader()).to.equal(await reader.getAddress());
      expect(await hedgeManager.priceFeed()).to.equal(await priceFeed.getAddress());
      expect(await hedgeManager.market()).to.equal(MARKET_ADDRESS);
      expect(await hedgeManager.collateralToken()).to.equal(await usdc.getAddress());
      expect(await hedgeManager.indexToken()).to.equal(await weth.getAddress());
    });

    it("should set default values", async function () {
      expect(await hedgeManager.acceptableSlippage()).to.equal(BigInt(5e15)); // 0.5%
      expect(await hedgeManager.callbackGasLimit()).to.equal(1_000_000n);
    });

    it("should derive dataStore and orderVault from exchangeRouter", async function () {
      expect(await hedgeManager.dataStore()).to.equal(await dataStore.getAddress());
      expect(await hedgeManager.orderVault()).to.equal(await orderVault.getAddress());
    });

    it("should revert with invalid addresses", async function () {
      const HedgeManagerFactory = await ethers.getContractFactory("HedgeManager");

      await expect(
        HedgeManagerFactory.deploy(
          ethers.ZeroAddress,
          await reader.getAddress(),
          await priceFeed.getAddress(),
          MARKET_ADDRESS,
          await usdc.getAddress(),
          await weth.getAddress(),
          owner.address
        )
      ).to.be.revertedWithCustomError(hedgeManager, "InvalidAddress");
    });
  });

  describe("openHedge", function () {
    const sizeUsd = 10000n * GMX_USD_PRECISION; // $10,000 position
    const collateralAmount = ethers.parseUnits("5000", 6); // 5000 USDC

    beforeEach(async function () {
      await usdc.connect(vault).approve(await hedgeManager.getAddress(), collateralAmount);
    });

    it("should open a hedge position successfully", async function () {
      await expect(
        hedgeManager.connect(vault).openHedge(sizeUsd, collateralAmount, {
          value: MIN_EXECUTION_FEE,
        })
      )
        .to.emit(hedgeManager, "HedgeOpened")
        .withArgs(
          (orderKey: string) => orderKey.length > 0,
          sizeUsd,
          collateralAmount,
          (price: bigint) => price > 0n
        );

      expect(await hedgeManager.targetHedgeSizeUsd()).to.equal(sizeUsd);
      expect(await hedgeManager.hasPendingOrder()).to.be.true;
    });

    it("should revert with zero size", async function () {
      await expect(
        hedgeManager.connect(vault).openHedge(0n, collateralAmount, {
          value: MIN_EXECUTION_FEE,
        })
      ).to.be.revertedWithCustomError(hedgeManager, "InvalidSize");
    });

    it("should revert with insufficient execution fee", async function () {
      await expect(
        hedgeManager.connect(vault).openHedge(sizeUsd, collateralAmount, {
          value: MIN_EXECUTION_FEE - 1n,
        })
      ).to.be.revertedWithCustomError(hedgeManager, "InsufficientExecutionFee");
    });

    it("should revert if called by unauthorized address", async function () {
      await expect(
        hedgeManager.connect(user).openHedge(sizeUsd, collateralAmount, {
          value: MIN_EXECUTION_FEE,
        })
      ).to.be.revertedWithCustomError(hedgeManager, "UnauthorizedCaller");
    });

    it("should revert if order is pending", async function () {
      await hedgeManager.connect(vault).openHedge(sizeUsd, collateralAmount, {
        value: MIN_EXECUTION_FEE,
      });

      await usdc.connect(vault).approve(await hedgeManager.getAddress(), collateralAmount);

      await expect(
        hedgeManager.connect(vault).openHedge(sizeUsd, collateralAmount, {
          value: MIN_EXECUTION_FEE,
        })
      ).to.be.revertedWithCustomError(hedgeManager, "OrderPending");
    });
  });

  describe("increaseHedge", function () {
    const initialSize = 10000n * GMX_USD_PRECISION;
    const initialCollateral = ethers.parseUnits("5000", 6);
    const additionalSize = 5000n * GMX_USD_PRECISION;

    beforeEach(async function () {
      await usdc.connect(vault).approve(await hedgeManager.getAddress(), initialCollateral);
      await hedgeManager.connect(vault).openHedge(initialSize, initialCollateral, {
        value: MIN_EXECUTION_FEE,
      });

      // Clear pending order
      await hedgeManager.connect(vault).clearPendingOrder();
    });

    it("should increase hedge position", async function () {
      await expect(
        hedgeManager.connect(vault).increaseHedge(additionalSize, 0n, {
          value: MIN_EXECUTION_FEE,
        })
      )
        .to.emit(hedgeManager, "HedgeIncreased")
        .withArgs((orderKey: string) => orderKey.length > 0, additionalSize, 0n);

      expect(await hedgeManager.targetHedgeSizeUsd()).to.equal(initialSize + additionalSize);
    });

    it("should revert with zero delta", async function () {
      await expect(
        hedgeManager.connect(vault).increaseHedge(0n, 0n, { value: MIN_EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "InvalidSize");
    });
  });

  describe("decreaseHedge", function () {
    const initialSize = 10000n * GMX_USD_PRECISION;
    const initialCollateral = ethers.parseUnits("5000", 6);
    const decreaseSize = 3000n * GMX_USD_PRECISION;

    beforeEach(async function () {
      await usdc.connect(vault).approve(await hedgeManager.getAddress(), initialCollateral);
      await hedgeManager.connect(vault).openHedge(initialSize, initialCollateral, {
        value: MIN_EXECUTION_FEE,
      });

      // Clear pending order
      await hedgeManager.connect(vault).clearPendingOrder();
    });

    it("should decrease hedge position", async function () {
      await expect(
        hedgeManager.connect(vault).decreaseHedge(decreaseSize, 0n, {
          value: MIN_EXECUTION_FEE,
        })
      )
        .to.emit(hedgeManager, "HedgeDecreased")
        .withArgs((orderKey: string) => orderKey.length > 0, decreaseSize, 0n);

      expect(await hedgeManager.targetHedgeSizeUsd()).to.equal(initialSize - decreaseSize);
    });
  });

  describe("closeHedge", function () {
    const initialSize = 10000n * GMX_USD_PRECISION;
    const initialCollateral = ethers.parseUnits("5000", 6);

    beforeEach(async function () {
      await usdc.connect(vault).approve(await hedgeManager.getAddress(), initialCollateral);
      await hedgeManager.connect(vault).openHedge(initialSize, initialCollateral, {
        value: MIN_EXECUTION_FEE,
      });

      // Clear pending order and set mock position
      await hedgeManager.connect(vault).clearPendingOrder();

      const positionKey = await hedgeManager.getPositionKey();
      await reader.setMockPosition(positionKey, initialSize, initialCollateral, 0);
    });

    it("should close entire hedge position", async function () {
      await expect(hedgeManager.connect(vault).closeHedge({ value: MIN_EXECUTION_FEE }))
        .to.emit(hedgeManager, "HedgeClosed")
        .withArgs((orderKey: string) => orderKey.length > 0, initialSize);

      expect(await hedgeManager.targetHedgeSizeUsd()).to.equal(0n);
    });

    it("should revert if no active position", async function () {
      // Close position first by resetting mock
      const positionKey = await hedgeManager.getPositionKey();
      await reader.setMockPosition(positionKey, 0n, 0n, 0);

      await expect(
        hedgeManager.connect(vault).closeHedge({ value: MIN_EXECUTION_FEE })
      ).to.be.revertedWithCustomError(hedgeManager, "NoActivePosition");
    });
  });

  describe("cancelPendingOrder", function () {
    it("should cancel a pending order", async function () {
      const sizeUsd = 10000n * GMX_USD_PRECISION;
      const collateral = ethers.parseUnits("5000", 6);

      await usdc.connect(vault).approve(await hedgeManager.getAddress(), collateral);
      await hedgeManager.connect(vault).openHedge(sizeUsd, collateral, {
        value: MIN_EXECUTION_FEE,
      });

      expect(await hedgeManager.hasPendingOrder()).to.be.true;

      await expect(hedgeManager.connect(vault).cancelPendingOrder({ value: 0 })).to.emit(
        hedgeManager,
        "OrderCancelled"
      );

      expect(await hedgeManager.hasPendingOrder()).to.be.false;
    });

    it("should do nothing if no pending order", async function () {
      await hedgeManager.connect(vault).cancelPendingOrder({ value: 0 });
      expect(await hedgeManager.hasPendingOrder()).to.be.false;
    });
  });

  describe("View functions", function () {
    const sizeUsd = 10000n * GMX_USD_PRECISION;
    const collateral = ethers.parseUnits("5000", 6);

    beforeEach(async function () {
      await usdc.connect(vault).approve(await hedgeManager.getAddress(), collateral);
      await hedgeManager.connect(vault).openHedge(sizeUsd, collateral, {
        value: MIN_EXECUTION_FEE,
      });
      await hedgeManager.connect(vault).clearPendingOrder();

      const positionKey = await hedgeManager.getPositionKey();
      await reader.setMockPosition(positionKey, sizeUsd, collateral, 100n);
    });

    it("should return hedge position info", async function () {
      const position = await hedgeManager.getHedgePosition();
      expect(position.sizeUsd).to.equal(sizeUsd);
      expect(position.collateralAmount).to.equal(collateral);
      expect(position.isActive).to.be.true;
    });

    it("should return position size in USD", async function () {
      const size = await hedgeManager.getPositionSizeUsd();
      expect(size).to.equal(sizeUsd);
    });

    it("should return position delta (negative for short)", async function () {
      const delta = await hedgeManager.getPositionDelta();
      expect(delta).to.be.lt(0n); // Negative for short
    });

    it("should return oracle price", async function () {
      const price = await hedgeManager.getOraclePrice();
      expect(price).to.equal(2000n * 10n ** 8n); // $2000
    });

    it("should return position leverage", async function () {
      const leverage = await hedgeManager.getPositionLeverage();
      // $10,000 position / $5,000 collateral = 2x leverage
      expect(leverage).to.be.closeTo(2n * PRECISION, PRECISION / 10n);
    });

    it("should return position key", async function () {
      const key = await hedgeManager.getPositionKey();
      expect(key).to.not.equal(ethers.ZeroHash);
    });
  });

  describe("Oracle price validation", function () {
    it("should revert with stale price", async function () {
      // Set price to be stale (2 hours old)
      await priceFeed.setStalePrice(2000n * 10n ** 8n, 7200);

      await expect(hedgeManager.getOraclePrice()).to.be.revertedWithCustomError(
        hedgeManager,
        "PriceStale"
      );
    });

    it("should revert with zero/negative price", async function () {
      await priceFeed.setPrice(0);

      await expect(hedgeManager.getOraclePrice()).to.be.revertedWithCustomError(
        hedgeManager,
        "PriceStale"
      );
    });
  });

  describe("Admin functions", function () {
    it("should allow owner to set vault", async function () {
      await expect(hedgeManager.connect(owner).setVault(user.address))
        .to.emit(hedgeManager, "VaultUpdated")
        .withArgs(vault.address, user.address);

      expect(await hedgeManager.vault()).to.equal(user.address);
    });

    it("should allow owner to set acceptable slippage", async function () {
      const newSlippage = BigInt(1e16); // 1%

      await expect(hedgeManager.connect(owner).setAcceptableSlippage(newSlippage))
        .to.emit(hedgeManager, "SlippageUpdated")
        .withArgs(BigInt(5e15), newSlippage);

      expect(await hedgeManager.acceptableSlippage()).to.equal(newSlippage);
    });

    it("should revert if slippage exceeds max", async function () {
      const tooHigh = BigInt(6e16); // 6%

      await expect(
        hedgeManager.connect(owner).setAcceptableSlippage(tooHigh)
      ).to.be.revertedWithCustomError(hedgeManager, "SlippageTooHigh");
    });

    it("should allow owner to set callback gas limit", async function () {
      await hedgeManager.connect(owner).setCallbackGasLimit(2_000_000n);
      expect(await hedgeManager.callbackGasLimit()).to.equal(2_000_000n);
    });

    it("should allow owner to recover tokens", async function () {
      await usdc.mint(await hedgeManager.getAddress(), ethers.parseUnits("100", 6));

      const balanceBefore = await usdc.balanceOf(user.address);
      await hedgeManager
        .connect(owner)
        .emergencyRecover(await usdc.getAddress(), user.address, ethers.parseUnits("100", 6));
      const balanceAfter = await usdc.balanceOf(user.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseUnits("100", 6));
    });

    it("should allow owner to recover ETH", async function () {
      // Send some ETH to the contract
      await owner.sendTransaction({
        to: await hedgeManager.getAddress(),
        value: ethers.parseEther("1"),
      });

      const balanceBefore = await ethers.provider.getBalance(user.address);
      await hedgeManager.connect(owner).emergencyRecoverETH(user.address, ethers.parseEther("1"));
      const balanceAfter = await ethers.provider.getBalance(user.address);

      expect(balanceAfter - balanceBefore).to.equal(ethers.parseEther("1"));
    });
  });
});
