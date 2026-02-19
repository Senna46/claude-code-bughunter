// Main entry point for Claude Code BugHunter daemon.
// Orchestrates the polling loop: discovers PRs with new commits,
// analyzes diffs for bugs, posts review comments, generates fixes,
// and processes user approval commands.
// Limitations: Single-threaded; processes PRs sequentially within
//   each polling cycle. Graceful shutdown on SIGINT/SIGTERM.

import { AgenticAnalyzer } from "./agenticAnalyzer.js";
import { Analyzer, extractChangedFilePaths } from "./analyzer.js";
import { ApprovalHandler } from "./approvalHandler.js";
import { Commenter } from "./commenter.js";
import { loadConfig } from "./config.js";
import { CustomRulesManager } from "./customRules.js";
import { DynamicContextManager } from "./dynamicContext.js";
import { FixGenerator } from "./fixGenerator.js";
import { GitHubClient } from "./githubClient.js";
import { logger, setLogLevel } from "./logger.js";
import { PrMonitor } from "./prMonitor.js";
import type { PrWithNewCommits } from "./prMonitor.js";
import { StateStore } from "./state.js";
import {
  createBugSimilarityKeys,
  createNullSentinelKey,
  type Bug,
  type BugRecord,
  type Config,
  type PullRequest,
} from "./types.js";
import { BugValidator } from "./validator.js";

class BugHunterDaemon {
  private config: Config;
  private state: StateStore;
  private github!: GitHubClient;
  private prMonitor!: PrMonitor;
  private analyzer: Analyzer;
  private agenticAnalyzer: AgenticAnalyzer;
  private commenter!: Commenter;
  private fixGenerator: FixGenerator;
  private approvalHandler!: ApprovalHandler;
  private validator: BugValidator;
  private customRulesManager: CustomRulesManager;
  private isShuttingDown = false;

