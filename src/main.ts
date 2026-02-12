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
import type { Bug, BugRecord, Config, PullRequest } from "./types.js";

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
      autofixMode: this.config.autofixMode,
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

    // Check gh CLI or GH_TOKEN availability
    const ghToken = process.env.GH_TOKEN;
    if (ghToken && ghToken.trim()) {
      // GH_TOKEN is set - format validation will be done in createFromGhCli()
      logger.debug("Using GH_TOKEN environment variable for authentication.");
    } else {
      // Fall back to gh CLI if GH_TOKEN is not set or empty/whitespace-only
      try {
        const { stdout } = await execFileAsync("gh", ["auth", "status"]);
        logger.debug("gh CLI auth status OK.", {
          output: stdout.substring(0, 200),
        });
      } catch (error) {
        throw new Error(
          "gh CLI is not authenticated. Set GH_TOKEN environment variable or run 'gh auth login'."
        );
      }
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

    // Verify Claude authentication
    if (
      !process.env.CLAUDE_CODE_OAUTH_TOKEN &&
      !process.env.ANTHROPIC_API_KEY
    ) {
      // No env-based auth; check for file-based credentials (Linux)
      const { existsSync } = await import("fs");
      const homeDir = process.env.HOME ?? "/root";
      const credFile = `${homeDir}/.claude/.credentials.json`;
      if (!existsSync(credFile)) {
        logger.warn(
          "No Claude authentication detected. " +
            "On macOS Docker, set CLAUDE_CODE_OAUTH_TOKEN (run 'claude setup-token' to generate). " +
            "On Linux, ensure ~/.claude is mounted and contains .credentials.json."
        );
      }
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

      // 5.5. Resolve existing BugHunter review threads after posting new ones
      await this.commenter.resolveExistingBugThreads(pr);

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

        // 7. Generate fixes based on autofix mode
        await this.handleAutofix(pr, analysis.bugs, repoFullName);

        // Set commit status - bugs found
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
  // Autofix mode handling
  // ============================================================

  private async handleAutofix(
    pr: PullRequest,
    bugs: Bug[],
    repoFullName: string
  ): Promise<void> {
    const mode = this.config.autofixMode;

    if (mode === "off") {
      logger.info("Autofix mode is off. Skipping fix generation.", {
        prNumber: pr.number,
        repo: repoFullName,
      });
      return;
    }

    // Update status: generating fixes
    await this.github.createCommitStatus(
      pr.owner,
      pr.repo,
      pr.headSha,
      "pending",
      `Found ${bugs.length} bug(s), generating fixes...`
    );

    if (mode === "commit") {
      // Commit directly to the PR's head branch
      const fixResult = await this.fixGenerator.generateFixesDirectCommit(
        pr,
        bugs
      );

      if (fixResult) {
        await this.commenter.postDirectCommitComment(pr, fixResult);
      }
      return;
    }

    // "branch" and "pr" modes both start by creating a fix branch
    const fixResult = await this.fixGenerator.generateFixes(pr, bugs);

    if (!fixResult) {
      return;
    }

    // Save fix branch to state
    this.state.saveFixBranch(
      repoFullName,
      pr.number,
      fixResult.branchName,
      fixResult.commitSha
    );

    if (mode === "branch") {
      // Post autofix comment with approval command
      await this.commenter.postAutofixComment(
        pr,
        fixResult,
        this.config.botName
      );
    } else if (mode === "pr") {
      // Create a new PR from the fix branch to the PR's head branch
      try {
        const bugTitles = bugs
          .slice(0, 5)
          .map((b) => `- ${b.title}`)
          .join("\n");
        const prTitle = `fix: BugHunter autofix for #${pr.number}`;
        const prBody = `Automated bug fixes for PR #${pr.number} (\`${pr.title}\`).\n\nFixed issues:\n${bugTitles}${bugs.length > 5 ? `\n- ... and ${bugs.length - 5} more` : ""}`;

        const fixPr = await this.github.createPullRequest(
          pr.owner,
          pr.repo,
          fixResult.branchName,
          pr.headRef,
          prTitle,
          prBody
        );

        logger.info("Created fix PR.", {
          fixPrNumber: fixPr.number,
          fixPrUrl: fixPr.htmlUrl,
        });

        await this.commenter.postFixPrComment(
          pr,
          fixResult,
          fixPr.number,
          fixPr.htmlUrl
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error("Failed to create fix PR.", {
          prNumber: pr.number,
          repo: repoFullName,
          error: message,
        });
      }
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
