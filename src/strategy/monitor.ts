import { ethers } from "ethers";
import * as gmxReader from "../modules/gmx/reader";
import * as uniswapReader from "../modules/uniswap/reader";
import { calculateDelta, DeltaResult } from "../modules/math/delta";
import { getSqrtRatioAtTick } from "../modules/math/ticks";
import {
  MonitorConfig,
  Recommendation,
  StrategyAction,
  StrategyMonitor,
  StrategyStatus,
} from "./types";
import { GMXPosition } from "../modules/gmx/types";

export class DeltaNeutralMonitor implements StrategyMonitor {

  constructor(

    private provider: ethers.Provider,

    private config: MonitorConfig,

    private context: {

      uniswap: {

        positionManager: string;

        pool: string;

        tokenIds?: bigint[];

      };

      gmx: {

        reader: string;

        dataStore: string;

        account: string;

        market: string;

        collateralToken: string;

      };

    }

  ) {}



  async check(): Promise<{ status: StrategyStatus; recommendation: Recommendation }> {

    const { uniswap, gmx } = this.context;

    

    // Helper to get all token IDs if not provided

    let tokenIds = uniswap.tokenIds || [];

    if (tokenIds.length === 0) {

      // If no token IDs provided, we need to fetch them from the PositionManager

      // logic similar to loadTokenIds in script

      const pmContract = new ethers.Contract(

        uniswap.positionManager, 

        ["function balanceOf(address) view returns (uint256)", "function tokenOfOwnerByIndex(address, uint256) view returns (uint256)"],

        this.provider

      );

      // We assume the caller (gmx.account) is the owner of the LP positions too for this strategy

      const balance = await pmContract.balanceOf(gmx.account);

      const count = Number(balance);

      for (let i = 0; i < count; i++) {

        const id = await pmContract.tokenOfOwnerByIndex(gmx.account, i);

        tokenIds.push(typeof id === 'bigint' ? id : BigInt(id));

      }

    }



    // 1. Fetch Uniswap Data for ALL positions

    const poolContract = uniswapReader.createPool(uniswap.pool, this.provider);

    const pmContract = uniswapReader.createPositionManager(uniswap.positionManager, this.provider);

    const poolState = await uniswapReader.getPoolState(poolContract); // Only need to fetch pool state once if all positions are same pool



    const uniswapPositions = [];

    let totalLpDelta = 0n;

    let totalFees0 = 0n;

    let totalFees1 = 0n;

    let anyOutOfRange = false;



    for (const tokenId of tokenIds) {

      const position = await uniswapReader.getPosition(pmContract, tokenId);

      

      // Filter out positions that don't match our pool (token0/token1/fee)

      // This is important if the user has positions in other pools

      // We need to know the pool tokens. 

      // Optimization: We could read pool tokens once.

      const poolToken0 = await poolContract.token0();

      const poolToken1 = await poolContract.token1();

      

      if (position.token0.toLowerCase() !== poolToken0.toLowerCase() || 

          position.token1.toLowerCase() !== poolToken1.toLowerCase()) {

         continue; // Skip positions from other pools

      }



      const sqrtPaX96 = getSqrtRatioAtTick(position.tickLower);

      const sqrtPbX96 = getSqrtRatioAtTick(position.tickUpper);

      

      const deltaResult = calculateDelta(

        poolState.sqrtPriceX96,

        sqrtPaX96,

        sqrtPbX96,

        position.liquidity

      );



      uniswapPositions.push({

        tokenId: tokenId.toString(),

        liquidity: position.liquidity,

        tickLower: position.tickLower,

        tickUpper: position.tickUpper,

        currentTick: poolState.tick,

        sqrtPriceX96: poolState.sqrtPriceX96,

        unclaimedFees: {

          amount0: position.tokensOwed0,

          amount1: position.tokensOwed1,

        },

        delta: deltaResult,

      });



      totalLpDelta += deltaResult.delta;

      totalFees0 += position.tokensOwed0;

      totalFees1 += position.tokensOwed1;

      

      if (deltaResult.zone !== "in" && position.liquidity > 0n) {

        anyOutOfRange = true;

      }

    }



    // 2. Fetch GMX Data

    const gmxReaderContract = gmxReader.createReader(gmx.reader, this.provider);

    const gmxPosition = await gmxReader.getPosition(gmxReaderContract, gmx.dataStore, gmx.account, {

      market: gmx.market,

      collateralToken: gmx.collateralToken,

      isLong: false, // We assume short for hedging

    });



    // 3. Calculate GMX Delta

    const shortSizeTokens = gmxPosition ? gmxPosition.numbers.sizeInTokens : 0n;

    const gmxDelta = -shortSizeTokens;



    // 4. Calculate Net Delta and Drift

    const netDelta = totalLpDelta + gmxDelta;

    

    // Avoid division by zero if LP delta is 0

    let deltaDrift = 0;

    if (totalLpDelta !== 0n) {

      const absNetDelta = netDelta < 0n ? -netDelta : netDelta;

      deltaDrift = Number(absNetDelta) / Number(totalLpDelta);

    } else if (shortSizeTokens > 0n) {

      deltaDrift = 1;

    }



    const pendingFunding = gmxPosition ? gmxPosition.numbers.shortTokenClaimableFundingAmountPerSize : 0n;



    const status: StrategyStatus = {

      uniswap: uniswapPositions,

      totalLpDelta,

      gmx: {

        positionSizeTokens: shortSizeTokens, // stored as positive int in struct

        pendingFundingRewards: pendingFunding,

        delta: gmxDelta,

      },

      netDelta,

      deltaDrift,

      timestamp: Date.now(),

    };



    const recommendation = this.generateRecommendation(status, anyOutOfRange, totalFees0, totalFees1);



    return { status, recommendation };

  }



  private generateRecommendation(

    status: StrategyStatus, 

    anyOutOfRange: boolean,

    totalFees0: bigint,

    totalFees1: bigint

  ): Recommendation {

    // 1. Check for Range Adjustment

    if (anyOutOfRange) {

      return {

        action: StrategyAction.ADJUST_RANGE,

        reason: `One or more positions are out of range.`,

      };

    }



    // 2. Check for Rebalancing

    if (status.deltaDrift > this.config.deltaThreshold) {

      return {

        action: StrategyAction.REBALANCE,

        reason: `Delta drift ${(status.deltaDrift * 100).toFixed(2)}% exceeds threshold ${(this.config.deltaThreshold * 100).toFixed(2)}%`,

        data: {

          targetDelta: status.totalLpDelta,

          currentHedge: -status.gmx.delta,

          adjustmentNeeded: status.netDelta, 

        }

      };

    }



    // 3. Check for Compounding

    if (totalFees0 > this.config.minFeeThreshold || totalFees1 > this.config.minFeeThreshold) {

      return {

        action: StrategyAction.COMPOUND,

        reason: "Unclaimed fees exceed threshold",

      };

    }



    return {

      action: StrategyAction.NONE,

      reason: "Strategy is healthy",

    };

  }

}


