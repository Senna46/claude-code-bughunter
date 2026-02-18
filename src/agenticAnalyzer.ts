// Agentic bug analysis module for Claude Code BugHunter.
// Uses Claude CLI with tools enabled to allow the agent to investigate
// suspicious code patterns by reading files, searching codebase, etc.
// Inspired by Cursor Bugbot's agentic architecture for deeper analysis.
// Limitations: Requires more API calls; may be slower than static analysis.

import { spawn } from "child_process";
import { randomUUID } from "crypto";
import { mkdtemp, writeFile, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

import { logger } from "./logger.js";
import type {
  AnalysisResult,
  Bug,
  BugRecord,
  Config,
} from "./types.js";

// System prompt for agentic analysis
const AGENTIC_SYSTEM_PROMPT = `You are a senior code reviewer and bug hunter with access to tools. Your task is to analyze a PR diff and identify real bugs, security vulnerabilities, and significant code quality issues.

You have access to the following tools:
- Read: Read any file from the codebase to understand context
- Grep: Search for patterns across the codebase
- Glob: Find files matching patterns
- Bash: Run shell commands (limited to safe operations)

Analysis Strategy:
1. First, review the diff to identify suspicious patterns
2. For each suspicious pattern, use tools to investigate:
   - Read related files to understand the full context
   - Search for how functions/classes are used elsewhere
   - Check for type definitions and interfaces
   - Look for tests that might reveal expected behavior
3. Verify if the suspicious pattern is actually a bug or intentional
4. Only report bugs you've verified through investigation

Rules:
- Focus on actual bugs that would cause incorrect behavior, crashes, security issues, or data loss.
- Do NOT report style issues, formatting preferences, or minor nits.
- Do NOT report issues that are clearly intentional design decisions.
- Each bug must reference a specific file and line numbers.
- Be aggressive in investigating suspicious patterns - it's better to investigate and find nothing than to miss a real bug.
- Use tools liberally to verify your hypotheses before reporting bugs.

Severity guidelines:
- critical: Security vulnerabilities, data loss, crashes in production
- high: Incorrect business logic, race conditions, resource leaks
- medium: Edge cases not handled, inconsistent behavior
- low: Minor issues unlikely to cause problems in practice

When you're done investigating, output your findings as JSON.`;

// JSON schema for agentic analysis output
const AGENTIC_OUTPUT_SCHEMA = JSON.stringify({
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
            description: "Start line number (if identifiable)",
          },
          endLine: {
            type: "integer",
            description: "End line number (if identifiable)",
          },
          investigationNotes: {
            type: "string",
            description: "Brief notes on how this bug was discovered/investigated",
          },
        },
        required: ["title", "severity", "description", "filePath"],
      },
    },
    overview: {
      type: "string",
      description: "Concise description of what the PR changes and their purpose",
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

export class AgenticAnalyzer {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Analyze a PR diff using agentic approach
  // ============================================================

  async analyzeDiff(
    diff: string,
    prTitle: string,
    commitSha: string,
    repoPath: string,
    previousBugs?: BugRecord[],
    customRulesText?: string
  ): Promise<AnalysisResult> {
    logger.info("Starting agentic bug analysis...", {
      diffLength: diff.length,
      prTitle,
      repoPath,
      hasCustomRules: Boolean(customRulesText),
    });

    // Create a temporary workspace for the analysis
    const workDir = await this.createAnalysisWorkspace(diff, prTitle);

    try {
      // Run the agentic analysis
      const result = await this.runAgenticAnalysis(
        workDir,
        prTitle,
        repoPath,
        previousBugs,
        customRulesText
      );

      logger.info(`Agentic analysis complete: ${result.bugs.length} bug(s) found.`, {
        commitSha: commitSha.substring(0, 10),
        riskLevel: result.riskLevel,
      });

      return {
        ...result,
        commitSha,
        analyzedAt: new Date().toISOString(),
      };
    } finally {
      // Cleanup
      await this.cleanupWorkspace(workDir);
    }
  }

  // ============================================================
  // Create analysis workspace with diff and context files
  // ============================================================

  private async createAnalysisWorkspace(diff: string, prTitle: string): Promise<string> {
    const workDir = await mkdtemp(join(tmpdir(), "bughunter-agentic-"));

    // Write the diff to a file
    await writeFile(join(workDir, "diff.patch"), diff);

    return workDir;
  }

  // ============================================================
  // Run agentic analysis using claude CLI with tools
  // ============================================================

  private async runAgenticAnalysis(
    workDir: string,
    prTitle: string,
    repoPath: string,
    previousBugs?: BugRecord[],
    customRulesText?: string
  ): Promise<AnalysisResult> {
    const diffPath = join(workDir, "diff.patch");
    const prompt = this.buildAgenticPrompt(prTitle, repoPath, diffPath, previousBugs, customRulesText);

    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      AGENTIC_OUTPUT_SCHEMA,
      "--append-system-prompt",
      AGENTIC_SYSTEM_PROMPT,
      "--max-tokens",
      "16000",
      "--allowedTools",
      "Read,Grep,Glob,Bash",
    ];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    // Set max turns to limit the agent's exploration
    args.push("--max-turns", String(this.config.agenticMaxTurns));

    return new Promise<AnalysisResult>((resolve, reject) => {
      // Run claude with cwd set to the actual repository so the agent's
      // Read/Grep/Glob/Bash tools can explore the real source files.
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10 * 60 * 1000, // 10 minutes for agentic analysis
        cwd: repoPath,
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
          logger.debug("Agentic analysis stderr output.", {
            stderr: stderr.substring(0, 1000),
          });
        }

        if (code !== 0) {
          reject(
            new Error(`Agentic analysis exited with code ${code}. stderr: ${stderr.substring(0, 500)}`)
          );
          return;
        }

        try {
          const result = this.parseAgenticOutput(stdout);
          resolve(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse agentic output: ${message}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Agentic analysis failed: ${error.message}`));
      });

      // Write prompt to stdin
      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Build prompt for agentic analysis
  // ============================================================

  private buildAgenticPrompt(
    prTitle: string,
    repoPath: string,
    diffPath: string,
    previousBugs?: BugRecord[],
    customRulesText?: string
  ): string {
    const sections: string[] = [];

    sections.push(`Analyze this PR for bugs using an investigative approach.`);
    sections.push(`PR Title: ${prTitle}`);
    sections.push(
      `Repository root: ${repoPath}\n` +
      `The diff is at: ${diffPath}\n\n` +
      `Your working directory is the repository root. You can use Read, Grep, Glob, and Bash ` +
      `to explore the full source tree directly. Start by reading the diff file at the path ` +
      `shown above, then investigate any suspicious patterns using the repository source files.`
    );

    // Include custom rules so the agent can reason about project-specific constraints
    if (customRulesText) {
      sections.push(customRulesText);
    }

    // Include previously reported bugs
    if (previousBugs && previousBugs.length > 0) {
      const bugLines: string[] = ["Previously reported bugs to avoid duplicating:"];
      for (let i = 0; i < previousBugs.length; i++) {
        const bug = previousBugs[i];
        bugLines.push(`${i + 1}. [${bug.severity.toUpperCase()}] "${bug.title}" (${bug.filePath})`);
      }
      sections.push(bugLines.join("\n"));
    }

    sections.push(`
Use tools liberally to verify your hypotheses.

When done, output your findings as JSON with the following structure:
- bugs: array of detected bugs
- overview: description of what the PR changes
- summary: brief summary of findings
- riskLevel: overall risk assessment (low/medium/high)
`);

    return sections.join("\n\n");
  }

  // ============================================================
  // Parse agentic analysis output
  // ============================================================

  private parseAgenticOutput(stdout: string): AnalysisResult {
    try {
      const envelope = JSON.parse(stdout);

      let data: {
        bugs: Array<{
          title: string;
          severity: string;
          description: string;
          filePath: string;
          startLine?: number;
          endLine?: number;
          investigationNotes?: string;
        }>;
        overview: string;
        summary: string;
        riskLevel: string;
      };

      if (envelope.structured_output) {
        data = envelope.structured_output;
      } else if (envelope.result) {
        data = JSON.parse(envelope.result);
      } else {
        data = envelope;
      }

      const bugs: Bug[] = data.bugs.map((bug) => ({
        id: randomUUID(),
        title: bug.title,
        severity: bug.severity as "low" | "medium" | "high" | "critical",
        description: bug.investigationNotes
          ? `${bug.description}\n\nInvestigation: ${bug.investigationNotes}`
          : bug.description,
        filePath: bug.filePath,
        startLine: bug.startLine ?? null,
        endLine: bug.endLine ?? null,
      }));

      const rawSummary = data.summary || "No summary provided.";
      return {
        bugs,
        overview: data.overview || "No overview provided.",
        // Agentic analysis returns Claude's summary directly (no voting prefix).
        // Both summary and rawSummary are the same here.
        summary: rawSummary,
        rawSummary,
        riskLevel: (data.riskLevel as "low" | "medium" | "high") || "low",
        commitSha: "",
        analyzedAt: new Date().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse agentic analysis output.", {
        error: message,
        stdoutPreview: stdout.substring(0, 1000),
      });

      return {
        bugs: [],
        overview: "Agentic analysis output could not be parsed.",
        summary: "Agentic analysis output could not be parsed.",
        rawSummary: "Agentic analysis output could not be parsed.",
        riskLevel: "low",
        commitSha: "",
        analyzedAt: new Date().toISOString(),
      };
    }
  }

  // ============================================================
  // Cleanup workspace
  // ============================================================

  private async cleanupWorkspace(workDir: string): Promise<void> {
    try {
      await rm(workDir, { recursive: true, force: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to cleanup workspace: ${message}`);
    }
  }
}
