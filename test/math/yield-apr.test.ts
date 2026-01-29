import { describe, expect, it } from "vitest";
import { ethers } from "ethers";
import {
  calculateAPRFromYield,
  calculateAPRFromYieldMs,
  PRECISION,
} from "../../src/modules/math/yield";

describe("APR calculation from yield", () => {
  describe("calculateAPRFromYield", () => {
    it("calculates APR correctly for positive yield", () => {
      // $1000 net yield over 30 days with $100,000 average NAV
      const netYieldUsd = ethers.parseUnits("1000", 30); // 30 decimals
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 30;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (1000 / 100000) * (365 / 30) = 0.01 * 12.1667 = 0.121667
      // APR should be ~12.17%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(12.1667, 2);
    });

    it("calculates APR correctly for 1 year period", () => {
      // $10,000 net yield over 365 days with $100,000 average NAV
      const netYieldUsd = ethers.parseUnits("10000", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 365;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (10000 / 100000) * (365 / 365) = 0.1 = 10%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(10.0, 2);
    });

    it("calculates APR correctly for 7 day period", () => {
      // $100 net yield over 7 days with $50,000 average NAV
      const netYieldUsd = ethers.parseUnits("100", 30);
      const averageNavUsd = ethers.parseUnits("50000", 30);
      const elapsedDays = 7;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (100 / 50000) * (365 / 7) = 0.002 * 52.14 = 0.1043 = 10.43%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(10.43, 2);
    });

    it("handles very small yields correctly", () => {
      // $1 net yield over 30 days with $100,000 average NAV
      const netYieldUsd = ethers.parseUnits("1", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 30;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (1 / 100000) * (365 / 30) = 0.00001 * 12.1667 = 0.000121667 = 0.012%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(0.01217, 3);
    });

    it("handles negative yield (losses) correctly", () => {
      // -$500 net yield (loss) over 30 days with $100,000 average NAV
      const netYieldUsd = -ethers.parseUnits("500", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 30;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (-500 / 100000) * (365 / 30) = -0.005 * 12.1667 = -0.0608 = -6.08%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(-6.08, 2);
    });

    it("throws error for zero average NAV", () => {
      const netYieldUsd = ethers.parseUnits("1000", 30);
      const averageNavUsd = 0n;
      const elapsedDays = 30;

      expect(() => calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays)).toThrow(
        "averageNavUsd must be positive"
      );
    });

    it("throws error for zero elapsed days", () => {
      const netYieldUsd = ethers.parseUnits("1000", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 0;

      expect(() => calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays)).toThrow(
        "elapsedDays must be positive"
      );
    });

    it("throws error for negative elapsed days", () => {
      const netYieldUsd = ethers.parseUnits("1000", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = -1;

      expect(() => calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays)).toThrow(
        "elapsedDays must be positive"
      );
    });

    it("handles fractional days correctly", () => {
      // 15.5 days
      const netYieldUsd = ethers.parseUnits("500", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 15.5;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Should not throw and should calculate correctly
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeGreaterThan(0);
    });

    it("handles very large yields correctly", () => {
      // $1,000,000 net yield over 30 days with $100,000 average NAV
      const netYieldUsd = ethers.parseUnits("1000000", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedDays = 30;

      const apr = calculateAPRFromYield(netYieldUsd, averageNavUsd, elapsedDays);

      // Expected: (1000000 / 100000) * (365 / 30) = 10 * 12.1667 = 121.667 = 12167%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(12166.67, 0);
    });
  });

  describe("calculateAPRFromYieldMs", () => {
    it("calculates APR correctly from milliseconds", () => {
      // $1000 net yield over 30 days (in milliseconds) with $100,000 average NAV
      const netYieldUsd = ethers.parseUnits("1000", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedMs = 30 * 24 * 60 * 60 * 1000; // 30 days in milliseconds

      const apr = calculateAPRFromYieldMs(netYieldUsd, averageNavUsd, elapsedMs);

      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(12.1667, 2);
    });

    it("handles 7 days correctly", () => {
      const netYieldUsd = ethers.parseUnits("100", 30);
      const averageNavUsd = ethers.parseUnits("50000", 30);
      const elapsedMs = 7 * 24 * 60 * 60 * 1000;

      const apr = calculateAPRFromYieldMs(netYieldUsd, averageNavUsd, elapsedMs);

      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(10.43, 2);
    });

    it("handles 1 day correctly", () => {
      const netYieldUsd = ethers.parseUnits("10", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedMs = 24 * 60 * 60 * 1000;

      const apr = calculateAPRFromYieldMs(netYieldUsd, averageNavUsd, elapsedMs);

      // Expected: (10 / 100000) * (365 / 1) = 0.0001 * 365 = 0.0365 = 3.65%
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeCloseTo(3.65, 2);
    });

    it("handles very small time periods", () => {
      const netYieldUsd = ethers.parseUnits("1", 30);
      const averageNavUsd = ethers.parseUnits("100000", 30);
      const elapsedMs = 24 * 60 * 60 * 1000; // 1 day (minimum to avoid division by zero)

      const apr = calculateAPRFromYieldMs(netYieldUsd, averageNavUsd, elapsedMs);

      // Should calculate without throwing
      const aprPercent = Number(apr) / Number(PRECISION) * 100;
      expect(aprPercent).toBeGreaterThan(0);
    });
  });
});
