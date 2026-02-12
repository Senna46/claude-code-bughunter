// PR commenting module for Claude Code BugHunter.
// Handles all GitHub PR comment operations:
// - Updating PR body with analysis summary (using marker comments)
// - Posting inline review comments for each detected bug
// - Posting autofix comments with diff previews and push commands
// Limitations: PR body update replaces the summary section only;
//   existing user content outside markers is preserved.

import type { GitHubClient } from "./githubClient.js";
import { logger } from "./logger.js";
import type {
  AnalysisResult,
  Bug,
  BugSeverity,
  Config,
  FixResult,
  PullRequest,
  RiskLevel,
} from "./types.js";

// Markers for identifying BugHunter-managed sections
const SUMMARY_MARKER_START = "<!-- BUGHUNTER_SUMMARY_START -->";
const SUMMARY_MARKER_END = "<!-- BUGHUNTER_SUMMARY_END -->";
const AUTOFIX_MARKER = "<!-- BUGHUNTER_AUTOFIX_COMMENT -->";
const BUG_ID_PREFIX = "<!-- BUGHUNTER_BUG_ID:";

export class Commenter {
  private github: GitHubClient;
  private config: Config;

  constructor(github: GitHubClient, config: Config) {
    this.github = github;
    this.config = config;
  }

  // ============================================================
  // PR Body Summary Update
  // ============================================================

  async updatePrSummary(
    pr: PullRequest,
    analysis: AnalysisResult
  ): Promise<void> {
    logger.info("Updating PR body with analysis summary.", {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
    });

    const summaryBlock = this.buildSummaryBlock(analysis, pr);
    const currentBody = pr.body ?? "";

    let newBody: string;
    if (
      currentBody.includes(SUMMARY_MARKER_START) &&
      currentBody.includes(SUMMARY_MARKER_END)
    ) {
      // Replace existing summary
      const startIdx = currentBody.indexOf(SUMMARY_MARKER_START);
      const endIdx =
        currentBody.indexOf(SUMMARY_MARKER_END) + SUMMARY_MARKER_END.length;
      newBody =
        currentBody.substring(0, startIdx) +
        summaryBlock +
        currentBody.substring(endIdx);
    } else {
      // Append summary at the end
      newBody = currentBody + "\n\n" + summaryBlock;
    }

    await this.github.updatePullRequestBody(
      pr.owner,
      pr.repo,
      pr.number,
      newBody
    );
  }

  private buildSummaryBlock(
    analysis: AnalysisResult,
    pr: PullRequest
  ): string {
    const commitShort = analysis.commitSha.substring(0, 7);
    const commitUrl = `https://github.com/${pr.owner}/${pr.repo}/commit/${analysis.commitSha}`;

    const bugCountText =
      analysis.bugs.length > 0
        ? `Found **${analysis.bugs.length} potential issue(s)**.`
        : "No issues found.";

    return `${SUMMARY_MARKER_START}

> [!NOTE]
> **Overview**
> ${analysis.overview}
>
> ${bugCountText}
>
> <sup>Written by [Claude Code BugHunter](https://github.com/Senna46/claude-code-bughunter) for commit [${commitShort}](${commitUrl}). This will update automatically on new commits.</sup>

${SUMMARY_MARKER_END}`;
  }

  // ============================================================
  // Resolve Existing BugHunter Review Threads
  // ============================================================

  async resolveExistingBugThreads(pr: PullRequest): Promise<number> {
    logger.info("Checking for existing BugHunter review threads to resolve.", {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
    });

    const threads = await this.github.getReviewThreads(
      pr.owner,
      pr.repo,
      pr.number
    );

    // Filter for unresolved threads that contain the BugHunter bug ID marker
    const bugHunterThreads = threads.filter(
      (thread) =>
        !thread.isResolved && thread.firstCommentBody.includes(BUG_ID_PREFIX)
    );

    if (bugHunterThreads.length === 0) {
      logger.debug("No unresolved BugHunter review threads found.");
      return 0;
    }

    logger.info(
      `Found ${bugHunterThreads.length} unresolved BugHunter review thread(s) to resolve.`
    );

    let resolvedCount = 0;
    for (const thread of bugHunterThreads) {
      try {
        const resolved = await this.github.resolveReviewThread(thread.id);
        if (resolved) {
          resolvedCount++;
        }
      } catch (error) {
        // Log and continue — one failure should not block other resolutions
        const message =
          error instanceof Error ? error.message : String(error);
        logger.warn("Failed to resolve a BugHunter review thread.", {
          threadId: thread.id,
          error: message,
        });
      }
    }

    logger.info(
      `Resolved ${resolvedCount}/${bugHunterThreads.length} BugHunter review thread(s).`
    );

    return resolvedCount;
  }

  // ============================================================
  // Inline Review Comments
  // ============================================================

