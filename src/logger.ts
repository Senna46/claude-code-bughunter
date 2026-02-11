// Simple structured logger for Claude Code BugHunter.
// Supports log levels (debug, info, warn, error) and
// outputs timestamped messages to stdout/stderr.

import type { LogLevel } from "./types.js";

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVEL_PRIORITY[level] >= LOG_LEVEL_PRIORITY[currentLevel];
}

function formatTimestamp(): string {
  return new Date().toISOString();
}

function formatMessage(
  level: LogLevel,
  message: string,
  context?: Record<string, unknown>
): string {
  const timestamp = formatTimestamp();
  const levelTag = level.toUpperCase().padEnd(5);
  let formatted = `[${timestamp}] ${levelTag} ${message}`;
  if (context && Object.keys(context).length > 0) {
    formatted += ` ${JSON.stringify(context)}`;
  }
  return formatted;
}

export const logger = {
  debug(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("debug")) {
      console.log(formatMessage("debug", message, context));
    }
  },

  info(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("info")) {
      console.log(formatMessage("info", message, context));
    }
  },

  warn(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("warn")) {
      console.warn(formatMessage("warn", message, context));
    }
  },

  error(message: string, context?: Record<string, unknown>): void {
    if (shouldLog("error")) {
      console.error(formatMessage("error", message, context));
    }
  },
};
