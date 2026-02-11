// Bug analysis module for Claude Code BugHunter.
// Uses `claude -p` CLI to analyze PR diffs for bugs, security issues,
// and code quality problems. Returns structured results via JSON schema.
// Limitations: Depends on claude CLI being installed and authenticated.
//   Large diffs may be truncated to stay within context limits.

import { spawn } from "child_process";
import { randomUUID } from "crypto";

import { logger } from "./logger.js";
import type {
  AnalysisResult,
  Bug,
  ClaudeAnalysisOutput,
  Config,
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
    summary: {
      type: "string",
      description: "Brief overview of changes and potential risks",
    },
    riskLevel: {
      type: "string",
      enum: ["low", "medium", "high"],
      description: "Overall risk level of the changes",
    },
  },
  required: ["bugs", "summary", "riskLevel"],
});

const ANALYSIS_SYSTEM_PROMPT = `You are a senior code reviewer and bug hunter. Your task is to analyze a PR diff and identify real bugs, security vulnerabilities, and significant code quality issues.

Rules:
- Focus on actual bugs that would cause incorrect behavior, crashes, security issues, or data loss.
- Do NOT report style issues, formatting preferences, or minor nits.
- Do NOT report issues that are clearly intentional design decisions.
- Each bug must reference a specific file and, when possible, specific line numbers from the diff.
- Severity guidelines:
  - critical: Security vulnerabilities, data loss, crashes in production
  - high: Incorrect business logic, race conditions, resource leaks
  - medium: Edge cases not handled, inconsistent behavior, i18n issues
  - low: Minor issues unlikely to cause problems in practice
- Be precise and concise in descriptions.
- If no real bugs are found, return an empty bugs array.`;

export class Analyzer {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Analyze a PR diff for bugs
  // ============================================================

  async analyzeDiff(
    diff: string,
    prTitle: string,
    commitSha: string
  ): Promise<AnalysisResult> {
    // Truncate diff if too large
    const truncatedDiff = this.truncateDiff(diff);

    const prompt = this.buildAnalysisPrompt(truncatedDiff, prTitle);

    logger.info("Starting bug analysis via claude -p ...", {
      diffLength: truncatedDiff.length,
      originalDiffLength: diff.length,
      wasTruncated: diff.length !== truncatedDiff.length,
    });

    const claudeOutput = await this.runClaudeAnalysis(prompt);
    const bugs = this.parseAnalysisOutput(claudeOutput, commitSha);

    logger.info(`Analysis complete: ${bugs.length} bug(s) found.`, {
      commitSha: commitSha.substring(0, 10),
      riskLevel: claudeOutput.riskLevel,
    });

    return {
      bugs,
      summary: claudeOutput.summary,
      riskLevel: claudeOutput.riskLevel,
      commitSha,
      analyzedAt: new Date().toISOString(),
    };
  }

  // ============================================================
  // Build the analysis prompt
  // ============================================================

  private buildAnalysisPrompt(diff: string, prTitle: string): string {
    return `Analyze the following pull request diff for bugs, security issues, and code quality problems.

PR Title: ${prTitle}

\`\`\`diff
${diff}
\`\`\`

Identify all real bugs and return your findings as structured JSON.`;
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
    if (!output.summary || typeof output.summary !== "string") {
      output.summary = "No summary provided.";
    }
    if (!["low", "medium", "high"].includes(output.riskLevel)) {
      output.riskLevel = "low";
    }
    return output;
  }

  // ============================================================
  // Convert claude output to Bug models
  // ============================================================

  private parseAnalysisOutput(
    output: ClaudeAnalysisOutput,
    commitSha: string
  ): Bug[] {
    return output.bugs.map((bug) => ({
      id: randomUUID(),
      title: bug.title,
      severity: bug.severity,
      description: bug.description,
      filePath: bug.filePath,
      startLine: bug.startLine ?? null,
      endLine: bug.endLine ?? null,
    }));
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
