// Configuration loader for Claude Code BugHunter.
// Reads environment variables (with dotenv support) and validates
// required settings. Provides sensible defaults for optional values.

import { config as dotenvConfig } from "dotenv";
import { homedir } from "os";
import { join } from "path";

import type { AutofixMode, Config, LogLevel } from "./types.js";

const VALID_LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];
const VALID_AUTOFIX_MODES: AutofixMode[] = ["off", "branch", "commit", "pr"];

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
  const autofixMode = parseAutofixMode(process.env.BUGHUNTER_AUTOFIX_MODE);
  const defaultWorkDir = join(homedir(), ".bughunter", "repos");
  const workDir = process.env.BUGHUNTER_WORK_DIR?.trim() || defaultWorkDir;
  const maxDiffSize = parsePositiveInt(
    process.env.BUGHUNTER_MAX_DIFF_SIZE,
    100000
  );
  const maxFileContextSize = parsePositiveInt(
    process.env.BUGHUNTER_MAX_FILE_CONTEXT_SIZE,
    200000
  );
  const claudeModel = process.env.BUGHUNTER_CLAUDE_MODEL?.trim() || null;
  const logLevel = parseLogLevel(process.env.BUGHUNTER_LOG_LEVEL);
  const defaultDbPath = join(homedir(), ".bughunter", "state.db");
  const dbPath = process.env.BUGHUNTER_DB_PATH?.trim() || defaultDbPath;

  // Parallel analysis settings (inspired by Cursor Bugbot)
  const analysisPasses = parsePositiveInt(
    process.env.BUGHUNTER_ANALYSIS_PASSES,
    3
  );
  const voteThreshold = parsePositiveInt(
    process.env.BUGHUNTER_VOTE_THRESHOLD,
    2
  );

  if (voteThreshold > analysisPasses) {
    throw new Error(
      `Configuration error: BUGHUNTER_VOTE_THRESHOLD (${voteThreshold}) must not exceed BUGHUNTER_ANALYSIS_PASSES (${analysisPasses}). ` +
        `With the current settings, no bug can ever receive enough votes to pass the threshold, so all detected bugs would be silently discarded. ` +
        `Either increase BUGHUNTER_ANALYSIS_PASSES to at least ${voteThreshold}, or decrease BUGHUNTER_VOTE_THRESHOLD to at most ${analysisPasses}.`
    );
  }
  const enableValidator =
    process.env.BUGHUNTER_ENABLE_VALIDATOR?.trim().toLowerCase() !== "false";
  const validatorModel = process.env.BUGHUNTER_VALIDATOR_MODEL?.trim() || null;

  // Agentic analysis settings
  const enableAgenticAnalysis =
    process.env.BUGHUNTER_ENABLE_AGENTIC?.trim().toLowerCase() === "true";
  const agenticMaxTurns = parsePositiveInt(
    process.env.BUGHUNTER_AGENTIC_MAX_TURNS,
    10
  );

  // Dynamic context discovery settings
  const enableDynamicContext =
    process.env.BUGHUNTER_ENABLE_DYNAMIC_CONTEXT?.trim().toLowerCase() !==
    "false";
  const dynamicContextMaxFiles = parsePositiveInt(
    process.env.BUGHUNTER_DYNAMIC_CONTEXT_MAX_FILES,
    10
  );
  const dynamicContextMaxLines = parsePositiveInt(
    process.env.BUGHUNTER_DYNAMIC_CONTEXT_MAX_LINES,
    500
  );

  return {
    githubOrgs,
    githubRepos,
    pollInterval,
    botName,
    autofixMode,
    workDir,
    maxDiffSize,
    maxFileContextSize,
    claudeModel,
    logLevel,
    dbPath,
    analysisPasses,
    voteThreshold,
    enableValidator,
    validatorModel,
    enableAgenticAnalysis,
    agenticMaxTurns,
    enableDynamicContext,
    dynamicContextMaxFiles,
    dynamicContextMaxLines,
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

function parseAutofixMode(value: string | undefined): AutofixMode {
  const mode = (value?.trim().toLowerCase() || "branch") as AutofixMode;
  if (!VALID_AUTOFIX_MODES.includes(mode)) {
    throw new Error(
      `Configuration error: Invalid autofix mode "${value}". Valid modes: ${VALID_AUTOFIX_MODES.join(
        ", "
      )}`
    );
  }
  return mode;
}

function parseLogLevel(value: string | undefined): LogLevel {
  const level = (value?.trim().toLowerCase() || "info") as LogLevel;
  if (!VALID_LOG_LEVELS.includes(level)) {
    throw new Error(
      `Configuration error: Invalid log level "${value}". Valid levels: ${VALID_LOG_LEVELS.join(
        ", "
      )}`
    );
  }
  return level;
}
