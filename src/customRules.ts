// Custom rules module for Claude Code BugHunter.
// Supports project-specific bug detection rules via BUGHUNTER.md file.
// Inspired by Cursor Bugbot's BUGBOT.md custom rules feature.
// Limitations: Requires manual rule file creation; pattern matching
//   may have false positives/negatives.

import { existsSync, readFileSync } from "fs";
import { join } from "path";

import { logger } from "./logger.js";
import type { Bug, BugSeverity, Config, CustomRule } from "./types.js";

// Default rules that are always applied
const DEFAULT_RULES: CustomRule[] = [
  {
    id: "default-sql-injection",
    title: "Potential SQL Injection",
    description: "String concatenation or template literals in SQL queries may lead to SQL injection vulnerabilities. Use parameterized queries instead.",
    severity: "critical",
    pattern: "(SELECT|INSERT|UPDATE|DELETE).*\\+|`.*\\$\\{.*\\}.*`",
    checkType: "must-not-contain",
  },
  {
    id: "default-eval-usage",
    title: "Dangerous eval() Usage",
    description: "Using eval() with user input is extremely dangerous and can lead to code injection vulnerabilities.",
    severity: "critical",
    pattern: "eval\\s*\\(",
    checkType: "must-not-contain",
  },
  {
    id: "default-hardcoded-secrets",
    title: "Potential Hardcoded Secret",
    description: "Hardcoded secrets (API keys, passwords, tokens) in source code can be leaked. Use environment variables or secret management systems.",
    severity: "high",
    pattern: "(api[_-]?key|password|secret|token|auth)\\s*[=:]\\s*['\"][^'\"]+['\"]",
    checkType: "must-not-contain",
  },
  {
    id: "default-any-type",
    title: "Explicit 'any' Type Usage",
    description: "Using 'any' type defeats TypeScript's type checking. Consider using a more specific type or 'unknown' with type guards.",
    severity: "medium",
    pattern: ":\\s*any",
    checkType: "must-not-contain",
  },
  {
    id: "default-console-log",
    title: "Console.log in Production Code",
    description: "Console.log statements should be removed before production deployment. Consider using a proper logging library.",
    severity: "low",
    pattern: "console\\.(log|debug|info)\\s*\\(",
    checkType: "must-not-contain",
  },
];

export class CustomRulesManager {
  private config: Config;
  private rules: CustomRule[];

  constructor(config: Config) {
    this.config = config;
    this.rules = [...DEFAULT_RULES];
    this.loadCustomRules();
  }

  // ============================================================
  // Load custom rules from file
  // ============================================================

  private loadCustomRules(): void {
    const rulesPath = this.config.customRulesPath;

    if (rulesPath) {
      // Load from specified path
      this.loadRulesFromFile(rulesPath);
    } else {
      // Try default locations
      const defaultPaths = [
        join(process.cwd(), "BUGHUNTER.md"),
        join(process.cwd(), ".bughunter", "rules.md"),
      ];

      for (const path of defaultPaths) {
        if (existsSync(path)) {
          this.loadRulesFromFile(path);
          break;
        }
      }
    }

    logger.info(`Loaded ${this.rules.length} custom rules`, {
      defaultRules: DEFAULT_RULES.length,
      customRules: this.rules.length - DEFAULT_RULES.length,
    });
  }

  // ============================================================
  // Parse rules from markdown file
  // ============================================================

