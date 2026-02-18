// Data models and type definitions for Claude Code BugHunter.
// Defines all shared interfaces used across modules including
// bug reports, PR metadata, fix information, and analysis results.

// ============================================================
// Configuration
// ============================================================

export interface Config {
  githubOrgs: string[];
  githubRepos: string[];
  pollInterval: number;
  botName: string;
  autofixMode: AutofixMode;
  workDir: string;
  maxDiffSize: number;
  maxFileContextSize: number;
  claudeModel: string | null;
  logLevel: LogLevel;
  dbPath: string;
  // Parallel analysis settings (inspired by Cursor Bugbot)
  analysisPasses: number;
  voteThreshold: number;
  enableValidator: boolean;
  validatorModel: string | null;
  // Agentic analysis settings
  enableAgenticAnalysis: boolean;
  agenticMaxTurns: number;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

// Autofix mode: controls how BugHunter handles generated fixes
//   off    - Bug detection only, no fix generation
//   branch - Create a fix branch, post autofix comment, wait for approval (default)
//   commit - Commit fixes directly to the PR's head branch
//   pr     - Create a fix branch and automatically open a new PR
export type AutofixMode = "off" | "branch" | "commit" | "pr";

// ============================================================
// GitHub PR Data
// ============================================================

export interface PullRequest {
  owner: string;
  repo: string;
  number: number;
  title: string;
  body: string | null;
  state: string;
  headRef: string;
  baseRef: string;
  headSha: string;
  authorLogin: string;
  htmlUrl: string;
}

export interface PrCommit {
  sha: string;
  message: string;
  authorLogin: string;
  date: string;
}

// ============================================================
// Bug Analysis
// ============================================================

export type BugSeverity = "low" | "medium" | "high" | "critical";

export type RiskLevel = "low" | "medium" | "high";

export interface Bug {
  id: string;
  title: string;
  severity: BugSeverity;
  description: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
}

const LINE_BUCKET_SIZE = 5;
const TITLE_SIMILARITY_LENGTH = 50;

// Returns all candidate similarity keys for a Bug.
// Two keys are generated when the line falls near a bucket boundary:
//   1. Primary key   – based on Math.floor(line / bucketSize)
//   2. Shifted key   – based on Math.floor((line + bucketSize/2) / bucketSize)
// This ensures that two passes reporting the same bug at adjacent lines that
// straddle a boundary (e.g. lines 9 and 10 with bucket size 5) share at least
// one key and their votes are correctly merged.
export function createBugSimilarityKeys(bug: Bug): string[] {
  const normalizedTitle = bug.title.toLowerCase().trim();
  const normalizedFile = bug.filePath.toLowerCase().trim();
  const titlePrefix = normalizedTitle.substring(0, TITLE_SIMILARITY_LENGTH);

  if (!bug.startLine) {
    return [`${normalizedFile}:0:${titlePrefix}`];
  }

  const primaryBucket = Math.floor(bug.startLine / LINE_BUCKET_SIZE);
  const shiftedBucket = Math.floor(
    (bug.startLine + Math.floor(LINE_BUCKET_SIZE / 2)) / LINE_BUCKET_SIZE
  );
  const primaryKey = `${normalizedFile}:${primaryBucket}:${titlePrefix}`;

  if (shiftedBucket !== primaryBucket) {
    const shiftedKey = `${normalizedFile}:${shiftedBucket}:${titlePrefix}`;
    return [primaryKey, shiftedKey];
  }

  return [primaryKey];
}

// Convenience wrapper returning only the primary similarity key.
// Prefer createBugSimilarityKeys when boundary-tolerant matching is needed.
export function createBugSimilarityKey(bug: Bug): string {
  return createBugSimilarityKeys(bug)[0];
}

export interface AnalysisResult {
  bugs: Bug[];
  overview: string;
  summary: string;
  riskLevel: RiskLevel;
  commitSha: string;
  analyzedAt: string;
}

// JSON schema output from claude -p for bug analysis
export interface ClaudeAnalysisOutput {
  bugs: Array<{
    title: string;
    severity: BugSeverity;
    description: string;
    filePath: string;
    startLine?: number;
    endLine?: number;
  }>;
  overview: string;
  summary: string;
  riskLevel: RiskLevel;
}

// ============================================================
// Fix Generation
// ============================================================

export type FixStatus = "pending" | "approved" | "pushed" | "failed";

export interface FixBranch {
  id: number;
  repo: string;
  prNumber: number;
  branchName: string;
  fixCommitSha: string | null;
  bugIds: string[];
  status: FixStatus;
  createdAt: string;
}

export interface FixResult {
  branchName: string;
  commitSha: string;
  diff: string;
  fixedBugs: Array<{
    bugId: string;
    title: string;
    description: string;
  }>;
}

// ============================================================
// Approval
// ============================================================

export interface ApprovalCommand {
  commentId: number;
  prNumber: number;
  repo: string;
  owner: string;
  commitSha: string;
  authorLogin: string;
}

// ============================================================
// State (DB Records)
// ============================================================

export type BugStatus = "open" | "fixed" | "dismissed";

export interface AnalyzedCommitRecord {
  id: number;
  repo: string;
  prNumber: number;
  commitSha: string;
  analyzedAt: string;
  bugCount: number;
}

export interface BugRecord {
  id: string;
  repo: string;
  prNumber: number;
  commitSha: string;
  title: string;
  severity: BugSeverity;
  description: string;
  filePath: string;
  startLine: number | null;
  endLine: number | null;
  status: BugStatus;
}

export interface FixBranchRecord {
  id: number;
  repo: string;
  prNumber: number;
  branchName: string;
  fixCommitSha: string | null;
  status: FixStatus;
  createdAt: string;
}

export interface ProcessedApprovalRecord {
  id: number;
  commentId: number;
  repo: string;
  prNumber: number;
  processedAt: string;
}
