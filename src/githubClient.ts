// GitHub API client for Claude Code BugHunter.
// Wraps Octokit to provide typed operations for PR management:
// listing PRs, fetching diffs/commits, posting reviews/comments,
// and managing branches. Uses gh CLI auth token for authentication.
// Limitations: Rate limiting is handled by Octokit's built-in throttling.

import { execFile } from "child_process";
import { Octokit } from "octokit";
import { promisify } from "util";

import { logger } from "./logger.js";
import { validateGitHubToken } from "./tokenValidator.js";
import type { PrCommit, PullRequest } from "./types.js";

const execFileAsync = promisify(execFile);

export class GitHubClient {
  private octokit: Octokit;

  constructor(token?: string) {
    this.octokit = new Octokit({
      auth: token,
    });
  }

  // ============================================================
  // Factory: Create client using gh CLI auth token
  // ============================================================

  static async createFromGhCli(): Promise<GitHubClient> {
    // First, check if GH_TOKEN environment variable is set (required for Docker on macOS)
    const envToken = process.env.GH_TOKEN;
    const validationError = validateGitHubToken(envToken);

    if (envToken && !validationError) {
      logger.info("GitHub client authenticated via GH_TOKEN environment variable.");
      return new GitHubClient(envToken.trim());
    }

    // If token is present but invalid, throw error without exposing token value
    if (envToken && validationError) {
      throw new Error(validationError);
    }

    // Fall back to gh CLI token (works on Linux and native installs)
    try {
      const { stdout } = await execFileAsync("gh", ["auth", "token"]);
      const token = stdout.trim();
      if (!token) {
        throw new Error("gh auth token returned empty string.");
      }
      logger.info("GitHub client authenticated via gh CLI.");
      return new GitHubClient(token);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      throw new Error(
        `Failed to get GitHub token. Set GH_TOKEN environment variable or run 'gh auth login'. Error: ${message}`
      );
    }
  }

  // ============================================================
  // Pull Requests
  // ============================================================

  async listOpenPullRequests(
    owner: string,
    repo: string
  ): Promise<PullRequest[]> {
    logger.debug("Listing open PRs.", { owner, repo });

    const { data } = await this.octokit.rest.pulls.list({
      owner,
      repo,
      state: "open",
      sort: "updated",
      direction: "desc",
      per_page: 100,
    });

    return data.map((pr) => ({
      owner,
      repo,
      number: pr.number,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      headRef: pr.head.ref,
      baseRef: pr.base.ref,
      headSha: pr.head.sha,
      authorLogin: pr.user?.login ?? "unknown",
      htmlUrl: pr.html_url,
    }));
  }

