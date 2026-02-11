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
    const riskBadge = this.formatRiskBadge(analysis.riskLevel);
    const commitShort = analysis.commitSha.substring(0, 7);
    const commitUrl = `https://github.com/${pr.owner}/${pr.repo}/commit/${analysis.commitSha}`;

    const bugCountText =
      analysis.bugs.length > 0
        ? `Found **${analysis.bugs.length} potential issue(s)**.`
        : "No issues found.";

    return `${SUMMARY_MARKER_START}

> [!NOTE]
> ${riskBadge}
>
> ${analysis.summary}
>
> ${bugCountText}
>
> <sup>Written by [Claude Code BugHunter](https://github.com/Senna46/claude-code-bughunter) for commit [${commitShort}](${commitUrl}). This will update automatically on new commits.</sup>

${SUMMARY_MARKER_END}`;
  }

  private formatRiskBadge(riskLevel: RiskLevel): string {
    const labels: Record<RiskLevel, string> = {
      low: "**Low Risk**",
      medium: "**Medium Risk**",
      high: "**High Risk**",
    };
    return labels[riskLevel];
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

    // Build review comments for bugs that have valid line numbers
    const reviewComments: Array<{
      path: string;
      line: number;
      body: string;
    }> = [];

    for (const bug of analysis.bugs) {
      const line = bug.endLine ?? bug.startLine;
      if (line && bug.filePath) {
        reviewComments.push({
          path: bug.filePath,
          line,
          body: this.buildInlineCommentBody(bug),
        });
      }
    }

    // Post bugs with line numbers as inline review comments
    if (reviewComments.length > 0) {
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
        logger.error("Failed to post review comments. Falling back to issue comment.", {
          error: message,
        });

        // Fallback: post as a single issue comment
        await this.postBugsAsIssueComment(pr, analysis);
      }
    }

    // Post bugs without line numbers as a single issue comment
    const bugsWithoutLines = analysis.bugs.filter(
      (b) => !b.startLine && !b.endLine
    );
    if (bugsWithoutLines.length > 0 && reviewComments.length > 0) {
      // These are already covered in the review; skip
    } else if (bugsWithoutLines.length > 0 && reviewComments.length === 0) {
      await this.postBugsAsIssueComment(pr, analysis);
    }
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
@${botName} push ${commitShort}
\`\`\`

<details><summary>Preview (${pr.owner}/${pr.repo}@${commitShort})</summary>

\`\`\`diff
${diffPreview}
\`\`\`

</details>
`;
  }
}
