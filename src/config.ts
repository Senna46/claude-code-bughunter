// Configuration loader for Claude Code BugHunter.
// Reads environment variables (with dotenv support) and validates
// required settings. Provides sensible defaults for optional values.

import { config as dotenvConfig } from "dotenv";
import { homedir } from "os";
import { join } from "path";

import type { Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

export function loadConfig(): Config {
  dotenvConfig();

  const githubOrgs = parseCommaSeparated(process.env.BUGHUNTER_GITHUB_ORGS);
  const githubRepos = parseCommaSeparated(process.env.BUGHUNTER_GITHUB_REPOS);

  if (githubOrgs.length === 0 && githubRepos.length === 0) {
    throw new Error(
      "Configuration error: At least one of BUGHUNTER_GITHUB_ORGS or BUGHUNTER_GITHUB_REPOS must be set."
    );
  }

  const pollInterval = parsePositiveInt(
    process.env.BUGHUNTER_POLL_INTERVAL,
    60
  );
  const botName = process.env.BUGHUNTER_BOT_NAME?.trim() || "bughunter";
  const defaultWorkDir = join(homedir(), ".bughunter", "repos");
  const workDir = process.env.BUGHUNTER_WORK_DIR?.trim() || defaultWorkDir;
  const maxDiffSize = parsePositiveInt(
    process.env.BUGHUNTER_MAX_DIFF_SIZE,
    100000
  );
  const claudeModel = process.env.BUGHUNTER_CLAUDE_MODEL?.trim() || null;
  const logLevel = parseLogLevel(process.env.BUGHUNTER_LOG_LEVEL);
  const defaultDbPath = join(homedir(), ".bughunter", "state.db");
  const dbPath = process.env.BUGHUNTER_DB_PATH?.trim() || defaultDbPath;

  return {
    githubOrgs,
    githubRepos,
    pollInterval,
    botName,
    workDir,
    maxDiffSize,
    claudeModel,
    logLevel,
    dbPath,
  };
}

function parseCommaSeparated(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function parsePositiveInt(
  value: string | undefined,
  defaultValue: number
): number {
  if (!value || value.trim() === "") {
    return defaultValue;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed) || parsed <= 0) {
    throw new Error(
      `Configuration error: Expected a positive integer but got "${value}".`
    );
  }
  return parsed;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Configuration error: Invalid log level "${value}". Valid levels: ${VALID_LOG_LEVELS.join(", ")}`
    );
  }
  return level;
}
