// Main entry point for Claude Code BugHunter daemon.
// Orchestrates the polling loop: discovers PRs with new commits,
// analyzes diffs for bugs, posts review comments, generates fixes,
// and processes user approval commands.
// Limitations: Single-threaded; processes PRs sequentially within
//   each polling cycle. Graceful shutdown on SIGINT/SIGTERM.

import { Analyzer } from "./analyzer.js";
import { ApprovalHandler } from "./approvalHandler.js";
import { Commenter } from "./commenter.js";
import { loadConfig } from "./config.js";
import { FixGenerator } from "./fixGenerator.js";
import { GitHubClient } from "./githubClient.js";
import { logger, setLogLevel } from "./logger.js";
import { PrMonitor } from "./prMonitor.js";
import type { PrWithNewCommits } from "./prMonitor.js";
import { StateStore } from "./state.js";
import type { BugRecord, Config, PullRequest } from "./types.js";

class BugHunterDaemon {
  private config: Config;
  private state: StateStore;
  private github!: GitHubClient;
  private prMonitor!: PrMonitor;
  private analyzer: Analyzer;
  private commenter!: Commenter;
  private fixGenerator: FixGenerator;
  private approvalHandler!: ApprovalHandler;
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dbPath);
    this.analyzer = new Analyzer(config);
    this.fixGenerator = new FixGenerator(config);
  }

  // ============================================================
  // Initialization
  // ============================================================

  async initialize(): Promise<void> {
    logger.info("Initializing Claude Code BugHunter...");
    logger.info("Configuration loaded.", {
      orgs: this.config.githubOrgs,
      repos: this.config.githubRepos,
      pollInterval: this.config.pollInterval,
      botName: this.config.botName,
      claudeModel: this.config.claudeModel ?? "(default)",
    });

    // Verify prerequisites
    await this.verifyPrerequisites();

    // Create GitHub client
    this.github = await GitHubClient.createFromGhCli();

    // Initialize modules
    this.prMonitor = new PrMonitor(this.github, this.state, this.config);
    this.commenter = new Commenter(this.github, this.config);
    this.approvalHandler = new ApprovalHandler(
      this.github,
      this.state,
      this.config
    );

    logger.info("Initialization complete. Starting daemon loop.");
  }

  // ============================================================
  // Prerequisites check
  // ============================================================

  private async verifyPrerequisites(): Promise<void> {
    const { execFile } = await import("child_process");
    const { promisify } = await import("util");
    const execFileAsync = promisify(execFile);

    // Check gh CLI
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "status"]);
      logger.debug("gh CLI auth status OK.", {
        output: stdout.substring(0, 200),
      });
    } catch (error) {
      throw new Error(
        "gh CLI is not authenticated. Run 'gh auth login' first."
      );
    }

    // Check claude CLI
    try {
      const { stdout } = await execFileAsync("claude", ["--version"]);
      logger.debug("claude CLI version.", {
        version: stdout.trim(),
      });
    } catch (error) {
      throw new Error(
        "claude CLI is not available. Install Claude Code first: https://docs.anthropic.com/en/docs/claude-code"
      );
    }

    // Check git
    try {
      await execFileAsync("git", ["--version"]);
    } catch (error) {
      throw new Error("git is not available. Install git first.");
    }
  }

  // ============================================================
  // Main polling loop
  // ============================================================

  async run(): Promise<void> {
    // Register shutdown handlers
    this.registerShutdownHandlers();

    while (!this.isShuttingDown) {
      try {
        await this.pollCycle();
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error("Error in polling cycle.", { error: message });
      }

      if (!this.isShuttingDown) {
        logger.info(
          `Sleeping for ${this.config.pollInterval}s before next cycle...`
        );
        await this.sleep(this.config.pollInterval * 1000);
      }
    }

    this.shutdown();
  }

  // ============================================================
  // Single polling cycle
  // ============================================================

  private async pollCycle(): Promise<void> {
    logger.info("Starting polling cycle...");

    // 1. Discover PRs with new commits
    const prsWithNewCommits =
      await this.prMonitor.discoverPrsWithNewCommits();

    // 2. Process each PR with new commits
    for (const prData of prsWithNewCommits) {
      if (this.isShuttingDown) break;
      await this.processPr(prData);
    }

    // 3. Process approval comments on all known PRs
    const allPrs = await this.getAllMonitoredPrs();
    for (const pr of allPrs) {
      if (this.isShuttingDown) break;
      try {
        await this.approvalHandler.processApprovals(pr);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Error processing approvals for PR #${pr.number} in ${pr.owner}/${pr.repo}.`,
          { error: message }
        );
      }
    }
  }

  // ============================================================
  // Process a single PR with new commits
  // ============================================================

  private async processPr(prData: PrWithNewCommits): Promise<void> {
    const { pr, newCommitShas, latestCommitSha } = prData;
    const repoFullName = `${pr.owner}/${pr.repo}`;

    logger.info(
      `Processing PR #${pr.number} in ${repoFullName}: "${pr.title}"`,
      { newCommits: newCommitShas.length, latestCommitSha }
    );

    // Set commit status to pending (yellow indicator)
    await this.github.createCommitStatus(
      pr.owner,
      pr.repo,
      pr.headSha,
      "pending",
      "Analyzing for bugs..."
    );

    try {
      // 1. Get the full diff
      const diff = await this.github.getPullRequestDiff(
        pr.owner,
        pr.repo,
        pr.number
      );

      // 2. Analyze diff for bugs
      const analysis = await this.analyzer.analyzeDiff(
        diff,
        pr.title,
        latestCommitSha
      );

      // 3. Record all new commits as analyzed
      for (const sha of newCommitShas) {
        this.state.recordAnalyzedCommit(
          repoFullName,
          pr.number,
          sha,
          analysis.bugs.length
        );
      }

      // 4. Update PR body with summary
      await this.commenter.updatePrSummary(pr, analysis);

      // 5. Post review comments
      await this.commenter.postReviewComments(pr, analysis);

      // 6. Save bugs to state
      if (analysis.bugs.length > 0) {
        const bugRecords: BugRecord[] = analysis.bugs.map((bug) => ({
          id: bug.id,
          repo: repoFullName,
          prNumber: pr.number,
          commitSha: latestCommitSha,
          title: bug.title,
          severity: bug.severity,
          description: bug.description,
          filePath: bug.filePath,
          startLine: bug.startLine,
          endLine: bug.endLine,
          status: "open",
        }));
        this.state.saveBugs(bugRecords);

        // Update status: bugs found, now generating fixes
        await this.github.createCommitStatus(
          pr.owner,
          pr.repo,
          pr.headSha,
          "pending",
          `Found ${analysis.bugs.length} bug(s), generating fixes...`
        );

        // 7. Generate fixes
        const fixResult = await this.fixGenerator.generateFixes(
          pr,
          analysis.bugs
        );

        if (fixResult) {
          // 8. Save fix branch to state
          this.state.saveFixBranch(
            repoFullName,
            pr.number,
            fixResult.branchName,
            fixResult.commitSha
          );

          // 9. Post autofix comment
          await this.commenter.postAutofixComment(
            pr,
            fixResult,
            this.config.botName
          );
        }

        // Set commit status to error (grey indicator) - bugs found
        await this.github.createCommitStatus(
          pr.owner,
          pr.repo,
          pr.headSha,
          "error",
          `Found ${analysis.bugs.length} bug(s)`
        );
      } else {
        // Set commit status to success (green indicator) - no bugs
        await this.github.createCommitStatus(
          pr.owner,
          pr.repo,
          pr.headSha,
          "success",
          "No bugs found"
        );
      }

      logger.info(
        `Completed processing PR #${pr.number} in ${repoFullName}.`,
        {
          bugsFound: analysis.bugs.length,
          riskLevel: analysis.riskLevel,
        }
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error(
        `Error processing PR #${pr.number} in ${repoFullName}.`,
        { error: message }
      );

      // Set commit status to error (grey indicator) - analysis failed
      await this.github.createCommitStatus(
        pr.owner,
        pr.repo,
        pr.headSha,
        "error",
        "Analysis failed"
      );
    }
  }

  // ============================================================
  // Helper: Get all monitored open PRs (for approval checking)
  // ============================================================

  private async getAllMonitoredPrs(): Promise<PullRequest[]> {
    const allPrs: PullRequest[] = [];
    const processedRepos = new Set<string>();

    for (const repoSpec of this.config.githubRepos) {
      const [owner, repo] = repoSpec.split("/");
      if (!owner || !repo) continue;
      const repoKey = `${owner}/${repo}`;
      if (processedRepos.has(repoKey)) continue;
      processedRepos.add(repoKey);

      try {
        const prs = await this.github.listOpenPullRequests(owner, repo);
        allPrs.push(...prs);
      } catch {
        // Already logged in PrMonitor
      }
    }

    for (const org of this.config.githubOrgs) {
      try {
        const repos = await this.github.listOwnerRepos(org);
        for (const repo of repos) {
          const repoKey = `${repo.owner}/${repo.name}`;
          if (processedRepos.has(repoKey)) continue;
          processedRepos.add(repoKey);

          try {
            const prs = await this.github.listOpenPullRequests(
              repo.owner,
              repo.name
            );
            allPrs.push(...prs);
          } catch {
            // Already logged in PrMonitor
          }
        }
      } catch {
        // Already logged in PrMonitor
      }
    }

    return allPrs;
  }

  // ============================================================
  // Shutdown
  // ============================================================

  private registerShutdownHandlers(): void {
    const handleShutdown = (signal: string) => {
      logger.info(`Received ${signal}. Shutting down gracefully...`);
      this.isShuttingDown = true;
    };

    process.on("SIGINT", () => handleShutdown("SIGINT"));
    process.on("SIGTERM", () => handleShutdown("SIGTERM"));
  }

  private shutdown(): void {
    this.state.close();
    logger.info("Claude Code BugHunter stopped.");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, ms);
      // Allow the sleep to be interrupted by shutdown
      const checkShutdown = setInterval(() => {
        if (this.isShuttingDown) {
          clearTimeout(timer);
          clearInterval(checkShutdown);
          resolve();
        }
      }, 1000);
    });
  }
}

// ============================================================
// Entry point
// ============================================================

async function main(): Promise<void> {
  try {
    const config = loadConfig();
    setLogLevel(config.logLevel);

    const daemon = new BugHunterDaemon(config);
    await daemon.initialize();
    await daemon.run();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    process.exit(1);
  }
}

main();