  async listOwnerRepos(owner: string): Promise<Array<{ owner: string; name: string }>> {
    logger.debug("Listing repos for owner.", { owner });

    const repos: Array<{ owner: string; name: string }> = [];

    // Try listing as a user first, then fall back to org
    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForUser,
        { username: owner, per_page: 100, type: "owner" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for user "${owner}".`);
      return repos;
    } catch (userError) {
      logger.debug(`Failed to list repos as user "${owner}", trying as org...`, {
        error: userError instanceof Error ? userError.message : String(userError),
      });
    }

    // Fall back to org API
    try {
      for await (const response of this.octokit.paginate.iterator(
        this.octokit.rest.repos.listForOrg,
        { org: owner, per_page: 100, type: "all" }
      )) {
        for (const repo of response.data) {
          repos.push({ owner, name: repo.name });
        }
      }
      logger.debug(`Found ${repos.length} repo(s) for org "${owner}".`);
    } catch (orgError) {
      logger.error(`Failed to list repos for "${owner}" as both user and org.`, {
        error: orgError instanceof Error ? orgError.message : String(orgError),
      });
    }

    return repos;
  }

  async getPullRequestDiff(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<string> {
    logger.debug("Fetching PR diff.", { owner, repo, prNumber });

    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: prNumber,
      mediaType: { format: "diff" },
    });

    // When format is "diff", data is returned as a string
    return data as unknown as string;
  }

  async getPullRequestCommits(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<PrCommit[]> {
    logger.debug("Fetching PR commits.", { owner, repo, prNumber });

    const { data } = await this.octokit.rest.pulls.listCommits({
      owner,
      repo,
      pull_number: prNumber,
      per_page: 250,
    });

    return data.map((commit) => ({
      sha: commit.sha,
      message: commit.commit.message,
      authorLogin: commit.author?.login ?? commit.commit.author?.name ?? "unknown",
      date: commit.commit.committer?.date ?? commit.commit.author?.date ?? "",
    }));
  }

  // ============================================================
  // PR Body (Description) Updates
  // ============================================================

  async updatePullRequestBody(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<void> {
    logger.debug("Updating PR body.", { owner, repo, prNumber });

    await this.octokit.rest.pulls.update({
      owner,
      repo,
      pull_number: prNumber,
      body,
    });
  }

  // ============================================================
  // Reviews & Comments
  // ============================================================

  async createReview(
    owner: string,
    repo: string,
    prNumber: number,
    commitSha: string,
    body: string,
    comments: Array<{
      path: string;
      line: number;
      body: string;
    }>
  ): Promise<number> {
    logger.debug("Creating PR review.", {
      owner,
      repo,
      prNumber,
      commentCount: comments.length,
    });

    const { data } = await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: prNumber,
      commit_id: commitSha,
      body,
      event: "COMMENT",
      comments: comments.map((c) => ({
        path: c.path,
        line: c.line,
        body: c.body,
      })),
    });

    return data.id;
  }

  async createIssueComment(
    owner: string,
    repo: string,
    prNumber: number,
    body: string
  ): Promise<number> {
    logger.debug("Creating issue comment.", { owner, repo, prNumber });

    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: prNumber,
      body,
    });

    return data.id;
  }

  async updateIssueComment(
    owner: string,
    repo: string,
    commentId: number,
    body: string
  ): Promise<void> {
    logger.debug("Updating issue comment.", { owner, repo, commentId });

    await this.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  }

  async listIssueComments(
    owner: string,
    repo: string,
    prNumber: number
  ): Promise<
    Array<{
      id: number;
      body: string;
      authorLogin: string;
      createdAt: string;
    }>
  > {
    logger.debug("Listing issue comments.", { owner, repo, prNumber });

    const { data } = await this.octokit.rest.issues.listComments({
      owner,
      repo,
      issue_number: prNumber,
      per_page: 100,
    });

    return data.map((comment) => ({
      id: comment.id,
      body: comment.body ?? "",
      authorLogin: comment.user?.login ?? "unknown",
      createdAt: comment.created_at,
    }));
  }

  async addReaction(
    owner: string,
    repo: string,
    commentId: number,
    reaction: "+1" | "-1" | "laugh" | "confused" | "heart" | "hooray" | "rocket" | "eyes"
  ): Promise<void> {
    logger.debug("Adding reaction to comment.", {
      owner,
      repo,
      commentId,
      reaction,
    });

    await this.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content: reaction,
    });
  }

  // ============================================================
  // Branches
  // ============================================================

  async getBranch(
    owner: string,
    repo: string,
    branch: string
  ): Promise<{ sha: string; ref: string } | null> {
    try {
      const { data } = await this.octokit.rest.git.getRef({
        owner,
        repo,
        ref: `heads/${branch}`,
      });
      return { sha: data.object.sha, ref: data.ref };
    } catch {
      return null;
    }
  }

  async createBranch(
    owner: string,
    repo: string,
    branchName: string,
    fromSha: string
  ): Promise<void> {
    logger.debug("Creating branch.", { owner, repo, branchName, fromSha });

    await this.octokit.rest.git.createRef({
      owner,
      repo,
      ref: `refs/heads/${branchName}`,
      sha: fromSha,
    });
  }

  async deleteBranch(
    owner: string,
    repo: string,
    branchName: string
  ): Promise<void> {
    logger.debug("Deleting branch.", { owner, repo, branchName });

    try {
      await this.octokit.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branchName}`,
      });
    } catch {
      logger.warn("Failed to delete branch (may not exist).", {
        owner,
        repo,
        branchName,
      });
    }
  }

  // ============================================================
  // Pull Request creation (for "pr" autofix mode)
  // ============================================================

  async createPullRequest(
    owner: string,
    repo: string,
    head: string,
    base: string,
    title: string,
    body: string
  ): Promise<{ number: number; htmlUrl: string }> {
    logger.debug("Creating pull request.", {
      owner,
      repo,
      head,
      base,
      title,
    });

    const { data } = await this.octokit.rest.pulls.create({
      owner,
      repo,
      head,
      base,
      title,
      body,
    });

    return {
      number: data.number,
      htmlUrl: data.html_url,
    };
  }

  // ============================================================
  // Commit Status (for PR status indicators)
  // ============================================================

  async createCommitStatus(
    owner: string,
    repo: string,
    sha: string,
    state: "error" | "failure" | "pending" | "success",
    description: string,
    context: string = "Claude Code BugHunter"
  ): Promise<void> {
    logger.debug("Creating commit status.", {
      owner,
      repo,
      sha: sha.substring(0, 10),
      state,
      description,
      context,
    });

    try {
      await this.octokit.rest.repos.createCommitStatus({
        owner,
        repo,
        sha,
        state,
        description,
        context,
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      // Non-critical: log and continue (don't block the main workflow)
      logger.warn("Failed to create commit status.", {
        owner,
        repo,
        sha: sha.substring(0, 10),
        state,
        error: message,
      });
    }
  }

  // ============================================================
  // Merge / Cherry-pick via API (merge commit approach)
  // ============================================================

  async mergeBranch(
    owner: string,
    repo: string,
    base: string,
    head: string,
    commitMessage: string
  ): Promise<string | null> {
    logger.debug("Merging branch.", { owner, repo, base, head });

    try {
      const { data } = await this.octokit.rest.repos.merge({
        owner,
        repo,
        base,
        head,
        commit_message: commitMessage,
      });
      return data.sha;
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("Failed to merge branch.", {
        owner,
        repo,
        base,
        head,
        error: message,
      });
      return null;
    }
  }
}