  async postReviewComments(
    pr: PullRequest,
    analysis: AnalysisResult
  ): Promise<void> {
    if (analysis.bugs.length === 0) {
      logger.info("No bugs to post as review comments.");
      return;
    }

    // Parse the diff to extract valid file paths and line ranges
    const diff = await this.github.getPullRequestDiff(
      pr.owner,
      pr.repo,
      pr.number
    );
    const validRanges = this.parseDiffLineRanges(diff);

    // Separate bugs into inline-eligible and fallback
    const inlineBugs: Bug[] = [];
    const fallbackBugs: Bug[] = [];

    for (const bug of analysis.bugs) {
      const line = bug.endLine ?? bug.startLine;
      if (line && bug.filePath && this.isLineInDiff(bug.filePath, line, validRanges)) {
        inlineBugs.push(bug);
      } else {
        fallbackBugs.push(bug);
      }
    }

    // Post inline bugs as a PR review
    if (inlineBugs.length > 0) {
      const reviewComments = inlineBugs.map((bug) => ({
        path: bug.filePath,
        line: (bug.endLine ?? bug.startLine)!,
        body: this.buildInlineCommentBody(bug),
      }));

      const reviewBody = this.buildReviewSummaryBody(analysis);

      try {
        await this.github.createReview(
          pr.owner,
          pr.repo,
          pr.number,
          analysis.commitSha,
          reviewBody,
          reviewComments
        );
        logger.info(
          `Posted review with ${reviewComments.length} inline comment(s).`
        );
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error("Failed to post inline review. Falling back to issue comment for all bugs.", {
          error: message,
          inlineBugCount: inlineBugs.length,
        });
        // Move all inline bugs to fallback
        fallbackBugs.push(...inlineBugs);
      }
    }

    // Post remaining bugs as an issue comment
    if (fallbackBugs.length > 0) {
      const fallbackAnalysis: AnalysisResult = {
        ...analysis,
        bugs: fallbackBugs,
      };
      await this.postBugsAsIssueComment(pr, fallbackAnalysis);
      logger.info(
        `Posted ${fallbackBugs.length} bug(s) as issue comment (not in diff range).`
      );
    }
  }

  // Parse diff to extract valid file + line ranges that can receive inline comments
  private parseDiffLineRanges(diff: string): Map<string, Array<{ start: number; end: number }>> {
    const ranges = new Map<string, Array<{ start: number; end: number }>>();
    let currentFile: string | null = null;

    for (const line of diff.split("\n")) {
      // Match diff file header: +++ b/path/to/file
      if (line.startsWith("+++ b/")) {
        currentFile = line.substring(6);
        if (!ranges.has(currentFile)) {
          ranges.set(currentFile, []);
        }
        continue;
      }

      // Match hunk header: @@ -oldStart,oldCount +newStart,newCount @@
      if (currentFile && line.startsWith("@@")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/);
        if (match) {
          const start = parseInt(match[1], 10);
          const count = match[2] !== undefined ? parseInt(match[2], 10) : 1;
          const end = start + count - 1;
          ranges.get(currentFile)!.push({ start, end: Math.max(start, end) });
        }
      }
    }

