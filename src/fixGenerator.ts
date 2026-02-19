// Fix generation module for Claude Code BugHunter.
// Clones the target repository locally, creates a fix branch,
// runs `claude -p` with edit tools to fix detected bugs, then
// commits and pushes the fix branch.
// Limitations: Requires git CLI with push access to the target repo.
//   Claude may not fix all bugs or may introduce new issues.
//   Only one fix generation runs at a time per PR.

import { execFile, spawn } from "child_process";
import { existsSync } from "fs";
import { mkdir } from "fs/promises";
import { join } from "path";
import { randomBytes } from "crypto";
import { promisify } from "util";

import { logger } from "./logger.js";
import type { Bug, Config, FixResult, PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export class FixGenerator {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Generate fixes for detected bugs
  // ============================================================

  async generateFixes(
    pr: PullRequest,
    bugs: Bug[]
  ): Promise<FixResult | null> {
    if (bugs.length === 0) {
      logger.info("No bugs to fix.");
      return null;
    }

    const repoDir = await this.ensureRepoClone(pr);
    const branchName = this.generateFixBranchName(pr);

    try {
      // Checkout PR branch and create fix branch
      await this.prepareFixBranch(repoDir, pr, branchName);

      // Run claude -p to fix bugs
      await this.runClaudeFix(repoDir, bugs);

      // Check if there are actual changes
      const hasChanges = await this.hasUncommittedChanges(repoDir);
      if (!hasChanges) {
        logger.info("Claude did not make any changes. No fix to commit.");
        return null;
      }

      // Commit and push
      const commitSha = await this.commitAndPush(repoDir, branchName, bugs);

      // Get the diff
      const diff = await this.getDiff(repoDir, pr.headRef, branchName);

      const fixedBugs = bugs.map((bug) => ({
        bugId: bug.id,
        title: bug.title,
        description: bug.description,
      }));

      logger.info("Fix generation complete.", {
        branchName,
        commitSha: commitSha.substring(0, 10),
        fixedBugCount: fixedBugs.length,
      });

      return {
        branchName,
        commitSha,
        diff,
        fixedBugs,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("Fix generation failed.", {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        branchName,
        error: message,
      });
      return null;
    }
  }

  // ============================================================
  // Commit mode: fix bugs directly on the PR's head branch
  // ============================================================

  async generateFixesDirectCommit(
    pr: PullRequest,
    bugs: Bug[]
  ): Promise<FixResult | null> {
    if (bugs.length === 0) {
      logger.info("No bugs to fix.");
      return null;
    }

    const repoDir = await this.ensureRepoClone(pr);

    try {
      // Checkout PR's head branch directly (no fix branch)
      await this.execGit(repoDir, ["fetch", "--all", "--prune"]);
      await this.execGit(repoDir, ["checkout", `origin/${pr.headRef}`]);
      // Ensure we're on a local tracking branch
      try {
        await this.execGit(repoDir, ["checkout", pr.headRef]);
        await this.execGit(repoDir, ["reset", "--hard", `origin/${pr.headRef}`]);
      } catch {
        // Branch might not exist locally yet
        await this.execGit(repoDir, ["checkout", "-b", pr.headRef, `origin/${pr.headRef}`]);
      }

      // Run claude -p to fix bugs
      await this.runClaudeFix(repoDir, bugs);

      // Check if there are actual changes
      const hasChanges = await this.hasUncommittedChanges(repoDir);
      if (!hasChanges) {
        logger.info("Claude did not make any changes. No fix to commit.");
        return null;
      }

      // Commit and push directly to the PR's head branch
      const commitSha = await this.commitAndPush(repoDir, pr.headRef, bugs);

      // Get the diff (compare the commit with its parent)
      const diff = await this.getDiffFromLastCommit(repoDir);

      const fixedBugs = bugs.map((bug) => ({
        bugId: bug.id,
        title: bug.title,
        description: bug.description,
      }));

      logger.info("Direct commit fix complete.", {
        branch: pr.headRef,
        commitSha: commitSha.substring(0, 10),
        fixedBugCount: fixedBugs.length,
      });

      return {
        branchName: pr.headRef,
        commitSha,
        diff,
        fixedBugs,
      };
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("Direct commit fix generation failed.", {
        owner: pr.owner,
        repo: pr.repo,
        prNumber: pr.number,
        branch: pr.headRef,
        error: message,
      });
      return null;
    }
  }

  // ============================================================
  // Repository cloning and management
  // ============================================================

  async ensureRepoClone(pr: PullRequest): Promise<string> {
    await mkdir(this.config.workDir, { recursive: true });

    const repoDir = join(this.config.workDir, pr.owner, pr.repo);

    if (existsSync(join(repoDir, ".git"))) {
      // Repo exists, fetch latest
      logger.debug("Fetching latest for existing clone.", { repoDir });
      await this.execGit(repoDir, ["fetch", "--all", "--prune"]);
    } else {
      // Clone fresh
      logger.info("Cloning repository.", {
        owner: pr.owner,
        repo: pr.repo,
        repoDir,
      });
      await mkdir(join(this.config.workDir, pr.owner), { recursive: true });
      const cloneUrl = `https://github.com/${pr.owner}/${pr.repo}.git`;
      await this.execGit(this.config.workDir, [
        "clone",
        cloneUrl,
        join(pr.owner, pr.repo),
      ]);
    }

    return repoDir;
  }

  async checkoutRef(repoDir: string, ref: string): Promise<void> {
    await this.execGit(repoDir, ["checkout", "--force", "--detach", ref]);
  }

  // ============================================================
  // Branch operations
  // ============================================================

  private generateFixBranchName(pr: PullRequest): string {
    const suffix = randomBytes(2).toString("hex");
    return `bughunter/${pr.headRef}-${suffix}`;
  }

  private async prepareFixBranch(
    repoDir: string,
    pr: PullRequest,
    branchName: string
  ): Promise<void> {
    // Checkout PR branch
    await this.execGit(repoDir, ["checkout", `origin/${pr.headRef}`]);
    // Create fix branch from current HEAD
    await this.execGit(repoDir, ["checkout", "-b", branchName]);
  }

  // ============================================================
  // Run claude -p for fixing bugs
  // ============================================================

  private async runClaudeFix(repoDir: string, bugs: Bug[]): Promise<void> {
    const bugDescriptions = bugs
      .map(
        (bug, idx) =>
          `${idx + 1}. [${bug.severity.toUpperCase()}] ${bug.title}\n` +
          `   File: ${bug.filePath}${bug.startLine ? `#L${bug.startLine}` : ""}${bug.endLine ? `-L${bug.endLine}` : ""}\n` +
          `   Description: ${bug.description}`
      )
      .join("\n\n");

    const prompt = `Fix the following bugs in this codebase. Make minimal, targeted changes that address only the identified issues. Do not refactor unrelated code or change formatting.

Bugs to fix:
${bugDescriptions}

For each bug, make the necessary code changes to fix it. Commit messages are not needed - just make the file changes.`;

    const args = [
      "-p",
      "--allowedTools",
      "Read,Edit,Bash(git diff *),Bash(git status *)",
    ];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    logger.info("Running claude -p for fix generation...", {
      bugCount: bugs.length,
      repoDir,
    });

    // Pipe the prompt via stdin to avoid issues with special characters
    await new Promise<void>((resolve, reject) => {
      const child = spawn("claude", args, {
        cwd: repoDir,
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10 * 60 * 1000, // 10 minutes for fixes
      });

      let stderr = "";

      child.stdout.on("data", () => {
        // Consume stdout but don't need it
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (code !== 0) {
          reject(
            new Error(
              `claude -p fix generation exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }
        resolve();
      });

      child.on("error", (error) => {
        reject(
          new Error(`claude -p fix generation failed: ${error.message}`)
        );
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Git operations
  // ============================================================

  private async hasUncommittedChanges(repoDir: string): Promise<boolean> {
    const result = await this.execGit(repoDir, ["status", "--porcelain"]);
    return result.trim().length > 0;
  }

  private async commitAndPush(
    repoDir: string,
    branchName: string,
    bugs: Bug[]
  ): Promise<string> {
    // Stage all changes
    await this.execGit(repoDir, ["add", "-A"]);

    // Build commit message
    const bugTitles = bugs
      .map((b) => `- ${b.title}`)
      .join("\n");
    const commitMessage = `fix: BugHunter autofix\n\nFixed issues:\n${bugTitles}`;

    // Commit
    await this.execGit(repoDir, ["commit", "-m", commitMessage]);

    // Get commit SHA
    const sha = (
      await this.execGit(repoDir, ["rev-parse", "HEAD"])
    ).trim();

    // Push
    await this.execGit(repoDir, ["push", "origin", branchName]);

    return sha;
  }

  private async getDiff(
    repoDir: string,
    baseBranch: string,
    fixBranch: string
  ): Promise<string> {
    try {
      return await this.execGit(repoDir, [
        "diff",
        `origin/${baseBranch}...${fixBranch}`,
      ]);
    } catch {
      logger.warn("Failed to get diff between branches.");
      return "(diff unavailable)";
    }
  }

  private async getDiffFromLastCommit(repoDir: string): Promise<string> {
    try {
      return await this.execGit(repoDir, ["diff", "HEAD~1", "HEAD"]);
    } catch {
      logger.warn("Failed to get diff from last commit.");
      return "(diff unavailable)";
    }
  }

  private async execGit(cwd: string, args: string[]): Promise<string> {
    logger.debug(`git ${args.join(" ")}`, { cwd });
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      maxBuffer: 10 * 1024 * 1024,
      timeout: 2 * 60 * 1000, // 2 minutes for git ops
    });
    return stdout;
  }
}
