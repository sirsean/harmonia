import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import {
  loadDeployment,
  loadReaderDeployment,
  loadEventEmitterDeployment,
  type Deployment,
} from "../../src/utils/deployments";

// Mock fs module
vi.mock("fs");

describe("deployments", () => {
  const mockFs = vi.mocked(fs);

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("loadDeployment", () => {
    it("should load a deployment file successfully", () => {
      const mockDeployment: Deployment = {
        address: "0x1234567890123456789012345678901234567890",
        abi: [{ type: "function", name: "test" }],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      const result = loadDeployment("Reader", "arbitrum");

      expect(result).toEqual(mockDeployment);
      expect(mockFs.existsSync).toHaveBeenCalled();
      expect(mockFs.readFileSync).toHaveBeenCalled();
      // Verify the path includes Reader and arbitrum
      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("Reader");
      expect(readFileCall).toContain("arbitrum");
    });

    it("should use default network 'arbitrum' when not specified", () => {
      const mockDeployment: Deployment = {
        address: "0x1234567890123456789012345678901234567890",
        abi: [],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      loadDeployment("Reader");

      // Verify the path includes "arbitrum"
      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("arbitrum");
    });

    it("should throw error when deployment file does not exist", () => {
      mockFs.existsSync.mockReturnValue(false);

      expect(() => loadDeployment("Reader", "arbitrum")).toThrow(
        "Deployment file not found"
      );
    });

    it("should throw error when deployment file has invalid format", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ address: "0x123" })); // Missing abi

      expect(() => loadDeployment("Reader", "arbitrum")).toThrow(
        "Invalid deployment file format"
      );
    });

    it("should throw error when JSON parsing fails", () => {
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue("invalid json");

      expect(() => loadDeployment("Reader", "arbitrum")).toThrow(
        "Failed to load deployment"
      );
    });
  });

  describe("loadReaderDeployment", () => {
    it("should load Reader deployment", () => {
      const mockDeployment: Deployment = {
        address: "0x1234567890123456789012345678901234567890",
        abi: [],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      const result = loadReaderDeployment("arbitrum");

      expect(result).toEqual(mockDeployment);
      // Verify it's looking for Reader deployment
      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("Reader");
    });

    it("should use default network 'arbitrum'", () => {
      const mockDeployment: Deployment = {
        address: "0x1234567890123456789012345678901234567890",
        abi: [],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      loadReaderDeployment();

      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("arbitrum");
    });
  });

  describe("loadEventEmitterDeployment", () => {
    it("should load EventEmitter deployment", () => {
      const mockDeployment: Deployment = {
        address: "0x9876543210987654321098765432109876543210",
        abi: [],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      const result = loadEventEmitterDeployment("arbitrum");

      expect(result).toEqual(mockDeployment);
      // Verify it's looking for EventEmitter deployment
      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("EventEmitter");
    });

    it("should use default network 'arbitrum'", () => {
      const mockDeployment: Deployment = {
        address: "0x9876543210987654321098765432109876543210",
        abi: [],
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockDeployment));

      loadEventEmitterDeployment();

      const readFileCall = mockFs.readFileSync.mock.calls[0][0] as string;
      expect(readFileCall).toContain("arbitrum");
    });
  });
});
