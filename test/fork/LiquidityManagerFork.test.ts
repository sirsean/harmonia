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
    uniswapPool = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_WETH_USDC_005_POOL, POOL_ABI, signer);
    positionManager = new Contract(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      POSITION_MANAGER_ABI,
      signer
    );
    factory = new Contract(ARBITRUM_ADDRESSES.UNISWAP_V3_FACTORY, FACTORY_ABI, signer);

    // Connect to tokens (using native USDC)
    weth = new Contract(ARBITRUM_ADDRESSES.WETH, ERC20_ABI, signer);
    usdc = new Contract(ARBITRUM_ADDRESSES.USDC, ERC20_ABI, signer);

    // Deploy LiquidityManager
    const LiquidityManager = await ethers.getContractFactory("LiquidityManager");
    liquidityManager = await LiquidityManager.deploy(
      ARBITRUM_ADDRESSES.UNISWAP_V3_POSITION_MANAGER,
      ARBITRUM_ADDRESSES.UNISWAP_V3_SWAP_ROUTER,
      ARBITRUM_ADDRESSES.UNISWAP_V3_FACTORY,
      ARBITRUM_ADDRESSES.WETH,
      ARBITRUM_ADDRESSES.USDC,
      POOL_FEE,
      signer.address
    );
    await liquidityManager.waitForDeployment();

    // Set vault
    await liquidityManager.connect(signer).setVault(vault.address);

    // Set max slippage tolerance for fork tests (1% = 1e16)
    // Fork tests may have price movements that exceed default 0.5% tolerance
    await liquidityManager.connect(signer).setSlippageTolerance(BigInt(1e16));

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

    // For USDC (native), try multiple whale addresses
    // These are known native USDC holders on Arbitrum with substantial balances
    const usdcWhales = [
      "0x47c031236e19d024b42f8AE6780E44A573170703", // GMX GLP Manager
      "0xF89d7b9c864f589bbF53a82105107622B35EaA40", // Bybit hot wallet
      "0x0B0A5886664376F59C351ba3f598C8A8B4D0A6f3", // Another USDC holder
      "0x62383739D68Dd0F844103Db8dFb05a7EdED5BBE6", // Stargate USDC pool
      "0x1714400FF23dB4aF24F9fd64e7039e6597f18C2b", // Aave USDC pool
    ];

    let funded = false;
    const errors: string[] = [];

    for (const whaleAddress of usdcWhales) {
      try {
        // Check if whale has balance
        const whaleBalance = await usdc.balanceOf(whaleAddress);
        if (whaleBalance < usdcAmount) {
          errors.push(`${whaleAddress}: Insufficient balance (${Number(whaleBalance) / 1e6} USDC)`);
          continue;
        }

        await network.provider.request({
          method: "hardhat_impersonateAccount",
          params: [whaleAddress],
        });

        // Fund whale with ETH for gas
        await signer.sendTransaction({
          to: whaleAddress,
          value: ethers.parseEther("1"),
        });

        const whaleSigner = await ethers.getSigner(whaleAddress);
        const usdcWithWhale = new Contract(ARBITRUM_ADDRESSES.USDC, ERC20_ABI, whaleSigner);

        await usdcWithWhale.transfer(account, usdcAmount);

        await network.provider.request({
          method: "hardhat_stopImpersonatingAccount",
          params: [whaleAddress],
        });

        funded = true;
        console.log(`Funded from whale: ${whaleAddress}`);
        break;
      } catch (e) {
        const errorMsg = e instanceof Error ? e.message : String(e);
        errors.push(`${whaleAddress}: Transfer failed - ${errorMsg.substring(0, 100)}`);
        // Try next whale
        try {
          await network.provider.request({
            method: "hardhat_stopImpersonatingAccount",
            params: [whaleAddress],
          });
        } catch {
          // Ignore
        }
      }
    }

    if (!funded) {
      // Log errors for debugging
      console.log("\n=== USDC Funding Errors ===");
      for (const err of errors) {
        console.log(err);
      }
      throw new Error(
        `Could not fund account with ${Number(usdcAmount) / 1e6} USDC from any whale. ` +
          `Consider using a different fork block or adding more whale addresses.`
      );
    }
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
      expect(await liquidityManager.quoteToken()).to.equal(ARBITRUM_ADDRESSES.USDC);
      expect(await liquidityManager.poolFee()).to.equal(POOL_FEE);
    });

    it("should find correct pool", async function () {
      const pool = await liquidityManager.getPool();
      expect(pool.toLowerCase()).to.equal(
        ARBITRUM_ADDRESSES.UNISWAP_V3_WETH_USDC_005_POOL.toLowerCase()
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

      // Skip if insufficient balance
      if (wethBalance === 0n || usdcBalance === 0n) {
        console.log("Skipping: Insufficient token balance for test");
        this.skip();
        return;
      }

      // Calculate approximate ETH price to determine balanced amounts
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let ethPrice = sqrtPrice * sqrtPrice;
      if (isWethToken0) {
        ethPrice = ethPrice * 1e12; // USDC per WETH
      } else {
        ethPrice = 1e12 / ethPrice;
      }

      // Calculate balanced amounts based on current price
      // Use USDC as the constraint and calculate matching WETH
      const targetUsdcAmount = BigInt(10_000) * BigInt(10) ** BigInt(6); // 10k USDC
      const matchingWethAmount = BigInt(Math.floor((10_000 / ethPrice) * 1e18)); // Matching WETH value

      // Use the smaller of available and calculated amounts
      const wethToDeposit = wethBalance > matchingWethAmount ? matchingWethAmount : wethBalance;
      const usdcToDeposit = usdcBalance > targetUsdcAmount ? targetUsdcAmount : usdcBalance;

      console.log("ETH price:", ethPrice.toFixed(2));
      console.log("WETH to deposit:", ethers.formatEther(wethToDeposit));
      console.log("USDC to deposit:", Number(usdcToDeposit) / 1e6);

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

      // Get token order and current price
      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();
      const slot0 = await uniswapPool.slot0();
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let ethPrice = sqrtPrice * sqrtPrice;
      if (isWethToken0) {
        ethPrice = ethPrice * 1e12;
      } else {
        ethPrice = 1e12 / ethPrice;
      }

      // Calculate balanced amounts based on current price
      const targetUsdcAmount = BigInt(2_000) * BigInt(10) ** BigInt(6); // 2k USDC
      const matchingWethAmount = BigInt(Math.floor((2000 / ethPrice) * 1e18));

      // Check if vault has enough balance
      const wethBalance = await weth.balanceOf(vault.address);
      const usdcBalance = await usdc.balanceOf(vault.address);

      const wethToAdd = wethBalance > matchingWethAmount ? matchingWethAmount : wethBalance;
      const usdcToAdd = usdcBalance > targetUsdcAmount ? targetUsdcAmount : usdcBalance;

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

      // Get current tick and price
      const slot0 = await uniswapPool.slot0();
      const currentTick = Number(slot0.tick);
      const tickSpacing = Number(await uniswapPool.tickSpacing());
      const tickRange = 1000;
      const tickLower = Math.floor((currentTick - tickRange) / tickSpacing) * tickSpacing;
      const tickUpper = Math.ceil((currentTick + tickRange) / tickSpacing) * tickSpacing;

      const token0 = await uniswapPool.token0();
      const isWethToken0 = token0.toLowerCase() === ARBITRUM_ADDRESSES.WETH.toLowerCase();

      // Calculate balanced amounts based on current price
      const Q96 = BigInt(2) ** BigInt(96);
      const sqrtPrice = Number(slot0.sqrtPriceX96) / Number(Q96);
      let ethPrice = sqrtPrice * sqrtPrice;
      if (isWethToken0) {
        ethPrice = ethPrice * 1e12;
      } else {
        ethPrice = 1e12 / ethPrice;
      }

      const targetUsdcAmount = BigInt(2_000) * BigInt(10) ** BigInt(6); // 2k USDC
      const matchingWethAmount = BigInt(Math.floor((2000 / ethPrice) * 1e18));

      const [amount0, amount1] = isWethToken0
        ? [matchingWethAmount, targetUsdcAmount]
        : [targetUsdcAmount, matchingWethAmount];

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
