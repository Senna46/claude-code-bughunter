// Approval handler for Claude Code BugHunter.
// Monitors PR comments for "@bughunter push <sha>" commands,
// validates the commit SHA against known fix branches, merges
// the fix into the PR branch, and adds a rocket reaction.
// Limitations: Uses GitHub merge API (not cherry-pick). If merge
//   conflicts occur, the operation fails and requires manual resolution.

import type { GitHubClient } from "./githubClient.js";
import { logger } from "./logger.js";
import type { StateStore } from "./state.js";
import type { ApprovalCommand, Config, PullRequest } from "./types.js";

export class ApprovalHandler {
  private github: GitHubClient;
  private state: StateStore;
  private config: Config;

  constructor(github: GitHubClient, state: StateStore, config: Config) {
    this.github = github;
    this.state = state;
    this.config = config;
  }

  // ============================================================
  // Main: Process approval comments for a PR
  // ============================================================

  async processApprovals(pr: PullRequest): Promise<void> {
    const repoFullName = `${pr.owner}/${pr.repo}`;

    const comments = await this.github.listIssueComments(
      pr.owner,
      pr.repo,
      pr.number
    );

    for (const comment of comments) {
      // Skip already processed comments
      if (this.state.isApprovalProcessed(comment.id)) {
        continue;
      }

      // Parse approval command
      const command = this.parseApprovalCommand(
        comment.body,
        comment.id,
        pr
      );

      if (!command) {
        continue;
      }

      logger.info("Found approval command.", {
        commentId: comment.id,
        commitSha: command.commitSha,
        author: comment.authorLogin,
        repo: repoFullName,
        prNumber: pr.number,
      });

      await this.executeApproval(pr, command);
    }
  }

  // ============================================================
  // Parse "@bughunter push <sha>" from comment body
  // ============================================================

  private parseApprovalCommand(
    body: string,
    commentId: number,
    pr: PullRequest
  ): ApprovalCommand | null {
    // Match @bughunter push <sha> (case-insensitive, flexible whitespace)
    const pattern = new RegExp(
      `@${this.escapeRegex(this.config.botName)}\\s+push\\s+([a-f0-9]{7,40})`,
      "i"
    );
    const match = body.match(pattern);

    if (!match) {
      return null;
    }

    return {
      commentId,
      prNumber: pr.number,
      repo: pr.repo,
      owner: pr.owner,
      commitSha: match[1],
      authorLogin: "", // Filled in by the caller context
    };
  }

  private escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  // ============================================================
  // Execute the approval: merge fix branch into PR branch
  // ============================================================

  private async executeApproval(
    pr: PullRequest,
    command: ApprovalCommand
  ): Promise<void> {
    const repoFullName = `${pr.owner}/${pr.repo}`;

    try {
      // Find the fix branch associated with this commit SHA
      const fixBranch = this.state.getFixBranchByCommitSha(
        repoFullName,
        command.commitSha
      );

      if (!fixBranch) {
        logger.warn(
          "Approval command references unknown commit SHA. Skipping.",
          {
            commentId: command.commentId,
            commitSha: command.commitSha,
            repo: repoFullName,
          }
        );
        // Still record as processed to avoid re-checking
        this.state.recordProcessedApproval(
          command.commentId,
          repoFullName,
          pr.number
        );
        return;
      }

      if (fixBranch.status !== "pending") {
        logger.info("Fix branch already processed.", {
          branchName: fixBranch.branchName,
          status: fixBranch.status,
        });
        this.state.recordProcessedApproval(
          command.commentId,
          repoFullName,
          pr.number
        );
        return;
      }

      // Merge the fix branch into the PR branch
      logger.info("Merging fix branch into PR branch.", {
        fixBranch: fixBranch.branchName,
        prBranch: pr.headRef,
      });

      const mergeSha = await this.github.mergeBranch(
        pr.owner,
        pr.repo,
        pr.headRef,
        fixBranch.branchName,
        `Merge BugHunter fix from ${fixBranch.branchName}`
      );

      if (mergeSha) {
        this.state.updateFixBranchStatus(fixBranch.id, "pushed");
        logger.info("Fix successfully merged into PR branch.", {
          mergeSha,
          fixBranch: fixBranch.branchName,
          prBranch: pr.headRef,
        });

        // Add rocket reaction to the approval comment
        try {
          await this.github.addReaction(
            pr.owner,
            pr.repo,
            command.commentId,
            "rocket"
          );
        } catch (reactionError) {
          // Non-critical: log and continue
          logger.debug("Failed to add rocket reaction.", {
            error:
              reactionError instanceof Error
                ? reactionError.message
                : String(reactionError),
          });
        }

        // Clean up fix branch
        try {
          await this.github.deleteBranch(
            pr.owner,
            pr.repo,
            fixBranch.branchName
          );
        } catch (deleteError) {
          // Non-critical: log and continue
          logger.debug("Failed to delete fix branch after merge.", {
            branchName: fixBranch.branchName,
            error:
              deleteError instanceof Error
                ? deleteError.message
                : String(deleteError),
          });
        }
      } else {
        this.state.updateFixBranchStatus(fixBranch.id, "failed");
        logger.error("Failed to merge fix branch. Possible merge conflict.", {
          fixBranch: fixBranch.branchName,
          prBranch: pr.headRef,
        });
      }

      // Record approval as processed
      this.state.recordProcessedApproval(
        command.commentId,
        repoFullName,
        pr.number
      );
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("Error executing approval.", {
        commentId: command.commentId,
        commitSha: command.commitSha,
        error: message,
      });
      // Record as processed to prevent retry loops
      this.state.recordProcessedApproval(
        command.commentId,
        repoFullName,
        pr.number
      );
    }
  }
}