  constructor(config: Config) {
    this.config = config;
    this.state = new StateStore(config.dbPath);
    this.analyzer = new Analyzer(config);
    this.agenticAnalyzer = new AgenticAnalyzer(config);
    this.fixGenerator = new FixGenerator(config);
    this.validator = new BugValidator(config);
    this.customRulesManager = new CustomRulesManager(config);
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
      analysisPasses: this.config.analysisPasses,
      voteThreshold: this.config.voteThreshold,
      enableValidator: this.config.enableValidator,
      enableAgenticAnalysis: this.config.enableAgenticAnalysis,
      enableDynamicContext: this.config.enableDynamicContext,
    });

    // Log custom rules
    const rules = this.customRulesManager.getRules();
    logger.info(`Loaded ${rules.length} custom rules`, {
      ruleCount: rules.length,
      ruleIds: rules.slice(0, 5).map((r) => r.id),
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
        const message = error instanceof Error ? error.message : String(error);
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
    const prsWithNewCommits = await this.prMonitor.discoverPrsWithNewCommits();

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
        const message = error instanceof Error ? error.message : String(error);
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

      // 1.5. Gather context for deeper analysis
      // Retrieve previously reported bugs to avoid flip-flopping
      const previousBugs = this.state.getOpenBugs(repoFullName, pr.number);
      if (previousBugs.length > 0) {
        logger.info(
          `Found ${previousBugs.length} previously reported bug(s) to include as context.`,
          { repo: repoFullName, prNumber: pr.number }
        );
      }

      // 1.6. Dynamic context discovery (or fall back to pre-fetching)
      let fileContents: Map<string, string>;

      if (this.config.enableDynamicContext) {
        // Use dynamic context discovery for token-efficient context loading
        const contextManager = new DynamicContextManager(
          this.config,
          pr.owner,
          pr.repo,
          pr.headSha,
          async (owner, repo, filePath, ref) => {
            return this.github.getFileContent(owner, repo, filePath, ref);
          }
        );

        // Extract suspicious patterns from diff for prioritization
        const suspiciousPatterns =
          DynamicContextManager.extractSuspiciousPatterns(diff);

        // Get context on-demand
        fileContents = await contextManager.getContextForDiff(
          diff,
          suspiciousPatterns
        );

        if (fileContents.size > 0) {
          logger.info(
            `Dynamic context discovery loaded ${fileContents.size} file(s).`,
            {
              filePaths: [...fileContents.keys()],
              suspiciousPatterns: suspiciousPatterns.slice(0, 5),
            }
          );
        }
      } else {
        // Fall back to pre-fetching all changed files
        // Parallelize independent HTTP requests to reduce total latency
        const changedFilePaths = extractChangedFilePaths(diff);
        fileContents = new Map<string, string>();
        const fileContentResults = await Promise.allSettled(
          changedFilePaths.map((filePath) =>
            this.github
              .getFileContent(pr.owner, pr.repo, filePath, pr.headSha)
              .then((content) => ({ filePath, content }))
          )
        );
        for (const result of fileContentResults) {
          if (result.status === "fulfilled" && result.value.content !== null) {
            fileContents.set(result.value.filePath, result.value.content);
          } else if (result.status === "rejected") {
            logger.warn(`Failed to fetch file content: ${result.reason}`);
          }
        }
        if (fileContents.size > 0) {
          logger.info(
            `Pre-fetched ${fileContents.size} file(s) as analysis context.`,
            { filePaths: [...fileContents.keys()] }
          );
        }
      }

      // 2. Build the formatted rules string so Claude can reason about built-in rules.
      const customRulesText =
        this.customRulesManager.formatRulesForPrompt() || undefined;

      // 2.1. Analyze diff for bugs (with previous findings, file context, and built-in rules)
      let analysis = await this.analyzer.analyzeDiff(
        diff,
        pr.title,
        latestCommitSha,
        previousBugs.length > 0 ? previousBugs : undefined,
        fileContents.size > 0 ? fileContents : undefined,
        customRulesText
      );

      // 2.3. Run agentic analysis if enabled (for deeper investigation)
      if (this.config.enableAgenticAnalysis) {
        logger.info("Running agentic analysis for deeper investigation...");
        try {
          const repoPath = await this.fixGenerator.ensureRepoClone(pr);
          await this.fixGenerator.checkoutRef(repoPath, pr.headSha);
          const agenticAnalysis = await this.agenticAnalyzer.analyzeDiff(
            diff,
            pr.title,
            latestCommitSha,
            repoPath,
            previousBugs.length > 0 ? previousBugs : undefined,
            customRulesText
          );

          // Merge results from both analyses
          const mergedBugs = this.mergeBugResults(
            analysis.bugs,
            agenticAnalysis.bugs
          );
          logger.info(
            `Agentic analysis merged: ${analysis.bugs.length} + ${agenticAnalysis.bugs.length} -> ${mergedBugs.length} bugs`
          );
          // Pass rawSummary (the original Claude text without voting prefix) so that
          // buildAnalysisMeta does not double-prepend the "Found N bug(s)" prefix.
          const mergedMeta = this.analyzer.buildAnalysisMeta(
            mergedBugs,
            analysis.rawSummary
          );
          analysis = {
            ...analysis,
            bugs: mergedBugs,
            summary: mergedMeta.summary,
            riskLevel: mergedMeta.riskLevel,
          };
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          logger.warn(
            `Agentic analysis failed, continuing with standard analysis: ${message}`
          );
        }
      }

      // 2.5. Validate bugs to reduce false positives
      // Spread to a new array so that later push() calls never mutate analysis.bugs,
      // regardless of whether the validator is enabled.
      let validatedBugs = [...analysis.bugs];
      if (this.config.enableValidator && analysis.bugs.length > 0) {
        logger.info(`Validating ${analysis.bugs.length} detected bug(s)...`);
        validatedBugs = await this.validator.validateBugs(
          analysis.bugs,
          diff,
          fileContents.size > 0 ? fileContents : undefined
        );
        logger.info(
          `Validation complete: ${validatedBugs.length} bug(s) confirmed`,
          {
            originalCount: analysis.bugs.length,
            validatedCount: validatedBugs.length,
          }
        );
      }

      // 2.6. Check against built-in rules (regex-based detection).
      const ruleBugs: Bug[] = [];
      for (const [filePath, content] of fileContents) {
        const bugsFromRules = this.customRulesManager.checkAgainstRules(
          content,
          filePath,
          diff
        );
        ruleBugs.push(...bugsFromRules);
      }

      if (ruleBugs.length > 0) {
        logger.info(`Found ${ruleBugs.length} bug(s) from built-in rules`, {
          ruleBugCount: ruleBugs.length,
        });
        validatedBugs = this.mergeBugResults(validatedBugs, ruleBugs);
      }

      // Update analysis with validated bugs, recomputing summary/riskLevel
      // so they reflect the final bug count rather than the pre-validation set.
      // Pass rawSummary (the original Claude text without voting prefix) so that
      // buildAnalysisMeta does not double-prepend the "Found N bug(s)" prefix.
      const validatedMeta = this.analyzer.buildAnalysisMeta(
        validatedBugs,
        analysis.rawSummary
      );
      const validatedAnalysis = {
        ...analysis,
        bugs: validatedBugs,
        summary: validatedMeta.summary,
        riskLevel: validatedMeta.riskLevel,
      };

      // 3. Record all new commits as analyzed
      for (const sha of newCommitShas) {
        this.state.recordAnalyzedCommit(
          repoFullName,
          pr.number,
          sha,
          validatedAnalysis.bugs.length
        );
      }

      // 4. Update PR body with summary
      await this.commenter.updatePrSummary(pr, validatedAnalysis);

      // 4.5. Resolve existing BugHunter review threads before posting new ones
      await this.commenter.resolveExistingBugThreads(pr);

      // 5. Post review comments
      await this.commenter.postReviewComments(pr, validatedAnalysis);

      // 6. Save bugs to state
      if (validatedAnalysis.bugs.length > 0) {
        const bugRecords: BugRecord[] = validatedAnalysis.bugs.map((bug) => ({
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
        await this.handleAutofix(pr, validatedAnalysis.bugs, repoFullName);

        // Set commit status - bugs found
        await this.github.createCommitStatus(
          pr.owner,
          pr.repo,
          pr.headSha,
          "error",
          `Found ${validatedAnalysis.bugs.length} bug(s)`
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

      logger.info(`Completed processing PR #${pr.number} in ${repoFullName}.`, {
        bugsFound: validatedAnalysis.bugs.length,
        riskLevel: validatedAnalysis.riskLevel,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error(`Error processing PR #${pr.number} in ${repoFullName}.`, {
        error: message,
      });

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
        const prBody = `Automated bug fixes for PR #${pr.number} (\`${
          pr.title
        }\`).\n\nFixed issues:\n${bugTitles}${
          bugs.length > 5 ? `\n- ... and ${bugs.length - 5} more` : ""
        }`;

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
        const message = error instanceof Error ? error.message : String(error);
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

  // ============================================================
  // Merge bug results from multiple analysis methods
  // ============================================================

  private mergeBugResults(bugs1: Bug[], bugs2: Bug[]): Bug[] {
    const merged: Bug[] = [...bugs1];

    // Seed seenKeys with all candidate keys (primary + shifted) from bugs1
    // so that boundary-adjacent duplicates in bugs2 are correctly detected.
    // Also register null-sentinel keys so that null-line duplicates from
    // bugs2 are correctly caught without re-introducing false aliasing
    // between different line-based bugs.
    const seenKeys = new Set<string>();
    // Track null-sentinel keys that originated from null-line bugs specifically.
    // This mirrors the applyMajorityVoting fallback: we only alias a line-based
    // bug in bugs2 to a null-sentinel key when the existing entry was a null-line
    // bug, preventing two genuinely different line-based bugs from being aliased.
    const nullOriginKeys = new Set<string>();
    for (const b of bugs1) {
      for (const key of createBugSimilarityKeys(b)) {
        seenKeys.add(key);
      }
      seenKeys.add(createNullSentinelKey(b));
      if (b.startLine === null) {
        nullOriginKeys.add(createNullSentinelKey(b));
      }
    }

    for (const bug of bugs2) {
      const candidateKeys = createBugSimilarityKeys(bug);
      let alreadySeen = candidateKeys.some((k) => seenKeys.has(k));

      // Fallback: if no line-bucket key matched and this bug has a startLine,
      // check whether bugs1 contains the same bug reported without a line number.
      // Only alias to null-origin keys to avoid merging two different line-based
      // bugs that happen to share the same file and title prefix.
      if (!alreadySeen && bug.startLine !== null) {
        const nullKey = createNullSentinelKey(bug);
        alreadySeen = nullOriginKeys.has(nullKey);
      }

      if (!alreadySeen) {
        merged.push(bug);
        for (const key of candidateKeys) {
          seenKeys.add(key);
        }
        seenKeys.add(createNullSentinelKey(bug));
        if (bug.startLine === null) {
          nullOriginKeys.add(createNullSentinelKey(bug));
        }
      }
    }

    return merged;
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
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[FATAL] ${message}`);
    process.exit(1);
  }
}

main();
