// PR monitoring module for Claude Code BugHunter.
// Discovers open PRs across configured organizations and repositories,
// detects new commits that haven't been analyzed yet, and returns
// PRs that need processing.
// Limitations: Relies on polling; does not use webhooks.

import type { Config, PullRequest } from "./types.js";
import type { GitHubClient } from "./githubClient.js";
import type { StateStore } from "./state.js";
import { logger } from "./logger.js";

export interface PrWithNewCommits {
  pr: PullRequest;
  newCommitShas: string[];
  latestCommitSha: string;
}

export class PrMonitor {
  private github: GitHubClient;
  private state: StateStore;
  private config: Config;

  constructor(github: GitHubClient, state: StateStore, config: Config) {
    this.github = github;
    this.state = state;
    this.config = config;
  }

  // ============================================================
  // Main: Discover PRs with unanalyzed commits
  // ============================================================

  async discoverPrsWithNewCommits(): Promise<PrWithNewCommits[]> {
    const allPrs = await this.getAllOpenPrs();
    logger.info(`Found ${allPrs.length} open PR(s) across all targets.`);

    const results: PrWithNewCommits[] = [];

    for (const pr of allPrs) {
      try {
        const prWithCommits = await this.checkForNewCommits(pr);
        if (prWithCommits) {
          results.push(prWithCommits);
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Error checking PR #${pr.number} in ${pr.owner}/${pr.repo} for new commits.`,
          { error: message }
        );
      }
    }

    return results;
  }

  // ============================================================
  // Gather all open PRs from configured orgs and repos
  // ============================================================

  private async getAllOpenPrs(): Promise<PullRequest[]> {
    const allPrs: PullRequest[] = [];
    const processedRepos = new Set<string>();

    // Specific repos first (higher priority)
    for (const repoSpec of this.config.githubRepos) {
      const [owner, repo] = repoSpec.split("/");
      if (!owner || !repo) {
        logger.warn(`Invalid repo spec: "${repoSpec}". Expected "owner/repo" format.`);
        continue;
      }

      const repoKey = `${owner}/${repo}`;
      if (processedRepos.has(repoKey)) continue;
      processedRepos.add(repoKey);

      try {
        const prs = await this.github.listOpenPullRequests(owner, repo);
        allPrs.push(...prs);
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list PRs for ${repoKey}.`, {
          error: message,
        });
      }
    }

    // Then orgs
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
          } catch (error) {
            const message =
              error instanceof Error ? error.message : String(error);
            logger.error(`Failed to list PRs for ${repoKey}.`, {
              error: message,
            });
          }
        }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : String(error);
        logger.error(`Failed to list repos for org "${org}".`, {
          error: message,
        });
      }
    }

    return allPrs;
  }

  // ============================================================
  // Check a single PR for unanalyzed commits
  // ============================================================

  private async checkForNewCommits(
    pr: PullRequest
  ): Promise<PrWithNewCommits | null> {
    const repoFullName = `${pr.owner}/${pr.repo}`;

    const commits = await this.github.getPullRequestCommits(
      pr.owner,
      pr.repo,
      pr.number
    );

    if (commits.length === 0) {
      return null;
    }

    const newCommitShas: string[] = [];
    for (const commit of commits) {
      if (!this.state.isCommitAnalyzed(repoFullName, pr.number, commit.sha)) {
        newCommitShas.push(commit.sha);
      }
    }

    if (newCommitShas.length === 0) {
      logger.debug(`PR #${pr.number} in ${repoFullName}: No new commits.`);
      return null;
    }

    const latestCommitSha = commits[commits.length - 1].sha;

    logger.info(
      `PR #${pr.number} in ${repoFullName}: ${newCommitShas.length} new commit(s) detected.`,
      { latestCommitSha }
    );

    return {
      pr,
      newCommitShas,
      latestCommitSha,
    };
  }
}
