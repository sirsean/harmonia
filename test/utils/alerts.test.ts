import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  sendDiscordAlert,
  sendErrorAlert,
  sendSuccessAlert,
  sendWarningAlert,
  sendInfoAlert,
} from "../../src/utils/alerts";

// Mock fetch globally
global.fetch = vi.fn();

describe("Discord Alerts", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset environment variables
    delete process.env.DISCORD_CHANNEL_ID;
    delete process.env.DISCORD_APP_TOKEN;
  });

  describe("sendDiscordAlert", () => {
    it("should skip sending alert if Discord is not configured", async () => {
      // No environment variables set
      await sendDiscordAlert({
        title: "Test Alert",
        message: "Test message",
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should skip sending alert if Discord uses placeholder values", async () => {
      process.env.DISCORD_CHANNEL_ID = "your_discord_channel_id_here";
      process.env.DISCORD_APP_TOKEN = "your_discord_bot_token_here";

      await sendDiscordAlert({
        title: "Test Alert",
        message: "Test message",
      });

      expect(global.fetch).not.toHaveBeenCalled();
    });

    it("should send alert when Discord is properly configured", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = {
        ok: true,
        status: 200,
      };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendDiscordAlert({
        title: "Test Alert",
        message: "Test message",
        severity: "info",
      });

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const call = (global.fetch as any).mock.calls[0];
      expect(call[0]).toBe("https://discord.com/api/v10/channels/123456789/messages");
      expect(call[1].method).toBe("POST");
      expect(call[1].headers["Authorization"]).toBe("Bot test_bot_token");
      expect(call[1].headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(call[1].body);
      expect(body.embeds).toHaveLength(1);
      expect(body.embeds[0].title).toBe("Test Alert");
      expect(body.embeds[0].description).toBe("Test message");
      expect(body.embeds[0].color).toBe(0x0099ff); // Blue for info
      expect(body.embeds[0].fields).toEqual([]);
      expect(body.embeds[0].timestamp).toBeDefined();
    });

    it("should use correct colors for different severity levels", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValue(mockResponse);

      // Test error (red)
      await sendDiscordAlert({
        title: "Error",
        message: "Error message",
        severity: "error",
      });
      let call = (global.fetch as any).mock.calls[0];
      let body = JSON.parse(call[1].body);
      expect(body.embeds[0].color).toBe(0xff0000);

      // Test warning (orange)
      await sendDiscordAlert({
        title: "Warning",
        message: "Warning message",
        severity: "warning",
      });
      call = (global.fetch as any).mock.calls[1];
      body = JSON.parse(call[1].body);
      expect(body.embeds[0].color).toBe(0xffaa00);

      // Test success (green)
      await sendDiscordAlert({
        title: "Success",
        message: "Success message",
        severity: "success",
      });
      call = (global.fetch as any).mock.calls[2];
      body = JSON.parse(call[1].body);
      expect(body.embeds[0].color).toBe(0x00ff00);

      // Test info (blue)
      await sendDiscordAlert({
        title: "Info",
        message: "Info message",
        severity: "info",
      });
      call = (global.fetch as any).mock.calls[3];
      body = JSON.parse(call[1].body);
      expect(body.embeds[0].color).toBe(0x0099ff);
    });

    it("should include custom fields in embed", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendDiscordAlert({
        title: "Test Alert",
        message: "Test message",
        fields: [
          { name: "Field 1", value: "Value 1", inline: true },
          { name: "Field 2", value: "Value 2", inline: false },
        ],
      });

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].fields).toHaveLength(2);
      expect(body.embeds[0].fields[0]).toEqual({
        name: "Field 1",
        value: "Value 1",
        inline: true,
      });
      expect(body.embeds[0].fields[1]).toEqual({
        name: "Field 2",
        value: "Value 2",
        inline: false,
      });
    });

    it("should use custom color if provided", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendDiscordAlert({
        title: "Test Alert",
        message: "Test message",
        color: 0x123456,
      });

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].color).toBe(0x123456);
    });

    it("should throw error if Discord API returns error", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = {
        ok: false,
        status: 403,
        statusText: "Forbidden",
        text: async () => "Invalid token",
      };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await expect(
        sendDiscordAlert({
          title: "Test Alert",
          message: "Test message",
        })
      ).rejects.toThrow("Failed to send Discord alert");
    });
  });

  describe("sendErrorAlert", () => {
    it("should send error alert with Error object details", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const error = new Error("Test error message");
      error.stack = "Error: Test error message\n    at test.ts:1:1";

      await sendErrorAlert("Test Error", "Something went wrong", error);

      expect(global.fetch).toHaveBeenCalledTimes(1);
      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].title).toBe("Test Error");
      expect(body.embeds[0].description).toBe("Something went wrong");
      expect(body.embeds[0].color).toBe(0xff0000); // Red
      expect(body.embeds[0].fields).toHaveLength(2);
      expect(body.embeds[0].fields[0].name).toBe("Error Details");
      expect(body.embeds[0].fields[0].value).toContain("Test error message");
      expect(body.embeds[0].fields[1].name).toBe("Stack Trace");
      expect(body.embeds[0].fields[1].value).toContain("Error: Test error message");
    });

    it("should send error alert with non-Error object", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendErrorAlert("Test Error", "Something went wrong", "String error");

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].fields).toHaveLength(1);
      expect(body.embeds[0].fields[0].name).toBe("Error Details");
      expect(body.embeds[0].fields[0].value).toBe("```String error```");
    });

    it("should truncate long stack traces", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const error = new Error("Test error");
      error.stack = "A".repeat(2000); // Very long stack trace

      await sendErrorAlert("Test Error", "Something went wrong", error);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      // Stack trace should be truncated to 1000 chars + "..." = 1003 chars, plus code block markers
      const stackTraceValue = body.embeds[0].fields[1].value;
      const actualStackLength = stackTraceValue.replace(/```/g, "").length - 3; // Remove code block markers and "..."
      expect(actualStackLength).toBeLessThanOrEqual(1000);
      expect(stackTraceValue).toContain("...");
    });

    it("should truncate long error messages", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const longMessage = "A".repeat(2000);
      const error = new Error(longMessage);

      await sendErrorAlert("Test Error", "Something went wrong", error);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      
      const errorMessageValue = body.embeds[0].fields[0].value;
      // Should be truncated
      const actualMessageLength = errorMessageValue.replace(/```/g, "").length - 3;
      expect(actualMessageLength).toBeLessThanOrEqual(1000);
      expect(errorMessageValue).toContain("...");
    });

    it("should handle error without stack trace", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      const error = new Error("Test error");
      delete (error as any).stack;

      await sendErrorAlert("Test Error", "Something went wrong", error);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].fields).toHaveLength(1); // Only error details, no stack trace
    });
  });

  describe("sendSuccessAlert", () => {
    it("should send success alert with green color", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendSuccessAlert("Success", "Operation completed", [
        { name: "Field", value: "Value", inline: true },
      ]);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].title).toBe("Success");
      expect(body.embeds[0].description).toBe("Operation completed");
      expect(body.embeds[0].color).toBe(0x00ff00); // Green
      expect(body.embeds[0].fields).toHaveLength(1);
    });
  });

  describe("sendWarningAlert", () => {
    it("should send warning alert with orange color", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendWarningAlert("Warning", "Something to watch", [
        { name: "Field", value: "Value", inline: true },
      ]);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].title).toBe("Warning");
      expect(body.embeds[0].description).toBe("Something to watch");
      expect(body.embeds[0].color).toBe(0xffaa00); // Orange
      expect(body.embeds[0].fields).toHaveLength(1);
    });
  });

  describe("sendInfoAlert", () => {
    it("should send info alert with blue color", async () => {
      process.env.DISCORD_CHANNEL_ID = "123456789";
      process.env.DISCORD_APP_TOKEN = "test_bot_token";

      const mockResponse = { ok: true, status: 200 };
      (global.fetch as any).mockResolvedValueOnce(mockResponse);

      await sendInfoAlert("Info", "Information message", [
        { name: "Field", value: "Value", inline: true },
      ]);

      const call = (global.fetch as any).mock.calls[0];
      const body = JSON.parse(call[1].body);
      expect(body.embeds[0].title).toBe("Info");
      expect(body.embeds[0].description).toBe("Information message");
      expect(body.embeds[0].color).toBe(0x0099ff); // Blue
      expect(body.embeds[0].fields).toHaveLength(1);
    });
  });
});
