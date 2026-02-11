// SQLite state management for Claude Code BugHunter.
// Tracks analyzed commits, detected bugs, fix branches, and processed approvals.
// Uses better-sqlite3 for synchronous, fast SQLite operations.
// Limitations: Single-process only (no concurrent write support).

import Database from "better-sqlite3";
import { mkdirSync } from "fs";
import { dirname } from "path";

import { logger } from "./logger.js";
import type {
  AnalyzedCommitRecord,
  BugRecord,
  BugSeverity,
  BugStatus,
  FixBranchRecord,
  FixStatus,
  ProcessedApprovalRecord,
} from "./types.js";

export class StateStore {
  private db: Database.Database;

  constructor(dbPath: string) {
    // Ensure the directory exists
    mkdirSync(dirname(dbPath), { recursive: true });

    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.initializeSchema();

    logger.info("State store initialized.", { dbPath });
  }

  // ============================================================
  // Schema initialization
  // ============================================================

  private initializeSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS analyzed_commits (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        analyzed_at TEXT NOT NULL,
        bug_count INTEGER DEFAULT 0,
        UNIQUE(repo, pr_number, commit_sha)
      );

      CREATE TABLE IF NOT EXISTS bugs (
        id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        commit_sha TEXT NOT NULL,
        title TEXT NOT NULL,
        severity TEXT NOT NULL,
        description TEXT,
        file_path TEXT,
        start_line INTEGER,
        end_line INTEGER,
        status TEXT DEFAULT 'open'
      );

      CREATE TABLE IF NOT EXISTS fix_branches (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        branch_name TEXT NOT NULL,
        fix_commit_sha TEXT,
        status TEXT DEFAULT 'pending',
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS processed_approvals (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        comment_id INTEGER NOT NULL UNIQUE,
        repo TEXT NOT NULL,
        pr_number INTEGER NOT NULL,
        processed_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_analyzed_commits_repo_pr
        ON analyzed_commits(repo, pr_number);

      CREATE INDEX IF NOT EXISTS idx_bugs_repo_pr
        ON bugs(repo, pr_number);

      CREATE INDEX IF NOT EXISTS idx_fix_branches_repo_pr
        ON fix_branches(repo, pr_number);
    `);
  }

  // ============================================================
  // Analyzed Commits
  // ============================================================

  isCommitAnalyzed(repo: string, prNumber: number, commitSha: string): boolean {
    const row = this.db
      .prepare(
        "SELECT 1 FROM analyzed_commits WHERE repo = ? AND pr_number = ? AND commit_sha = ?"
      )
      .get(repo, prNumber, commitSha);
    return row !== undefined;
  }

  recordAnalyzedCommit(
    repo: string,
    prNumber: number,
    commitSha: string,
    bugCount: number
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO analyzed_commits (repo, pr_number, commit_sha, analyzed_at, bug_count)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(repo, prNumber, commitSha, new Date().toISOString(), bugCount);
  }

  getAnalyzedCommits(
    repo: string,
    prNumber: number
  ): AnalyzedCommitRecord[] {
    return this.db
      .prepare(
        "SELECT id, repo, pr_number AS prNumber, commit_sha AS commitSha, analyzed_at AS analyzedAt, bug_count AS bugCount FROM analyzed_commits WHERE repo = ? AND pr_number = ? ORDER BY id ASC"
      )
      .all(repo, prNumber) as AnalyzedCommitRecord[];
  }

  // ============================================================
  // Bugs
  // ============================================================

  saveBug(bug: BugRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO bugs (id, repo, pr_number, commit_sha, title, severity, description, file_path, start_line, end_line, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        bug.id,
        bug.repo,
        bug.prNumber,
        bug.commitSha,
        bug.title,
        bug.severity,
        bug.description,
        bug.filePath,
        bug.startLine,
        bug.endLine,
        bug.status
      );
  }

  saveBugs(bugs: BugRecord[]): void {
    const insertBug = this.db.prepare(
      `INSERT OR REPLACE INTO bugs (id, repo, pr_number, commit_sha, title, severity, description, file_path, start_line, end_line, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const insertMany = this.db.transaction((bugList: BugRecord[]) => {
      for (const bug of bugList) {
        insertBug.run(
          bug.id,
          bug.repo,
          bug.prNumber,
          bug.commitSha,
          bug.title,
          bug.severity,
          bug.description,
          bug.filePath,
          bug.startLine,
          bug.endLine,
          bug.status
        );
      }
    });

    insertMany(bugs);
  }

  getOpenBugs(repo: string, prNumber: number): BugRecord[] {
    return this.db
      .prepare(
        `SELECT id, repo, pr_number AS prNumber, commit_sha AS commitSha,
                title, severity, description, file_path AS filePath,
                start_line AS startLine, end_line AS endLine, status
         FROM bugs WHERE repo = ? AND pr_number = ? AND status = 'open'`
      )
      .all(repo, prNumber) as BugRecord[];
  }

  updateBugStatus(bugId: string, status: BugStatus): void {
    this.db
      .prepare("UPDATE bugs SET status = ? WHERE id = ?")
      .run(status, bugId);
  }

  // ============================================================
  // Fix Branches
  // ============================================================

  saveFixBranch(
    repo: string,
    prNumber: number,
    branchName: string,
    fixCommitSha: string | null
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO fix_branches (repo, pr_number, branch_name, fix_commit_sha, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`
      )
      .run(repo, prNumber, branchName, fixCommitSha, new Date().toISOString());
    return Number(result.lastInsertRowid);
  }

  getFixBranchByCommitSha(
    repo: string,
    commitSha: string
  ): FixBranchRecord | undefined {
    return this.db
      .prepare(
        `SELECT id, repo, pr_number AS prNumber, branch_name AS branchName,
                fix_commit_sha AS fixCommitSha, status, created_at AS createdAt
         FROM fix_branches WHERE repo = ? AND fix_commit_sha LIKE ?`
      )
      .get(repo, `${commitSha}%`) as FixBranchRecord | undefined;
  }

  getPendingFixBranches(
    repo: string,
    prNumber: number
  ): FixBranchRecord[] {
    return this.db
      .prepare(
        `SELECT id, repo, pr_number AS prNumber, branch_name AS branchName,
                fix_commit_sha AS fixCommitSha, status, created_at AS createdAt
         FROM fix_branches WHERE repo = ? AND pr_number = ? AND status = 'pending'`
      )
      .all(repo, prNumber) as FixBranchRecord[];
  }

  updateFixBranchStatus(id: number, status: FixStatus): void {
    this.db
      .prepare("UPDATE fix_branches SET status = ? WHERE id = ?")
      .run(status, id);
  }

  // ============================================================
  // Processed Approvals
  // ============================================================

  isApprovalProcessed(commentId: number): boolean {
    const row = this.db
      .prepare("SELECT 1 FROM processed_approvals WHERE comment_id = ?")
      .get(commentId);
    return row !== undefined;
  }

  recordProcessedApproval(
    commentId: number,
    repo: string,
    prNumber: number
  ): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO processed_approvals (comment_id, repo, pr_number, processed_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(commentId, repo, prNumber, new Date().toISOString());
  }

  // ============================================================
  // Cleanup
  // ============================================================

  close(): void {
    this.db.close();
    logger.info("State store closed.");
  }
}
