// Bug validation module for Claude Code BugHunter.
// Implements a second-pass validation to reduce false positives.
// Uses a lightweight model to verify if detected bugs are real issues.
// Limitations: Requires additional API call for each bug; may filter
//   some edge cases incorrectly.

import { spawn } from "child_process";

import { logger } from "./logger.js";
import type { Bug, Config } from "./types.js";

// JSON schema for validation output
const VALIDATION_SCHEMA = JSON.stringify({
  type: "object",
  properties: {
    isValidBug: {
      type: "boolean",
      description: "Whether this is a real bug that should be reported",
    },
    confidence: {
      type: "string",
      enum: ["high", "medium", "low"],
      description: "Confidence level of the validation decision",
    },
    reasoning: {
      type: "string",
      description: "Brief explanation of the validation decision",
    },
    correctedSeverity: {
      type: "string",
      enum: ["low", "medium", "high", "critical"],
      description: "Suggested severity if different from original",
    },
  },
  required: ["isValidBug", "confidence", "reasoning"],
});

const VALIDATION_SYSTEM_PROMPT = `You are a bug validation expert. Your task is to review detected bugs and determine if they are real issues that should be reported.

Rules:
- A "real bug" causes incorrect behavior, crashes, security issues, or data loss.
- Style issues, formatting preferences, and minor nits are NOT real bugs.
- Intentional design decisions (even if questionable) are NOT bugs.
- Be conservative: if uncertain, lean towards validating the bug.
- Consider the context: is this code pattern actually problematic?

Validation criteria:
- Does the described issue actually cause a problem?
- Is the severity appropriate for the impact?
- Could this be an intentional design choice?

Respond with isValidBug=true if this is a real issue worth reporting.`;

export interface ValidationResult {
  isValid: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  correctedSeverity?: "low" | "medium" | "high" | "critical";
}

export class BugValidator {
  private config: Config;
  private enabled: boolean;

  constructor(config: Config) {
    this.config = config;
    this.enabled = config.enableValidator;
  }

  // ============================================================
  // Main: Validate a list of bugs
  // ============================================================

