/**
 * Logging utility for Harmonia
 *
 * Provides structured logging with file and console output.
 * Logs are written to a configurable logs directory.
 */

import * as fs from "fs";
import * as path from "path";

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface LogEntry {
  timestamp: string;
  level: string;
  message: string;
  data?: any;
}

/**
 * Logger class for structured logging
 */
export class Logger {
  private logDir: string;
  private logFile: string = "";
  private level: LogLevel;
  private fileStream: fs.WriteStream | null = null;

  constructor(logDir: string = "logs", level: LogLevel = LogLevel.INFO) {
    this.logDir = logDir;
    this.level = level;

    try {
      // Ensure log directory exists
      if (!fs.existsSync(this.logDir)) {
        fs.mkdirSync(this.logDir, { recursive: true });
      }

      // Create daily log file
      const today = new Date().toISOString().split("T")[0];
      this.logFile = path.join(this.logDir, `harmonia-${today}.log`);

      // Open file stream for appending
      this.fileStream = fs.createWriteStream(this.logFile, { flags: "a" });
    } catch (error) {
      // If file operations fail, continue without file logging
      console.warn(`Failed to initialize file logging: ${error}`);
      this.fileStream = null;
    }
  }

  /**
   * Write log entry to file and console
   */
  private write(level: string, message: string, data?: any): void {
    if (this.getLevelValue(level) < this.level) {
      return;
    }

    const timestamp = new Date().toISOString();
    const entry: LogEntry = {
      timestamp,
      level,
      message,
      ...(data && { data }),
    };

    const logLine = JSON.stringify(entry) + "\n";

    // Write to file
    if (this.fileStream) {
      this.fileStream.write(logLine);
    }

    // Write to console with formatting
    const consoleMessage = this.formatConsoleMessage(level, message, data);
    if (level === "ERROR") {
      console.error(consoleMessage);
    } else if (level === "WARN") {
      console.warn(consoleMessage);
    } else {
      console.log(consoleMessage);
    }
  }

  /**
   * Format message for console output
   */
  private formatConsoleMessage(level: string, message: string, data?: any): string {
    const timestamp = new Date().toISOString();
    const levelColor = this.getLevelColor(level);
    const resetColor = "\x1b[0m";
    const levelStr = `[${levelColor}${level}${resetColor}]`;
    const timeStr = `[${timestamp}]`;

    let output = `${timeStr} ${levelStr} ${message}`;
    if (data) {
      output += ` ${JSON.stringify(data, (key, value) => (typeof value === "bigint" ? value.toString() : value))}`;
    }
    return output;
  }

  /**
   * Get color code for log level
   */
  private getLevelColor(level: string): string {
    switch (level) {
      case "DEBUG":
        return "\x1b[36m"; // Cyan
      case "INFO":
        return "\x1b[32m"; // Green
      case "WARN":
        return "\x1b[33m"; // Yellow
      case "ERROR":
        return "\x1b[31m"; // Red
      default:
        return "\x1b[0m"; // Reset
    }
  }

  /**
   * Get numeric value for log level
   */
  private getLevelValue(level: string): LogLevel {
    switch (level) {
      case "DEBUG":
        return LogLevel.DEBUG;
      case "INFO":
        return LogLevel.INFO;
      case "WARN":
        return LogLevel.WARN;
      case "ERROR":
        return LogLevel.ERROR;
      default:
        return LogLevel.INFO;
    }
  }

  debug(message: string, data?: any): void {
    this.write("DEBUG", message, data);
  }

  info(message: string, data?: any): void {
    this.write("INFO", message, data);
  }

  warn(message: string, data?: any): void {
    this.write("WARN", message, data);
  }

  error(message: string, data?: any): void {
    this.write("ERROR", message, data);
  }

  /**
   * Close the file stream
   */
  close(): void {
    if (this.fileStream) {
      this.fileStream.end();
      this.fileStream = null;
    }
  }
}

/**
 * Get logger instance with configurable log directory
 */
let defaultLogger: Logger | null = null;

export function getLogger(logDir?: string, level?: LogLevel): Logger {
  if (!defaultLogger) {
    const logsDir = logDir || process.env.LOGS_DIR || "logs";
    const logLevel = level || (process.env.LOG_LEVEL === "DEBUG" ? LogLevel.DEBUG : LogLevel.INFO);
    defaultLogger = new Logger(logsDir, logLevel);
  }
  return defaultLogger;
}

/**
 * Create a new logger instance (useful for testing or multiple loggers)
 */
export function createLogger(logDir?: string, level?: LogLevel): Logger {
  const logsDir = logDir || process.env.LOGS_DIR || "logs";
  const logLevel = level || (process.env.LOG_LEVEL === "DEBUG" ? LogLevel.DEBUG : LogLevel.INFO);
  return new Logger(logsDir, logLevel);
}
