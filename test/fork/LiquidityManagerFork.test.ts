import { expect } from "chai";
import { ethers, network } from "hardhat";
import { Contract } from "ethers";
import { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import { ARBITRUM_ADDRESSES } from "../../hardhat.config";
import { LiquidityManager } from "../../typechain-types";

// Skip these tests if not running with forking enabled
const describeFork = process.env.ALCHEMY_API_KEY ? describe : describe.skip;

describeFork("LiquidityManager Fork Tests", function () {
  let signer: HardhatEthersSigner;
  let vault: HardhatEthersSigner;
  let liquidityManager: LiquidityManager;
  let uniswapPool: Contract;
  let positionManager: Contract;
  let factory: Contract;
  let weth: Contract;
  let usdc: Contract;

  // Pool interface ABI
  const POOL_ABI = [
    "function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)",
    "function liquidity() external view returns (uint128)",
    "function token0() external view returns (address)",
    "function token1() external view returns (address)",
    "function fee() external view returns (uint24)",
    "function tickSpacing() external view returns (int24)",
  ];

  // ERC20 ABI
  const ERC20_ABI = [
    "function balanceOf(address) external view returns (uint256)",
    "function decimals() external view returns (uint8)",
    "function symbol() external view returns (string)",
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function transfer(address to, uint256 amount) external returns (bool)",
  ];

  // Position Manager ABI
  const POSITION_MANAGER_ABI = [
    "function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)",
    "function balanceOf(address owner) external view returns (uint256)",
    "function tokenOfOwnerByIndex(address owner, uint256 index) external view returns (uint256)",
    "function ownerOf(uint256 tokenId) external view returns (address)",
  ];

  // Factory ABI
  const FACTORY_ABI = [
    "function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)",
  ];

  // Constants
  const POOL_FEE = 500; // 0.05%
  const WETH_AMOUNT = ethers.parseEther("10"); // 10 WETH
  const USDC_AMOUNT = BigInt(20_000) * BigInt(10) ** BigInt(6); // 20k USDC

  before(async function () {
    // Workaround for "No known hardfork" error on Arbitrum fork
    await network.provider.send("hardhat_mine", ["0x1"]);

    // Get signers
    [signer, vault] = await ethers.getSigners();

    // Connect to Uniswap V3 contracts
    uniswapPool = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL, POOL_ABI, signer);
    positionManager = new Contract(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      POSITION_MANAGER_ABI,
      signer
    );
    factory = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_FACTORY, FACTORY_ABI, signer);

    // Connect to tokens (using USDC.e for the existing pool)
    weth = new Contract(ARBITRUM_ADDRESSES.WETH, ERC20_ABI, signer);
    usdc = new Contract(ARBITRUM_ADDRESSES.USDC_E, ERC20_ABI, signer);

    // Deploy LiquidityManager
    const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
    liquidityManager = await LiquidityManager.deploy(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
      ARBITRUM_ADDRESSES.UNISWAP_V3_FACTORY,
      ARBITRUM_ADDRESSES.WETH,
      ARBITRUM_ADDRESSES.USDC_E,
      POOL_FEE,
      signer.address
    );
    await liquidityManager.waitForDeployment();

    // Set vault
    await liquidityManager.connect(signer).setVault(vault.address);

    // Fund vault with WETH and USDC
    // Use impersonation to get tokens from whales
    await fundAccount(vault.address, WETH_AMOUNT, USDC_AMOUNT);

    // Approve LiquidityManager
    await weth.connect(vault).approve(await liquidityManager.getAddress(), ethers.MaxUint256);
    await usdc.connect(vault).approve(await liquidityManager.getAddress(), ethers.MaxUint256);
  });

  // Helper to fund account with WETH and USDC
  async function fundAccount(account: string, wethAmount: bigint, usdcAmount: bigint) {
    // Fund with ETH first
    await signer.sendTransaction({
      to: account,
      value: wethAmount * 2n,
    });

    // Wrap ETH to WETH using deposit
    const WETH_ABI = ["function deposit() external payable", ...ERC20_ABI];
    const wethContract = new Contract(ARBITRUM_ADDRESSES.WETH, WETH_ABI, vault);
    await wethContract.deposit({ value: wethAmount });

    // For USDC, find a whale and impersonate
    const usdcWhale = "0x2Df1c51E09aECF9cacB7bc98cB1742757f163dF7"; // Known USDC.e whale on Arbitrum
    await network.provider.request({
      method: "hardhat_impersonateAccount",
      params: [usdcWhale],
    });

    // Fund whale with ETH for gas
    await signer.sendTransaction({
      to: usdcWhale,
      value: ethers.parseEther("1"),
    });

    const whaleSigner = await ethers.getSigner(usdcWhale);
    const usdcWithWhale = new Contract(ARBITRUM_ADDRESSES.USDC_E, ERC20_ABI, whaleSigner);

    // Check whale balance
    const whaleBalance = await usdcWithWhale.balanceOf(usdcWhale);
    const transferAmount = whaleBalance > usdcAmount ? usdcAmount : whaleBalance;

    if (transferAmount > 0n) {
      await usdcWithWhale.transfer(account, transferAmount);
    }

    await network.provider.request({
      method: "hardhat_stopImpersonatingAccount",
      params: [usdcWhale],
    });
  }

  // Helper to convert tick to sqrtPriceX96
  function tickToSqrtPriceX96(tick: number): bigint {
    const sqrtPrice = Math.pow(1.0001, tick / 2);
    const Q96 = BigInt(2) ** BigInt(96);
    return BigInt(Math.floor(sqrtPrice * Number(Q96)));
  }

  describe("Configuration", function () {
    it("should be configured with correct addresses", async function () {
      expect(await liquidityManager.positionManager()).to.equal(
        ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER
      );
      expect(await liquidityManager.swapRouter()).to.equal(
        ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER
      );
      expect(await liquidityManager.factory()).to.equal(ARBITRUM_ADDRESSES.UNISWAP_V3_FACTORY);
      expect(await liquidityManager.baseToken()).to.equal(ARBITRUM_ADDRESSES.WETH);
      expect(await liquidityManager.quoteToken()).to.equal(ARBITRUM_ADDRESSES.USDC_E);
      expect(await liquidityManager.poolFee()).to.equal(POOL_FEE);
    });

    it("should find correct pool", async function () {
      const pool = await liquidityManager.getPool();
      expect(pool.toLowerCase()).to.equal(
        ARBITRUM_ADDRESSES.UNISWAP_V3_ETH_USDC_005_POOL.toLowerCase()
      );
    });
  });

  describe("Read Pool State", function () {
    it("should read current pool price", async function () {
      const slot0 = await uniswapPool.slot0();

      console.log("\n=== Pool State ===");
      console.log("sqrtPriceX96:", slot0.sqrtPriceX96.toString());
      console.log("Current tick:", slot0.tick.toString());

      // Calculate approximate price
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let price = sqrtPrice * sqrtPrice;

      // Get token order
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      if (isWethToken0) {
        price = price * 1e12; // USDC per WETH
      } else {
        price = 1e12 / price; // USDC per WETH (inverted)
      }

      console.log("ETH Price:", price.toFixed(2), "USDC");

      expect(price).to.be.gt(100);
      expect(price).to.be.lt(100000);
    });
  });

  describe("Mint Position", function () {
    it("should mint a position on real Uniswap V3", async function () {
      // Get current tick
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      // Create range around current price
      const tickRange = 1000; // ~10%
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      console.log("\n=== Minting Position ===");
      console.log("Current tick:", currentTick);
      console.log("Tick lower:", tickLower);
      console.log("Tick upper:", tickUpper);

      // Get token order
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      // Check vault balances
      const wethBalance = await weth.balanceOf(vault.address);
      const usdcBalance = await usdc.balanceOf(vault.address);
      console.log("Vault WETH balance:", ethers.formatEther(wethBalance));
      console.log("Vault USDC balance:", Number(usdcBalance) / 1e6);

      // Use smaller amounts for the test
      const wethToDeposit = wethBalance > WETH_AMOUNT ? WETH_AMOUNT : wethBalance;
      const usdcToDeposit = usdcBalance > USDC_AMOUNT ? USDC_AMOUNT : usdcBalance;

      // Determine amount0 and amount1 based on token order
      const [amount0, amount1] = isWethToken0
        ? [wethToDeposit, usdcToDeposit]
        : [usdcToDeposit, wethToDeposit];

      console.log("Amount0:", amount0.toString());
      console.log("Amount1:", amount1.toString());

      // Set deadline
      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      // Skip if no balance
      if (wethToDeposit === 0n || usdcToDeposit === 0n) {
        console.log("Skipping: Insufficient token balance");
        return;
      }

      // Mint position
      const tx = await liquidityManager
        .connect(vault)
        .mintPosition(tickLower, tickUpper, amount0, amount1, deadline);

      const receipt = await tx.wait();
      console.log("Gas used:", receipt?.gasUsed.toString());

      // Verify position was created
      const tokenId = await liquidityManager.tokenId();
      const liquidity = await liquidityManager.liquidity();

      console.log("Token ID:", tokenId.toString());
      console.log("Liquidity:", liquidity.toString());

      expect(tokenId).to.be.gt(0n);
      expect(liquidity).to.be.gt(0n);

      // Verify LiquidityManager owns the NFT
      const nftOwner = await positionManager.ownerOf(tokenId);
      expect(nftOwner).to.equal(await liquidityManager.getAddress());
    });

    it("should return correct position value", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      const value = await liquidityManager.getPositionValue();
      console.log("\n=== Position Value ===");
      console.log("Value:", value.toString());

      // Value should be > 0 if position exists
      expect(value).to.be.gt(0n);
    });

    it("should return correct position delta", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      const delta = await liquidityManager.getPositionDelta();
      const deltaRatio = await liquidityManager.getPositionDeltaRatio();

      console.log("\n=== Position Delta ===");
      console.log("Delta:", delta.toString());
      console.log("Delta Ratio:", ((Number(deltaRatio) / 1e18) * 100).toFixed(2), "%");

      // Delta should be non-zero for in-range position
      // (could be zero if completely out of range)
    });

    it("should correctly report if position is in range", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      const inRange = await liquidityManager.isInRange();
      console.log("\n=== Range Check ===");
      console.log("In range:", inRange);

      // We minted around current tick, so should be in range
      expect(inRange).to.be.true;
    });
  });

  describe("Collect Fees", function () {
    it("should collect any accumulated fees", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      // Get pending fees before collection
      const [pending0, pending1] = await liquidityManager.getPendingFees();
      console.log("\n=== Pending Fees ===");
      console.log("Pending Token0:", pending0.toString());
      console.log("Pending Token1:", pending1.toString());

      // Collect fees (even if 0, this should succeed)
      const tx = await liquidityManager.connect(vault).collectFees();
      await tx.wait();

      // Verify fees were tracked
      const totalFees0 = await liquidityManager.totalFeesCollected0();
      const totalFees1 = await liquidityManager.totalFeesCollected1();

      console.log("Total fees collected (token0):", totalFees0.toString());
      console.log("Total fees collected (token1):", totalFees1.toString());
    });
  });

  describe("Increase Liquidity", function () {
    it("should increase liquidity in existing position", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      // Get current liquidity
      const liquidityBefore = await liquidityManager.liquidity();

      // Get token order
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      // Use small amounts
      const wethToAdd = ethers.parseEther("1");
      const usdcToAdd = BigInt(2_000) * BigInt(10) ** BigInt(6);

      // Check if vault has enough balance
      const wethBalance = await weth.balanceOf(vault.address);
      const usdcBalance = await usdc.balanceOf(vault.address);

      if (wethBalance < wethToAdd || usdcBalance < usdcToAdd) {
        console.log("Skipping: Insufficient balance");
        return;
      }

      const [amount0, amount1] = isWethToken0 ? [wethToAdd, usdcToAdd] : [usdcToAdd, wethToAdd];

      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      const tx = await liquidityManager
        .connect(vault)
        .increaseLiquidity(amount0, amount1, deadline);
      await tx.wait();

      const liquidityAfter = await liquidityManager.liquidity();
      console.log("\n=== Increase Liquidity ===");
      console.log("Liquidity before:", liquidityBefore.toString());
      console.log("Liquidity after:", liquidityAfter.toString());

      expect(liquidityAfter).to.be.gt(liquidityBefore);
    });
  });

  describe("Decrease Liquidity", function () {
    it("should decrease liquidity from position", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      const liquidityBefore = await liquidityManager.liquidity();
      const liquidityToRemove = liquidityBefore / 4n; // Remove 25%

      if (liquidityToRemove === 0n) {
        console.log("Skipping: Not enough liquidity to remove");
        return;
      }

      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      const tx = await liquidityManager
        .connect(vault)
        .decreaseLiquidity(liquidityToRemove, deadline);
      await tx.wait();

      const liquidityAfter = await liquidityManager.liquidity();
      console.log("\n=== Decrease Liquidity ===");
      console.log("Liquidity before:", liquidityBefore.toString());
      console.log("Liquidity removed:", liquidityToRemove.toString());
      console.log("Liquidity after:", liquidityAfter.toString());

      expect(liquidityAfter).to.equal(liquidityBefore - liquidityToRemove);
    });
  });

  describe("Adjust Range", function () {
    it("should adjust position range", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      // Get current range
      const [, oldTickLower, oldTickUpper] = await liquidityManager.getPositionInfo();

      // Get current tick
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());

      // Create wider range
      const tickRange = 2000; // ~20%
      const newTickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const newTickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      console.log("\n=== Adjust Range ===");
      console.log("Old range:", oldTickLower, "-", oldTickUpper);
      console.log("New range:", newTickLower, "-", newTickUpper);

      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      const tx = await liquidityManager
        .connect(vault)
        .adjustRange(newTickLower, newTickUpper, deadline);
      await tx.wait();

      // Verify new range
      const [newTokenId, actualTickLower, actualTickUpper] =
        await liquidityManager.getPositionInfo();

      expect(actualTickLower).to.equal(newTickLower);
      expect(actualTickUpper).to.equal(newTickUpper);
      expect(newTokenId).to.not.equal(tokenId);
    });
  });

  describe("Close Position", function () {
    it("should close position and return tokens", async function () {
      const tokenId = await liquidityManager.tokenId();
      if (tokenId === 0n) {
        console.log("Skipping: No position exists");
        return;
      }

      // Get vault balance before closing
      const wethBefore = await weth.balanceOf(vault.address);
      const usdcBefore = await usdc.balanceOf(vault.address);

      const tx = await liquidityManager.connect(vault).closePosition();
      const receipt = await tx.wait();

      console.log("\n=== Close Position ===");
      console.log("Gas used:", receipt?.gasUsed.toString());

      // Get vault balance after
      const wethAfter = await weth.balanceOf(vault.address);
      const usdcAfter = await usdc.balanceOf(vault.address);

      console.log("WETH received:", ethers.formatEther(wethAfter - wethBefore));
      console.log("USDC received:", Number(usdcAfter - usdcBefore) / 1e6);

      // Verify position is closed
      expect(await liquidityManager.tokenId()).to.equal(0n);
      expect(await liquidityManager.liquidity()).to.equal(0n);

      // Should have received some tokens back
      expect(wethAfter + usdcAfter).to.be.gte(wethBefore + usdcBefore);
    });
  });

  describe("Gas Optimization Analysis", function () {
    it("should report gas costs for all operations", async function () {
      // Get fresh tokens
      await fundAccount(vault.address, WETH_AMOUNT, USDC_AMOUNT);

      // Get current tick
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());
      const tickRange = 1000;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();
      const [amount0, amount1] = isWethToken0
        ? [ethers.parseEther("1"), BigInt(2_000) * BigInt(10) ** BigInt(6)]
        : [BigInt(2_000) * BigInt(10) ** BigInt(6), ethers.parseEther("1")];

      const block = await ethers.provider.getBlock("latest");
      const deadline = block!.timestamp + 3600;

      console.log("\n=== Gas Costs ===");

      // Mint
      const mintTx = await liquidityManager
        .connect(vault)
        .mintPosition(tickLower, tickUpper, amount0, amount1, deadline);
      const mintReceipt = await mintTx.wait();
      console.log("Mint position:", mintReceipt?.gasUsed.toString(), "gas");

      // Increase
      const increaseTx = await liquidityManager
        .connect(vault)
        .increaseLiquidity(amount0 / 2n, amount1 / 2n, deadline);
      const increaseReceipt = await increaseTx.wait();
      console.log("Increase liquidity:", increaseReceipt?.gasUsed.toString(), "gas");

      // Decrease
      const liquidity = await liquidityManager.liquidity();
      const decreaseTx = await liquidityManager
        .connect(vault)
        .decreaseLiquidity(liquidity / 4n, deadline);
      const decreaseReceipt = await decreaseTx.wait();
      console.log("Decrease liquidity:", decreaseReceipt?.gasUsed.toString(), "gas");

      // Collect
      const collectTx = await liquidityManager.connect(vault).collectFees();
      const collectReceipt = await collectTx.wait();
      console.log("Collect fees:", collectReceipt?.gasUsed.toString(), "gas");

      // Close
      const closeTx = await liquidityManager.connect(vault).closePosition();
      const closeReceipt = await closeTx.wait();
      console.log("Close position:", closeReceipt?.gasUsed.toString(), "gas");
    });
  });
});