  async validateBugs(
    bugs: Bug[],
    diff: string,
    fileContents?: Map<string, string>
  ): Promise<Bug[]> {
    if (!this.enabled || bugs.length === 0) {
      return bugs;
    }

    logger.info(`Validating ${bugs.length} bug(s) with validator model...`);

    const validatedBugs: Bug[] = [];
    const validationResults: Array<{ bug: Bug; result: ValidationResult }> = [];

    // Validate each bug
    for (const bug of bugs) {
      try {
        const result = await this.validateSingleBug(bug, diff, fileContents);
        validationResults.push({ bug, result });

        if (result.isValid) {
          // Apply severity correction if suggested
          let finalBug = bug;
          if (result.correctedSeverity && result.correctedSeverity !== bug.severity) {
            logger.debug(`Severity corrected for bug "${bug.title}": ${bug.severity} -> ${result.correctedSeverity}`);
            finalBug = { ...bug, severity: result.correctedSeverity };
          }
          validatedBugs.push(finalBug);
          logger.debug(`Bug validated: "${bug.title}" (${result.confidence} confidence)`);
        } else {
          logger.debug(`Bug filtered out: "${bug.title}" - ${result.reasoning}`);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logger.warn(`Validation failed for bug "${bug.title}": ${message}. Keeping bug.`);
        // On validation failure, keep the bug to be conservative
        validatedBugs.push(bug);
      }
    }

    // Log summary
    const validCount = validatedBugs.length;
    const filteredCount = bugs.length - validCount;
    logger.info(`Validation complete: ${validCount} valid, ${filteredCount} filtered out`, {
      totalBugs: bugs.length,
      validBugs: validCount,
      filteredBugs: filteredCount,
      highConfidence: validationResults.filter((r) => r.result.isValid && r.result.confidence === "high").length,
    });

    return validatedBugs;
  }

  // ============================================================
  // Validate a single bug
  // ============================================================

  private async validateSingleBug(
    bug: Bug,
    diff: string,
    fileContents?: Map<string, string>
  ): Promise<ValidationResult> {
    // Build context for validation
    const context = this.buildValidationContext(bug, diff, fileContents);

    const prompt = `Validate the following detected bug:

**Bug Title:** ${bug.title}

**Severity:** ${bug.severity}

**Location:** ${bug.filePath}${bug.startLine ? `:${bug.startLine}${bug.endLine ? `-${bug.endLine}` : ""}` : ""}

**Description:** ${bug.description}

**Context:**
${context}

Determine if this is a real bug that should be reported. Respond with structured JSON.`;

    const output = await this.runValidation(prompt);
    return output;
  }

  // ============================================================
  // Build validation context
  // ============================================================

  private buildValidationContext(
    bug: Bug,
    diff: string,
    fileContents?: Map<string, string>
  ): string {
    const sections: string[] = [];

    // Extract relevant diff section for the file
    const fileDiff = this.extractFileDiff(diff, bug.filePath);
    if (fileDiff) {
      sections.push("```diff\n" + fileDiff + "\n```");
    }

    // Include relevant file content if available
    if (fileContents && bug.filePath) {
      const content = fileContents.get(bug.filePath);
      if (content) {
        // Extract lines around the bug location
        const relevantContent = this.extractRelevantLines(
          content,
          bug.startLine,
          bug.endLine
        );
        if (relevantContent) {
          sections.push(`Relevant code from ${bug.filePath}:\n\`\`\`\n${relevantContent}\n\`\`\``);
        }
      }
    }

    return sections.join("\n\n") || "No additional context available.";
  }

  // ============================================================
  // Extract diff for a specific file
  // ============================================================

  private extractFileDiff(diff: string, filePath: string): string | null {
    const lines = diff.split("\n");
    const result: string[] = [];
    let inTargetFile = false;
    let foundFile = false;

    for (const line of lines) {
      if (line.startsWith("diff --git")) {
        // Check if this is our target file
        if (line.endsWith(` b/${filePath}`) || line.endsWith(` ${filePath}`)) {
          inTargetFile = true;
          foundFile = true;
        } else if (inTargetFile) {
          // We've moved to a different file
          break;
        }
      }

      if (inTargetFile) {
        result.push(line);
      }
    }

    return foundFile ? result.join("\n") : null;
  }

  // ============================================================
  // Extract relevant lines from file content
  // ============================================================

  private extractRelevantLines(
    content: string,
    startLine: number | null,
    endLine: number | null
  ): string | null {
    if (!startLine) {
      return null;
    }

    const lines = content.split("\n");
    const contextLines = 10; // Lines of context before and after

    const start = Math.max(0, startLine - contextLines - 1);
    const end = endLine
      ? Math.min(lines.length, endLine + contextLines)
      : Math.min(lines.length, startLine + contextLines);

    return lines.slice(start, end).join("\n");
  }

  // ============================================================
  // Run validation via claude -p
  // ============================================================

  private async runValidation(prompt: string): Promise<ValidationResult> {
    const args = [
      "-p",
      "--output-format",
      "json",
      "--json-schema",
      VALIDATION_SCHEMA,
      "--append-system-prompt",
      VALIDATION_SYSTEM_PROMPT,
    ];

    // Use validator model if configured, otherwise use default
    const model = this.config.validatorModel || this.config.claudeModel;
    if (model) {
      args.push("--model", model);
    }

    return new Promise<ValidationResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 60 * 1000, // 1 minute per validation
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
          reject(
            new Error(`claude -p exited with code ${code}. stderr: ${stderr.substring(0, 500)}`)
          );
          return;
        }

        try {
          const result = this.parseValidationOutput(stdout);
          resolve(result);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          reject(new Error(`Failed to parse validation output: ${message}`));
        }
      });

      child.on("error", (error) => {
        reject(new Error(`Validation failed: ${error.message}`));
      });

      child.stdin.write(prompt);
      child.stdin.end();
    });
  }

  // ============================================================
  // Parse validation output
  // ============================================================

  private parseValidationOutput(stdout: string): ValidationResult {
    try {
      const envelope = JSON.parse(stdout);

      let data: unknown;
      if (envelope.structured_output) {
        data = envelope.structured_output;
      } else if (envelope.result) {
        data = JSON.parse(envelope.result);
      } else {
        data = envelope;
      }

      const output = data as {
        isValidBug: boolean;
        confidence: string;
        reasoning: string;
        correctedSeverity?: string;
      };

      return {
        isValid: output.isValidBug ?? false,
        confidence: (output.confidence as "high" | "medium" | "low") ?? "medium",
        reasoning: output.reasoning ?? "No reasoning provided",
        correctedSeverity: output.correctedSeverity as "low" | "medium" | "high" | "critical" | undefined,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.error("Failed to parse validation output.", {
        error: message,
        stdoutPreview: stdout.substring(0, 500),
      });
      throw error;
    }
  }
}
