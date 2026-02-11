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
  workDir: string;
  maxDiffSize: number;
  claudeModel: string | null;
  logLevel: LogLevel;
  dbPath: string;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

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

export interface AnalysisResult {
  bugs: Bug[];
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