  private loadRulesFromFile(filePath: string): void {
    try {
      if (!existsSync(filePath)) {
        logger.debug(`Custom rules file not found: ${filePath}`);
        return;
      }

      const content = readFileSync(filePath, "utf-8");
      const customRules = this.parseRulesFromMarkdown(content, filePath);

      // Add custom rules to the beginning (higher priority)
      this.rules = [...customRules, ...this.rules];

      logger.info(`Loaded ${customRules.length} custom rules from ${filePath}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.warn(`Failed to load custom rules from ${filePath}: ${message}`);
    }
  }

  // ============================================================
  // Parse rules from markdown content
  // ============================================================

  private parseRulesFromMarkdown(content: string, filePath: string): CustomRule[] {
    const rules: CustomRule[] = [];
    const lines = content.split("\n");

    let currentRule: Partial<CustomRule> | null = null;
    let inRuleBlock = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();

      // Check for rule start (## Rule: or ### Rule:)
      if (line.match(/^#{2,3}\s+(?:Rule:\s*)?(.+)$/i)) {
        // Save previous rule if exists
        if (currentRule && currentRule.title && currentRule.description) {
          rules.push(this.finalizeRule(currentRule, filePath, rules.length));
        }

        currentRule = {
          id: `custom-${filePath}-${rules.length}`,
          title: line.replace(/^#{2,3}\s+(?:Rule:\s*)?/i, ""),
          severity: "medium",
          checkType: "must-not-contain",
        };
        inRuleBlock = true;
        continue;
      }

      // Parse rule properties
      if (currentRule && inRuleBlock) {
        // Severity
        if (line.match(/^-?\s*severity:\s*(low|medium|high|critical)$/i)) {
          currentRule.severity = line.split(":")[1].trim().toLowerCase() as BugSeverity;
        }
        // Pattern
        else if (line.match(/^-?\s*pattern:\s*.+$/i)) {
          currentRule.pattern = line.replace(/^-?\s*pattern:\s*/i, "").trim();
        }
        // File pattern
        else if (line.match(/^-?\s*file[_-]?pattern:\s*.+$/i)) {
          currentRule.filePattern = line.replace(/^-?\s*file[_-]?pattern:\s*/i, "").trim();
        }
        // Check type
        else if (line.match(/^-?\s*check[_-]?type:\s*(always|never|must-contain|must-not-contain)$/i)) {
          currentRule.checkType = line.split(":")[1].trim().toLowerCase() as CustomRule["checkType"];
        }
        // Description (any other non-empty line)
        else if (line && !line.startsWith("#") && !line.startsWith("<!--")) {
          if (!currentRule.description) {
            currentRule.description = line;
          } else {
            currentRule.description += " " + line;
          }
        }
      }
    }

    // Save last rule
    if (currentRule && currentRule.title && currentRule.description) {
      rules.push(this.finalizeRule(currentRule, filePath, rules.length));
    }

    return rules;
  }

  // ============================================================
  // Finalize a parsed rule
  // ============================================================

  private finalizeRule(partial: Partial<CustomRule>, filePath: string, index: number): CustomRule {
    return {
      id: partial.id || `custom-${filePath}-${index}`,
      title: partial.title || "Untitled Rule",
      description: partial.description || "No description provided",
      severity: partial.severity || "medium",
      pattern: partial.pattern,
      filePattern: partial.filePattern,
      checkType: partial.checkType || "must-not-contain",
    };
  }

  // ============================================================
  // Check code against all rules
  // ============================================================

  checkAgainstRules(
    code: string,
    filePath: string,
    diff: string
  ): Bug[] {
    const bugs: Bug[] = [];

    for (const rule of this.rules) {
      // "never" means this rule should never report a bug — skip entirely
      if (rule.checkType === "never") {
        continue;
      }

      // Check file pattern if specified
      if (rule.filePattern) {
        let fileRegex: RegExp;
        try {
          fileRegex = new RegExp(rule.filePattern, "i");
        } catch (error) {
          logger.warn(
            `Invalid filePattern regex in rule ${rule.id} ("${rule.filePattern}"): ${error instanceof Error ? error.message : String(error)} — skipping rule`
          );
          continue;
        }
        if (!fileRegex.test(filePath)) {
          continue;
        }
      }

      if (rule.checkType === "always") {
        // Report a bug unconditionally for any file that matches filePattern (or all files if no filePattern)
        bugs.push({
          id: `rule-${rule.id}-always`,
          title: rule.title,
          severity: rule.severity,
          description: rule.description,
          filePath,
          startLine: 1,
          endLine: 1,
        });
        continue;
      }

      if (rule.checkType === "must-contain") {
        // The file must contain the pattern somewhere — report a bug if it does NOT match
        if (!rule.pattern) {
          continue;
        }
        try {
          const regex = new RegExp(rule.pattern, "gi");
          const hasMatch = regex.test(code);
          if (!hasMatch) {
            bugs.push({
              id: `rule-${rule.id}-missing`,
              title: rule.title,
              severity: rule.severity,
              description: `${rule.description}\n\nRequired pattern not found: ${rule.pattern}`,
              filePath,
              startLine: 1,
              endLine: 1,
            });
          }
        } catch (error) {
          logger.debug(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`);
        }
        continue;
      }