    return ranges;
  }

  // Check if a specific line in a file falls within the diff ranges
  private isLineInDiff(
    filePath: string,
    line: number,
    validRanges: Map<string, Array<{ start: number; end: number }>>
  ): boolean {
    const fileRanges = validRanges.get(filePath);
    if (!fileRanges) {
      return false;
    }
    return fileRanges.some((range) => line >= range.start && line <= range.end);
  }

  private buildReviewSummaryBody(analysis: AnalysisResult): string {
    const count = analysis.bugs.length;
    return `Claude Code BugHunter has reviewed your changes and found ${count} potential issue(s).`;
  }

  private buildInlineCommentBody(bug: Bug): string {
    const severityBadge = this.formatSeverityBadge(bug.severity);

    return `### ${bug.title}

${severityBadge}

${BUG_ID_PREFIX} ${bug.id} -->

${bug.description}`;
  }

  private formatSeverityBadge(severity: BugSeverity): string {
    const labels: Record<BugSeverity, string> = {
      critical: "**Critical Severity** :rotating_light:",
      high: "**High Severity** :warning:",
      medium: "**Medium Severity** :large_orange_diamond:",
      low: "**Low Severity** :information_source:",
    };
    return labels[severity];
  }

  // Fallback: post all bugs as a single issue comment
  private async postBugsAsIssueComment(
    pr: PullRequest,
    analysis: AnalysisResult
  ): Promise<void> {
    const bugSections = analysis.bugs
      .map((bug) => {
        const severityBadge = this.formatSeverityBadge(bug.severity);
        const location = bug.startLine
          ? `\`${bug.filePath}#L${bug.startLine}${bug.endLine ? `-L${bug.endLine}` : ""}\``
          : `\`${bug.filePath}\``;

        return `### ${bug.title}

${severityBadge}

${BUG_ID_PREFIX} ${bug.id} -->

**Location:** ${location}

${bug.description}`;
      })
      .join("\n\n---\n\n");

    const body = `Claude Code BugHunter found **${analysis.bugs.length} potential issue(s)** in commit \`${analysis.commitSha.substring(0, 7)}\`:

${bugSections}`;

    await this.github.createIssueComment(
      pr.owner,
      pr.repo,
      pr.number,
      body
    );
  }

  // ============================================================
  // Autofix Comment
  // ============================================================

  async postAutofixComment(
    pr: PullRequest,
    fixResult: FixResult,
    botName: string
  ): Promise<number> {
    logger.info("Posting autofix comment.", {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
      fixedBugCount: fixResult.fixedBugs.length,
    });

    const body = this.buildAutofixCommentBody(pr, fixResult, botName);
    const commentId = await this.github.createIssueComment(
      pr.owner,
      pr.repo,
      pr.number,
      body
    );

    return commentId;
  }

  // ============================================================
  // Direct Commit Comment (for "commit" autofix mode)
  // ============================================================

  async postDirectCommitComment(
    pr: PullRequest,
    fixResult: FixResult
  ): Promise<number> {
    logger.info("Posting direct commit comment.", {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
      fixedBugCount: fixResult.fixedBugs.length,
    });

    const body = this.buildDirectCommitCommentBody(pr, fixResult);
    const commentId = await this.github.createIssueComment(
      pr.owner,
      pr.repo,
      pr.number,
      body
    );

    return commentId;
  }

  // ============================================================
  // Fix PR Comment (for "pr" autofix mode)
  // ============================================================

  async postFixPrComment(
    pr: PullRequest,
    fixResult: FixResult,
    fixPrNumber: number,
    fixPrUrl: string
  ): Promise<number> {
    logger.info("Posting fix PR comment.", {
      owner: pr.owner,
      repo: pr.repo,
      prNumber: pr.number,
      fixPrNumber,
    });

    const body = this.buildFixPrCommentBody(pr, fixResult, fixPrNumber, fixPrUrl);
    const commentId = await this.github.createIssueComment(
      pr.owner,
      pr.repo,
      pr.number,
      body
    );

    return commentId;
  }

  // ============================================================
  // Comment body builders
  // ============================================================

  private buildAutofixCommentBody(
    pr: PullRequest,
    fixResult: FixResult,
    botName: string
  ): string {
    const commitShort = fixResult.commitSha.substring(0, 10);

    // Fixed bugs list
    const fixedList = fixResult.fixedBugs
      .map((fb) => `- :white_check_mark: Fixed: **${fb.title}**\n  - ${fb.description}`)
      .join("\n");

    // Compare URL for creating a PR from fix branch to PR branch
    const compareUrl = `https://github.com/${pr.owner}/${pr.repo}/compare/${pr.headRef}...${fixResult.branchName}?expand=1`;

    // Diff preview
    const diffPreview = fixResult.diff.length > 10000
      ? fixResult.diff.substring(0, 10000) + "\n... diff truncated ..."
      : fixResult.diff;

    return `${AUTOFIX_MARKER}
[BugHunter Autofix](https://github.com/Senna46/claude-code-bughunter) prepared fixes for ${fixResult.fixedBugs.length} of the bug(s) found in the latest run.

${fixedList}


[Create PR](${compareUrl})

Or push these changes by commenting:
\`\`\`
/${botName} push ${commitShort}
\`\`\`

<details><summary>Preview (${pr.owner}/${pr.repo}@${commitShort})</summary>

\`\`\`diff
${diffPreview}
\`\`\`

</details>
`;
  }

  private buildDirectCommitCommentBody(
    pr: PullRequest,
    fixResult: FixResult
  ): string {
    const commitShort = fixResult.commitSha.substring(0, 10);

    const fixedList = fixResult.fixedBugs
      .map((fb) => `- :white_check_mark: Fixed: **${fb.title}**\n  - ${fb.description}`)
      .join("\n");

    const diffPreview = fixResult.diff.length > 10000
      ? fixResult.diff.substring(0, 10000) + "\n... diff truncated ..."
      : fixResult.diff;

    const commitUrl = `https://github.com/${pr.owner}/${pr.repo}/commit/${fixResult.commitSha}`;

    return `${AUTOFIX_MARKER}
[BugHunter Autofix](https://github.com/Senna46/claude-code-bughunter) committed fixes directly to \`${pr.headRef}\` ([${commitShort}](${commitUrl})).

${fixedList}

<details><summary>Changes (${pr.owner}/${pr.repo}@${commitShort})</summary>

\`\`\`diff
${diffPreview}
\`\`\`

</details>
`;
  }

  private buildFixPrCommentBody(
    pr: PullRequest,
    fixResult: FixResult,
    fixPrNumber: number,
    fixPrUrl: string
  ): string {
    const fixedList = fixResult.fixedBugs
      .map((fb) => `- :white_check_mark: Fixed: **${fb.title}**\n  - ${fb.description}`)
      .join("\n");

    const diffPreview = fixResult.diff.length > 10000
      ? fixResult.diff.substring(0, 10000) + "\n... diff truncated ..."
      : fixResult.diff;

    return `${AUTOFIX_MARKER}
[BugHunter Autofix](https://github.com/Senna46/claude-code-bughunter) created a fix PR: [#${fixPrNumber}](${fixPrUrl})

${fixedList}

<details><summary>Changes</summary>

\`\`\`diff
${diffPreview}
\`\`\`

</details>
`;
  }
}
