// Resolution rate metrics module for Claude Code BugHunter.
// Tracks how many detected bugs are actually fixed by developers.
// Inspired by Cursor Bugbot's Resolution Rate metric for quality measurement.
// Limitations: Requires PR merge tracking; may have false negatives
//   for bugs fixed indirectly.

import { spawn } from "child_process";

import { logger } from "./logger.js";
import type { BugRecord, Config } from "./types.js";

// JSON schema for resolution check output
const RESOLUTION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    resolvedBugIds: {
      type: "array",
      items: { type: "string" },
      description: "IDs of bugs that were resolved",
    },
    unresolvedBugIds: {
      type: "array",
      items: { type: "string" },
      description: "IDs of bugs that are still present",
    },
    reasoning: {
      type: "string",
      description: "Brief explanation of the resolution decisions",
    },
  },
  required: ["resolvedBugIds", "unresolvedBugIds"],
});

const RESOLUTION_SYSTEM_PROMPT = `You are a code review analyst. Your task is to determine if previously reported bugs were resolved in the final merged code.

For each bug:
1. Check if the problematic code pattern still exists
2. Check if the bug was fixed (even partially)
3. Check if the fix addresses the root cause

A bug is "resolved" if:
- The problematic code was removed or fixed
- A proper fix was implemented (not just ignoring the issue)
- The code no longer contains the vulnerability or bug

A bug is "unresolved" if:
- The problematic code still exists unchanged
- Only a workaround was added without fixing the root cause
- The fix is incomplete or incorrect

Be conservative: if uncertain, mark as unresolved.`;

export interface ResolutionResult {
  resolvedBugIds: string[];
  unresolvedBugIds: string[];
  reasoning: string;
}

export interface ResolutionStats {
  totalBugs: number;
  resolvedBugs: number;
  resolutionRate: number;
  lastUpdated: string;
}

export class MetricsManager {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  // ============================================================
  // Main: Check resolution status at PR merge time
  // ============================================================

  async checkResolution(
    bugs: BugRecord[],
    mergedCode: string,
    originalDiff: string
  ): Promise<ResolutionResult> {
    if (bugs.length === 0) {
      return {
        resolvedBugIds: [],
        unresolvedBugIds: [],
        reasoning: "No bugs to check.",
      };
    }

    logger.info(`Checking resolution status for ${bugs.length} bug(s)...`);

    const prompt = this.buildResolutionPrompt(bugs, mergedCode, originalDiff);
    const output = await this.runResolutionCheck(prompt);

    logger.info(`Resolution check complete: ${output.resolvedBugIds.length}/${bugs.length} resolved`, {
      resolvedCount: output.resolvedBugIds.length,
      unresolvedCount: output.unresolvedBugIds.length,
    });

    return output;
  }

  // ============================================================
  // Build resolution check prompt
  // ============================================================

  private buildResolutionPrompt(
    bugs: BugRecord[],
    mergedCode: string,
    originalDiff: string
  ): string {
    const sections: string[] = [];

    sections.push("Determine which of the following bugs were resolved in the merged code:");

    // List bugs
    for (let i = 0; i < bugs.length; i++) {
      const bug = bugs[i];
      sections.push(`\n${i + 1}. [${bug.severity.toUpperCase()}] "${bug.title}" (ID: ${bug.id})`);
      sections.push(`   File: ${bug.filePath}`);
      if (bug.startLine) {
        sections.push(`   Lines: ${bug.startLine}${bug.endLine ? `-${bug.endLine}` : ""}`);
      }
      sections.push(`   Description: ${bug.description}`);
    }

    sections.push("\n---\n");
    sections.push("Original diff (showing what was changed):");
    sections.push("```diff");
    sections.push(originalDiff.substring(0, 5000));
    sections.push("```");

    sections.push("\n---\n");
    sections.push("Merged code (final state):");
    sections.push("```");
    sections.push(mergedCode.substring(0, 10000));
    sections.push("```");

    sections.push("\nFor each bug, determine if it was resolved in the final code.");
    sections.push("Return the result as structured JSON.");

    return sections.join("\n");
  }

  // ============================================================
  // Run resolution check via claude
  // ============================================================

  private async runResolutionCheck(prompt: string): Promise<ResolutionResult> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      RESOLUTION_SCHEMA,
      "--append-system-prompt",
      RESOLUTION_SYSTEM_PROMPT,
    ];

    if (this.config.claudeModel) {
      args.push("--model", this.config.claudeModel);
    }

    return new Promise<ResolutionResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60 * 1000, // 1 minute
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
        if (code !== 0) {
          reject(new Error(`Resolution check failed with code ${code}`));
          return;
        }

        try {
          const result = this.parseResolutionOutput(stdout);
          resolve(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse resolution output: ${message}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Resolution check error: ${error.message}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Parse resolution output
  // ============================================================

  private parseResolutionOutput(stdout: string): ResolutionResult {
    try {
      const envelope = JSON.parse(stdout);

      let data: {
        resolvedBugIds: string[];
        unresolvedBugIds: string[];
        reasoning?: string;
      };

      if (envelope.structured_output) {
        data = envelope.structured_output;
      } else if (envelope.result) {
        data = JSON.parse(envelope.result);
      } else {
        data = envelope;
      }

      return {
        resolvedBugIds: data.resolvedBugIds || [],
        unresolvedBugIds: data.unresolvedBugIds || [],
        reasoning: data.reasoning || "No reasoning provided",
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse resolution output.", {
        error: message,
        stdoutPreview: stdout.substring(0, 500),
      });

      return {
        resolvedBugIds: [],
        unresolvedBugIds: [],
        reasoning: `Parse error: ${message}`,
      };
    }
  }

  // ============================================================
  // Calculate resolution statistics
  // ============================================================

  calculateStats(
    totalBugs: number,
    resolvedBugs: number,
    previousStats?: ResolutionStats
  ): ResolutionStats {
    const resolutionRate = totalBugs > 0 ? resolvedBugs / totalBugs : 0;

    return {
      totalBugs,
      resolvedBugs,
      resolutionRate,
      lastUpdated: new Date().toISOString(),
    };
  }

  // ============================================================
  // Format stats for display
  // ============================================================

  formatStats(stats: ResolutionStats): string {
    const percentage = (stats.resolutionRate * 100).toFixed(1);
    return `Resolution Rate: ${percentage}% (${stats.resolvedBugs}/${stats.totalBugs} bugs fixed)`;
  }
}
