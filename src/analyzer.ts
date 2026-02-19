// Bug analysis module for Claude Code BugHunter.
// Implements parallel analysis with majority voting (inspired by Cursor Bugbot).
// Uses `claude -p` CLI to analyze PR diffs for bugs, security issues,
// and code quality problems. Returns structured results via JSON schema.
// Limitations: Depends on claude CLI being installed and authenticated.
//   Large diffs may be truncated to stay within context limits.

import { spawn } from "child_process";
import { randomUUID } from "crypto";

import { logger } from "./logger.js";
import {
  createBugSimilarityKeys,
  createNullSentinelKey,
  type AnalysisResult,
  type Bug,
  type BugRecord,
  type ClaudeAnalysisOutput,
  type Config,
  type RiskLevel,
} from "./types.js";

// JSON schema for structured bug analysis output from claude -p
const BUG_ANALYSIS_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string", description: "Short, descriptive title of the bug" },
          severity: {
            type: "string",
            enum: ["low", "medium", "high", "critical"],
            description: "Bug severity level",
          },
          description: {
            type: "string",
            description: "Detailed explanation of the bug and its impact",
          },
          filePath: { type: "string", description: "File path where the bug is located" },
          startLine: {
            type: "integer",
            description: "Start line number in the diff (if identifiable)",
          },
          endLine: {
            type: "integer",
            description: "End line number in the diff (if identifiable)",
          },
        },
        required: ["title", "severity", "description", "filePath"],
      },
    },
    overview: {
      type: "string",
      description:
        "Concise description of what the PR changes and their purpose. Focus on what was changed and why, not on bugs found.",
    },
    summary: {
      type: "string",
      description: "Brief summary of bugs found and their potential risks",
    },
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Overall risk level of the changes",
    },
  },
  required: ["bugs", "overview", "summary", "riskLevel"],
});

// More aggressive prompt for bug detection (inspired by Cursor Bugbot's approach)
const ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer and bug hunter. Your task is to analyze a PR diff and identify real bugs, security vulnerabilities, and significant code quality issues.

Rules:
- Focus on actual bugs that would cause incorrect behavior, crashes, security issues, or data loss.
- Do NOT report style issues, formatting preferences, or minor nits.
- Do NOT report issues that are clearly intentional design decisions.
- Each bug must reference a specific file and, when possible, specific line numbers from the diff.
- When full source files are provided, use them to understand the complete context (function flow, async/await semantics, type definitions, call sites) rather than guessing from the diff alone.
- When previously reported bugs are listed, follow these rules strictly:
  - Do NOT re-report bugs that have already been fixed by subsequent commits.
  - Do NOT suggest reversing a previous fix unless there is a clear new bug introduced by it.
  - If a previously reported bug is still present, you may reference it but do not duplicate it.
  - Focus on NEW issues not covered by previous findings.
- Severity guidelines:
  - critical: Security vulnerabilities, data loss, crashes in production
  - high: Incorrect business logic, race conditions, resource leaks
  - medium: Edge cases not handled, inconsistent behavior, i18n issues
  - low: Minor issues unlikely to cause problems in practice
- Be precise and concise in descriptions.
- If no real bugs are found, return an empty bugs array.