      // Default: "must-not-contain" — report a bug for each match found in new code
      if (rule.pattern) {
        try {
          const regex = new RegExp(rule.pattern, "gi");
          const matches = code.matchAll(regex);

          for (const match of matches) {
            const lineNumber = this.getLineNumber(code, match.index || 0);
            if (this.isNewCodeLine(diff, filePath, lineNumber)) {
              bugs.push({
                id: `rule-${rule.id}-${lineNumber}`,
                title: rule.title,
                severity: rule.severity,
                description: `${rule.description}\n\nMatched pattern: ${rule.pattern}`,
                filePath,
                startLine: lineNumber,
                endLine: lineNumber,
              });
            }
          }
        } catch (error) {
          logger.debug(`Invalid regex pattern in rule ${rule.id}: ${rule.pattern}`);
        }
      }
    }

    return bugs;
  }

  // ============================================================
  // Get line number from character index
  // ============================================================

  private getLineNumber(code: string, index: number): number {
    const lines = code.substring(0, index).split("\n");
    return lines.length;
  }

  // ============================================================
  // Check if a line is new code (in diff)
  // ============================================================

  private isNewCodeLine(diff: string, filePath: string, lineNumber: number): boolean {
    const diffLines = diff.split("\n");
    let inTargetFile = false;
    let currentNewLine = 0;
    let inHunk = false;

    for (const line of diffLines) {
      // Check for file header
      if (line.startsWith("diff --git")) {
        inTargetFile = line.includes(` b/${filePath}`) || line.includes(` ${filePath}`);
        continue;
      }

      if (!inTargetFile) continue;

      // Check for hunk header
      if (line.startsWith("@@")) {
        const match = line.match(/@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
        if (match) {
          currentNewLine = parseInt(match[1], 10) - 1;
          inHunk = true;
        }
        continue;
      }

      if (!inHunk) continue;

      // Count new lines
      if (line.startsWith("+") && !line.startsWith("+++")) {
        currentNewLine++;
        if (currentNewLine === lineNumber) {
          return true;
        }
      } else if (!line.startsWith("-") && !line.startsWith("\\")) {
        currentNewLine++;
      }
    }

    return false;
  }

  // ============================================================
  // Get all loaded rules
  // ============================================================

  getRules(): CustomRule[] {
    return [...this.rules];
  }

  // ============================================================
  // Get rule by ID
  // ============================================================

  getRule(id: string): CustomRule | undefined {
    return this.rules.find((r) => r.id === id);
  }

  // ============================================================
  // Format rules for prompt inclusion
  // ============================================================

  formatRulesForPrompt(): string {
    if (this.rules.length === 0) {
      return "";
    }

    const lines: string[] = ["## Project-Specific Rules to Check", ""];

    for (const rule of this.rules) {
      lines.push(`### ${rule.title} (Severity: ${rule.severity})`);
      lines.push(rule.description);
      if (rule.pattern) {
        lines.push(`Pattern: \`${rule.pattern}\``);
      }
      lines.push("");
    }

    return lines.join("\n");
  }
}