IMPORTANT: Be thorough and investigate any suspicious patterns. It is better to flag potential issues that can be filtered out later than to miss real bugs.`;

// Interface for a single analysis pass result
interface AnalysisPassResult {
  passIndex: number;
  output: ClaudeAnalysisOutput;
  error?: Error;
}

// Interface for bug with vote count
interface BugWithVotes {
  bug: Bug;
  voteCount: number;
  passIndices: number[];
}

// Parses a unified diff and returns unique file paths that were modified.
// Matches lines starting with "+++ b/" (the new-file header in unified diff format).
// Lines referencing /dev/null (deleted files) are excluded naturally since git
// uses "+++ /dev/null" for them, not "+++ b/".
export function extractChangedFilePaths(diff: string): string[] {
  const filePaths: string[] = [];

  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      filePaths.push(line.substring(6));
    }
  }

  // Deduplicate while preserving order
  return [...new Set(filePaths)];
}

export class Analyzer {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Analyze a PR diff for bugs with parallel passes
  // ============================================================

  async analyzeDiff(
    diff: string,
    prTitle: string,
    commitSha: string,
    previousBugs?: BugRecord[],
    fileContents?: Map<string, string>,
    customRulesText?: string
  ): Promise<AnalysisResult> {
    // Truncate diff if too large
    const truncatedDiff = this.truncateDiff(diff);

    // Truncate file contents if total size exceeds the limit
    const truncatedFileContents = fileContents
      ? this.truncateFileContents(fileContents)
      : undefined;

    const numPasses = this.config.analysisPasses;
    const voteThreshold = this.config.voteThreshold;

    logger.info("Starting parallel bug analysis via claude -p ...", {
      diffLength: truncatedDiff.length,
      originalDiffLength: diff.length,
      wasTruncated: diff.length !== truncatedDiff.length,
      previousBugCount: previousBugs?.length ?? 0,
      fileContextCount: truncatedFileContents?.size ?? 0,
      hasCustomRules: Boolean(customRulesText),
      numPasses,
      voteThreshold,
    });

    // Run parallel analysis passes with randomized diff ordering
    const passResults = await this.runParallelAnalysisPasses(
      truncatedDiff,
      prTitle,
      previousBugs,
      truncatedFileContents,
      numPasses,
      customRulesText
    );

    // Log pass results summary
    const successfulPasses = passResults.filter((r) => !r.error);
    const failedPasses = passResults.filter((r) => r.error);
    logger.info(`Analysis passes completed: ${successfulPasses.length}/${numPasses} successful`, {
      successfulPasses: successfulPasses.length,
      failedPasses: failedPasses.length,
      bugsPerPass: successfulPasses.map((r) => r.output.bugs.length),
    });

    if (successfulPasses.length === 0) {
      // All passes failed - return empty result
      return {
        bugs: [],
        overview: "All analysis passes failed.",
        summary: "All analysis passes failed.",
        rawSummary: "All analysis passes failed.",
        riskLevel: "low",
        commitSha,
        analyzedAt: new Date().toISOString(),
      };
    }

    // Apply majority voting to filter bugs
    const votedBugs = this.applyMajorityVoting(passResults, voteThreshold);

    // Combine overviews and summaries from successful passes
    const combinedResult = this.combinePassResults(passResults, votedBugs, commitSha);

    logger.info(`Analysis complete: ${votedBugs.length} bug(s) found after majority voting.`, {
      commitSha: commitSha.substring(0, 10),
      riskLevel: combinedResult.riskLevel,
      rawBugCount: successfulPasses.reduce((sum, r) => sum + r.output.bugs.length, 0),
      votedBugCount: votedBugs.length,
    });

    return combinedResult;
  }

  // ============================================================
  // Run parallel analysis passes with randomized diff ordering
  // ============================================================

  private async runParallelAnalysisPasses(
    diff: string,
    prTitle: string,
    previousBugs: BugRecord[] | undefined,
    fileContents: Map<string, string> | undefined,
    numPasses: number,
    customRulesText?: string
  ): Promise<AnalysisPassResult[]> {
    // Create randomized diff variants for each pass
    const diffVariants = this.createRandomizedDiffVariants(diff, numPasses);

    // Run all passes in parallel
    const passPromises = diffVariants.map((randomizedDiff, index) =>
      this.runSingleAnalysisPass(
        randomizedDiff,
        prTitle,
        previousBugs,
        fileContents,
        index,
        customRulesText
      )
    );

    return Promise.all(passPromises);
  }

  // ============================================================
  // Create randomized diff variants by shuffling file hunks
  // ============================================================

  private createRandomizedDiffVariants(diff: string, numVariants: number): string[] {
    // Split diff into file-level hunks
    const fileHunks = this.splitDiffIntoFileHunks(diff);
    
    if (fileHunks.length <= 1) {
      // Only one file or empty diff - return same diff for all variants
      return Array(numVariants).fill(diff);
    }

    const variants: string[] = [];
    for (let i = 0; i < numVariants; i++) {
      // Create a shuffled copy with a different seed each time
      const shuffled = this.shuffleArrayWithSeed([...fileHunks], i + 1);
      variants.push(shuffled.join("\n"));
    }

    return variants;
  }

  // Split diff into file-level hunks
  private splitDiffIntoFileHunks(diff: string): string[] {
    const lines = diff.split("\n");
    const hunks: string[] = [];
    let currentHunk: string[] = [];

    for (const line of lines) {
      if (line.startsWith("diff --git") && currentHunk.length > 0) {
        hunks.push(currentHunk.join("\n"));
        currentHunk = [];
      }
      currentHunk.push(line);
    }

    if (currentHunk.length > 0) {
      hunks.push(currentHunk.join("\n"));
    }

    return hunks;
  }

  // Fisher-Yates shuffle with seed for reproducibility
  private shuffleArrayWithSeed<T>(array: T[], seed: number): T[] {
    const result = [...array];
    let m = result.length;
    
    // Simple seeded random number generator
    const random = () => {
      seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff;
      return seed / 0x80000000;
    };

    while (m > 1) {
      const i = Math.floor(random() * m);
      m--;
      [result[m], result[i]] = [result[i], result[m]];
    }

    return result;
  }

  // ============================================================
  // Run a single analysis pass
  // ============================================================

  private async runSingleAnalysisPass(
    diff: string,
    prTitle: string,
    previousBugs: BugRecord[] | undefined,
    fileContents: Map<string, string> | undefined,
    passIndex: number,
    customRulesText?: string
  ): Promise<AnalysisPassResult> {
    try {
      const prompt = this.buildAnalysisPrompt(
        diff,
        prTitle,
        previousBugs,
        fileContents,
        customRulesText
      );

      const output = await this.runClaudeAnalysis(prompt);

      logger.debug(`Pass ${passIndex} completed: ${output.bugs.length} bug(s) found`);

      return { passIndex, output };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Pass ${passIndex} failed: ${message}`);
      return {
        passIndex,
        output: {
          bugs: [],
          overview: "Analysis pass failed.",
          summary: "Analysis pass failed.",
          riskLevel: "low",
        },
        error: error instanceof Error ? error : new Error(message),
      };
    }
  }

  // ============================================================
  // Apply majority voting to filter bugs
  // ============================================================

  private applyMajorityVoting(
    passResults: AnalysisPassResult[],
    voteThreshold: number
  ): Bug[] {
    const successfulResults = passResults.filter((r) => !r.error);
    
    if (successfulResults.length === 0) {
      return [];
    }

    // Warn if pass failures have made the vote threshold unreachable.
    // Even though config.ts validates voteThreshold <= analysisPasses at startup,
    // failures at runtime can reduce the effective pass count below the threshold,
    // which would silently discard every detected bug.
    if (successfulResults.length < voteThreshold) {
      logger.warn(
        `Vote threshold is unreachable: only ${successfulResults.length} pass(es) succeeded but voteThreshold is ${voteThreshold}. ` +
          `All bugs detected in this analysis will be discarded. ` +
          `Consider lowering BUGHUNTER_VOTE_THRESHOLD or investigating why passes are failing.`
      );
      return [];
    }

    // Collect all bugs from all passes and group similar ones.
    // keyAlias maps every candidate key (primary + shifted) to the canonical key
    // stored in bugVotes, so that boundary-straddling reports are merged correctly.
    const bugVotes = new Map<string, BugWithVotes>();
    const keyAlias = new Map<string, string>();

    for (const result of successfulResults) {
      for (const bugData of result.output.bugs) {
        const bug: Bug = {
          id: randomUUID(),
          title: bugData.title,
          severity: bugData.severity,
          description: bugData.description,
          filePath: bugData.filePath,
          startLine: bugData.startLine ?? null,
          endLine: bugData.endLine ?? null,
        };

        // Generate primary + optional shifted key to tolerate bucket-boundary splits.
        // For line-based bugs this returns only line-bucket keys (no null sentinel)
        // so that two different bugs in the same file with similar titles are never
        // aliased together through the null sentinel.
        const candidateKeys = createBugSimilarityKeys(bug);

        // Find any existing canonical key via the alias map
        let canonicalKey: string | undefined;
        for (const key of candidateKeys) {
          const alias = keyAlias.get(key);
          if (alias !== undefined) {
            canonicalKey = alias;
            break;
          }
        }

        // Fallback for line-based bugs: if no match was found through line-bucket
        // keys, check the null sentinel.  Merge only when the existing entry was
        // created by a null-line bug so that two genuinely different line-based
        // bugs are never aliased together.
        if (canonicalKey === undefined && bug.startLine !== null) {
          const nullKey = createNullSentinelKey(bug);
          const nullAlias = keyAlias.get(nullKey);
          if (nullAlias !== undefined) {
            const existingEntry = bugVotes.get(nullAlias);
            if (existingEntry && existingEntry.bug.startLine === null) {
              canonicalKey = nullAlias;
            }
          }
        }

        if (canonicalKey !== undefined) {
          const existing = bugVotes.get(canonicalKey)!;
          // Only count one vote per pass to ensure voteThreshold requires independent agreement
          if (!existing.passIndices.includes(result.passIndex)) {
            existing.voteCount++;
            existing.passIndices.push(result.passIndex);
          }
          // Prefer line-based bug details over null-line placeholder
          if (existing.bug.startLine === null && bug.startLine !== null) {
            existing.bug = bug;
          }
          // Register any new candidate keys as additional aliases so that
          // later reports at nearby lines can still find this entry.
          for (const key of candidateKeys) {
            if (!keyAlias.has(key)) {
              keyAlias.set(key, canonicalKey);
            }
          }
        } else {
          // New entry: register the first candidate key as canonical
          canonicalKey = candidateKeys[0];
          bugVotes.set(canonicalKey, {
            bug,
            voteCount: 1,
            passIndices: [result.passIndex],
          });
          // Register all candidate keys as aliases pointing to the canonical key
          for (const key of candidateKeys) {
            keyAlias.set(key, canonicalKey);
          }
        }

        // For line-based bugs, register the null-sentinel key as an alias
        // (when not already taken) so that a later null-line report of the
        // same bug can still be matched.
        if (bug.startLine !== null) {
          const nullKey = createNullSentinelKey(bug);
          if (!keyAlias.has(nullKey)) {
            keyAlias.set(nullKey, canonicalKey);
          }
        }
      }
    }

    // Filter by vote threshold and return
    const votedBugs: Bug[] = [];
    for (const [, bugWithVotes] of bugVotes) {
      if (bugWithVotes.voteCount >= voteThreshold) {
        // Use the bug from the first pass that found it
        votedBugs.push(bugWithVotes.bug);
        logger.debug(`Bug "${bugWithVotes.bug.title}" passed voting: ${bugWithVotes.voteCount} votes from passes ${bugWithVotes.passIndices.join(", ")}`);
      }
    }

    return votedBugs;
  }

  // ============================================================
  // Combine results from multiple passes
  // ============================================================

  private combinePassResults(
    passResults: AnalysisPassResult[],
    votedBugs: Bug[],
    commitSha: string
  ): AnalysisResult {
    const successfulResults = passResults.filter((r) => !r.error);
    
    if (successfulResults.length === 0) {
      return {
        bugs: [],
        overview: "All analysis passes failed.",
        summary: "All analysis passes failed.",
        rawSummary: "All analysis passes failed.",
        riskLevel: "low",
        commitSha,
        analyzedAt: new Date().toISOString(),
      };
    }

    // Use the first successful pass for overview and summary
    // (they should be similar across passes)
    const firstResult = successfulResults[0].output;

    // Calculate overall risk level based on voted bugs
    const riskLevel = this.calculateRiskLevel(votedBugs);

    return {
      bugs: votedBugs,
      overview: firstResult.overview,
      // summary is the display string with voting prefix; rawSummary preserves the
      // original Claude text so buildAnalysisMeta callers can pass it without
      // re-prepending the voting prefix a second time.
      summary: this.buildSummaryFromVotedBugs(votedBugs, firstResult.summary),
      rawSummary: firstResult.summary,
      riskLevel,
      commitSha,
      analyzedAt: new Date().toISOString(),
    };
  }

  // ============================================================
  // Rebuild summary and riskLevel from a final bug list.
  // Used after agentic merging or validation changes the bug set,
  // so that these metadata fields stay consistent with bugs.length.
  // ============================================================

  buildAnalysisMeta(bugs: Bug[], originalSummary = ""): { summary: string; riskLevel: RiskLevel } {
    return {
      summary: this.buildSummaryFromVotedBugs(bugs, originalSummary),
      riskLevel: this.calculateRiskLevel(bugs),
    };
  }

  // ============================================================
  // Calculate overall risk level from voted bugs
  // ============================================================

  private calculateRiskLevel(bugs: Bug[]): "low" | "medium" | "high" {
    if (bugs.length === 0) {
      return "low";
    }

    const hasCritical = bugs.some((b) => b.severity === "critical");
    const hasHigh = bugs.some((b) => b.severity === "high");
    const criticalOrHighCount = bugs.filter(
      (b) => b.severity === "critical" || b.severity === "high"
    ).length;

    if (hasCritical || criticalOrHighCount >= 2) {
      return "high";
    }
    if (hasHigh || bugs.length >= 3) {
      return "medium";
    }
    return "low";
  }

  // ============================================================
  // Build summary from voted bugs
  // ============================================================

  private buildSummaryFromVotedBugs(bugs: Bug[], originalSummary: string): string {
    if (bugs.length === 0) {
      // Prefer the original Claude summary when no bugs survived voting,
      // as it may contain useful "no issues found" context.
      return originalSummary.trim() !== ""
        ? originalSummary
        : "No bugs found after majority voting.";
    }

    const severityCounts = {
      critical: bugs.filter((b) => b.severity === "critical").length,
      high: bugs.filter((b) => b.severity === "high").length,
      medium: bugs.filter((b) => b.severity === "medium").length,
      low: bugs.filter((b) => b.severity === "low").length,
    };

    const parts: string[] = [];
    if (severityCounts.critical > 0) {
      parts.push(`${severityCounts.critical} critical`);
    }
    if (severityCounts.high > 0) {
      parts.push(`${severityCounts.high} high`);
    }
    if (severityCounts.medium > 0) {
      parts.push(`${severityCounts.medium} medium`);
    }
    if (severityCounts.low > 0) {
      parts.push(`${severityCounts.low} low`);
    }

    const votingSummary = `Found ${bugs.length} bug(s) after majority voting: ${parts.join(", ")} severity.`;

    // Append the original Claude summary as additional context when available.
    if (originalSummary.trim() !== "") {
      return `${votingSummary} ${originalSummary}`;
    }

    return votingSummary;
  }

  // ============================================================
  // Build the analysis prompt
  // ============================================================

  private buildAnalysisPrompt(
    diff: string,
    prTitle: string,
    previousBugs?: BugRecord[],
    fileContents?: Map<string, string>,
    customRulesText?: string
  ): string {
    const sections: string[] = [];

    sections.push(
      `Analyze the following pull request diff for bugs, security issues, and code quality problems.`
    );
    sections.push(`PR Title: ${prTitle}`);

    // Include custom rules so Claude can reason about project-specific constraints
    if (customRulesText) {
      sections.push(customRulesText);
    }

    // Include full source files for deeper context
    if (fileContents && fileContents.size > 0) {
      const fileContextLines: string[] = [
        "Full source of changed files (for context — use these to understand the complete code flow, async/await semantics, type definitions, and how the changed code interacts with the rest of the codebase):",
      ];
      for (const [filePath, content] of fileContents) {
        fileContextLines.push(`\n=== ${filePath} ===`);
        fileContextLines.push(content);
        fileContextLines.push(`=== END ${filePath} ===`);
      }
      sections.push(fileContextLines.join("\n"));
    }

    // Include the diff
    sections.push(`\`\`\`diff\n${diff}\n\`\`\``);

    // Include previously reported bugs to avoid flip-flopping
    if (previousBugs && previousBugs.length > 0) {
      const bugLines: string[] = [
        "Previously reported bugs (from prior analysis of this PR):",
      ];
      for (let i = 0; i < previousBugs.length; i++) {
        const bug = previousBugs[i];
        const location = bug.startLine
          ? `${bug.filePath}#L${bug.startLine}${bug.endLine ? `-L${bug.endLine}` : ""}`
          : bug.filePath;
        bugLines.push(
          `${i + 1}. [${bug.severity.toUpperCase()}] "${bug.title}" (${location})`
        );
        bugLines.push(`   - ${bug.description}`);
      }
      bugLines.push("");
      bugLines.push(
        "When reviewing, consider:",
        "- Do NOT re-report bugs that have already been fixed by subsequent commits.",
        "- Do NOT suggest reversing a previous fix unless there is a clear new bug introduced by it.",
        "- If a previously reported bug is still present, you may reference it but do not duplicate.",
        "- Focus on NEW issues not covered by previous findings."
      );
      sections.push(bugLines.join("\n"));
    }

    sections.push(
      "Write a clear and concise overview of what this PR changes and why. Then identify all real bugs and return your findings as structured JSON."
    );

    return sections.join("\n\n");
  }

  // ============================================================
  // Truncate file contents to stay within the configured limit
  // ============================================================

  private truncateFileContents(
    fileContents: Map<string, string>
  ): Map<string, string> {
    const maxSize = this.config.maxFileContextSize;
    let totalSize = 0;

    for (const content of fileContents.values()) {
      totalSize += content.length;
    }

    if (totalSize <= maxSize) {
      return fileContents;
    }

    logger.warn(
      `File context total size (${totalSize} chars) exceeds max (${maxSize}). Excluding largest files.`
    );

    // Sort files by size ascending so we keep smaller files first
    const entries = [...fileContents.entries()].sort(
      (a, b) => a[1].length - b[1].length
    );

    const result = new Map<string, string>();
    let currentSize = 0;

    for (const [filePath, content] of entries) {
      if (currentSize + content.length > maxSize) {
        logger.debug(`Excluding large file from context: ${filePath} (${content.length} chars)`);
        continue;
      }
      result.set(filePath, content);
      currentSize += content.length;
    }

    return result;
  }

  // ============================================================
  // Run claude -p with JSON schema output
  // ============================================================

  private async runClaudeAnalysis(
    prompt: string
  ): Promise<ClaudeAnalysisOutput> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      BUG_ANALYSIS_SCHEMA,
      "--append-system-prompt",
      ANALYSIS_SYSTEM_PROMPT,
    ];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    // Pipe the prompt via stdin to avoid issues with large diffs
    // containing special characters in CLI arguments
    return new Promise<ClaudeAnalysisOutput>((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 5 * 60 * 1000, // 5 minutes
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("close", (code) => {
        if (stderr) {
          logger.debug("claude -p stderr output.", {
            stderr: stderr.substring(0, 500),
          });
        }

        if (code !== 0) {
          reject(
            new Error(
              `claude -p exited with code ${code}. stderr: ${stderr.substring(0, 500)}`
            )
          );
          return;
        }

        try {
          const result = this.parseClaudeJsonOutput(stdout);
          resolve(result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse claude output: ${message}`));
        }
      });

      child.on("error", (error) => {
        reject(
          new Error(
            `claude -p analysis failed. Ensure 'claude' CLI is installed and authenticated. Error: ${error.message}`
          )
        );
      });

      // Write prompt to stdin and close it
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Parse claude JSON output
  // ============================================================

  private parseClaudeJsonOutput(stdout: string): ClaudeAnalysisOutput {
    try {
      // claude --output-format json wraps the result in a JSON envelope
      // with fields like: { result, session_id, ... }
      // The structured_output field contains our schema-conforming data
      const envelope = JSON.parse(stdout);

      // Try structured_output first (when --json-schema is used)
      if (envelope.structured_output) {
        return this.validateAnalysisOutput(envelope.structured_output);
      }

      // Fall back to parsing the result field as JSON
      if (envelope.result) {
        const parsed = JSON.parse(envelope.result);
        return this.validateAnalysisOutput(parsed);
      }

      // Direct parse attempt
      return this.validateAnalysisOutput(envelope);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse claude analysis output.", {
        error: message,
        stdoutPreview: stdout.substring(0, 500),
      });

      // Return empty result on parse failure
      return {
        bugs: [],
        overview: "Analysis output could not be parsed.",
        summary: "Analysis output could not be parsed.",
        riskLevel: "low",
      };
    }
  }

  private validateAnalysisOutput(data: unknown): ClaudeAnalysisOutput {
    const output = data as ClaudeAnalysisOutput;
    if (!output || !Array.isArray(output.bugs)) {
      throw new Error("Invalid analysis output: 'bugs' array is missing.");
    }
    if (!output.overview || typeof output.overview !== "string") {
      output.overview = "No overview provided.";
    }
    if (!output.summary || typeof output.summary !== "string") {
      output.summary = "No summary provided.";
    }
    if (!["low", "medium", "high"].includes(output.riskLevel)) {
      output.riskLevel = "low";
    }
    return output;
  }

  // ============================================================
  // Diff truncation
  // ============================================================

  private truncateDiff(diff: string): string {
    if (diff.length <= this.config.maxDiffSize) {
      return diff;
    }

    logger.warn(
      `Diff size (${diff.length} chars) exceeds max (${this.config.maxDiffSize}). Truncating.`
    );

    // Try to truncate at a file boundary
    const truncated = diff.substring(0, this.config.maxDiffSize);
    const lastDiffHeader = truncated.lastIndexOf("\ndiff --git");
    if (lastDiffHeader > 0) {
      return (
        truncated.substring(0, lastDiffHeader) +
        "\n\n[... diff truncated due to size ...]"
      );
    }

    return truncated + "\n\n[... diff truncated due to size ...]";
  }
}
