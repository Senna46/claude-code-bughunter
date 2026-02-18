// Dynamic context discovery module for Claude Code BugHunter.
// Implements on-demand context retrieval instead of pre-fetching all files.
// Inspired by Cursor's dynamic context discovery for token efficiency.
// Limitations: May require multiple API calls; context quality depends on
//   the agent's ability to request relevant files.

import { extractChangedFilePaths } from "./analyzer.js";
import { logger } from "./logger.js";
import type { Config } from "./types.js";

// Interface for file content provider (injected dependency)
export type FileContentProvider = (
  owner: string,
  repo: string,
  filePath: string,
  ref: string
) => Promise<string | null>;

export class DynamicContextManager {
  private config: Config;
  private cachedFiles: Map<string, string>;
  private owner: string;
  private repo: string;
  private ref: string;
  private fileContentProvider: FileContentProvider;

  constructor(
    config: Config,
    owner: string,
    repo: string,
    ref: string,
    fileContentProvider: FileContentProvider
  ) {
    this.config = config;
    this.owner = owner;
    this.repo = repo;
    this.ref = ref;
    this.fileContentProvider = fileContentProvider;
    this.cachedFiles = new Map();
  }

  // ============================================================
  // Main: Get context for analysis
  // ============================================================

  async getContextForDiff(
    diff: string,
    suspiciousPatterns?: string[]
  ): Promise<Map<string, string>> {
    if (!this.config.enableDynamicContext) {
      // Fall back to returning empty - caller should use pre-fetched files
      return new Map();
    }

    logger.info("Performing dynamic context discovery...", {
      suspiciousPatternsCount: suspiciousPatterns?.length ?? 0,
    });

    const context = new Map<string, string>();

    // 1. Extract changed files from diff
    const changedFiles = extractChangedFilePaths(diff);

    // 2. Prioritize files based on suspicious patterns
    const prioritizedFiles = this.prioritizeFiles(changedFiles, suspiciousPatterns);

    // 3. Fetch top files up to limit
    const maxFiles = Math.min(this.config.dynamicContextMaxFiles, prioritizedFiles.length);

    for (let i = 0; i < maxFiles; i++) {
      const filePath = prioritizedFiles[i];
      const content = await this.fetchFile(filePath);

      if (content) {
        const processed = this.processFileContent(content, filePath);
        context.set(filePath, processed);
      }
    }

    logger.info(`Dynamic context discovery complete: ${context.size} file(s) loaded`, {
      requestedFiles: prioritizedFiles.slice(0, maxFiles),
      loadedFiles: [...context.keys()],
    });

    return context;
  }

  // ============================================================
  // Private helper methods
  // ============================================================

  private async fetchFile(filePath: string): Promise<string | null> {
    if (this.cachedFiles.has(filePath)) {
      logger.debug(`Cache hit for file: ${filePath}`);
      return this.cachedFiles.get(filePath)!;
    }

    try {
      const content = await this.fileContentProvider(
        this.owner,
        this.repo,
        filePath,
        this.ref
      );

      if (content !== null) {
        this.cachedFiles.set(filePath, content);
      }

      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`Failed to fetch file ${filePath}: ${message}`);
      return null;
    }
  }

  private prioritizeFiles(
    files: string[],
    suspiciousPatterns?: string[]
  ): string[] {
    if (!suspiciousPatterns || suspiciousPatterns.length === 0) {
      return files;
    }

    // Score files based on pattern matches
    const scored = files.map((file) => {
      let score = 0;
      const fileLower = file.toLowerCase();

      for (const pattern of suspiciousPatterns) {
        if (fileLower.includes(pattern.toLowerCase())) {
          score += 1;
        }
      }

      return { file, score };
    });

    // Sort by score (descending), then by original order
    scored.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return files.indexOf(a.file) - files.indexOf(b.file);
    });

    return scored.map((s) => s.file);
  }

  private processFileContent(content: string, filePath: string): string {
    const maxLines = this.config.dynamicContextMaxLines;
    const lines = content.split("\n");

    if (lines.length <= maxLines) {
      return content;
    }

    // Truncate to max lines
    const truncated = lines.slice(0, maxLines).join("\n");
    logger.debug(`Truncated ${filePath} from ${lines.length} to ${maxLines} lines`);

    return truncated + `\n\n[... ${lines.length - maxLines} more lines ...]`;
  }

  // ============================================================
  // Get suspicious patterns from diff
  // ============================================================

  static extractSuspiciousPatterns(diff: string): string[] {
    const patterns: string[] = [];

    // Look for potentially problematic patterns
    const suspiciousKeywords = [
      "TODO",
      "FIXME",
      "HACK",
      "XXX",
      "BUG",
      "async",
      "await",
      "Promise",
      "catch",
      "error",
      "null",
      "undefined",
      "any",
      "unsafe",
    ];

    for (const keyword of suspiciousKeywords) {
      if (diff.toLowerCase().includes(keyword.toLowerCase())) {
        patterns.push(keyword);
      }
    }

    // Look for file patterns that might indicate important code
    if (diff.includes("test") || diff.includes("spec")) {
      patterns.push("test");
    }
    if (diff.includes("auth") || diff.includes("security")) {
      patterns.push("security");
    }
    if (diff.includes("api") || diff.includes("handler")) {
      patterns.push("api");
    }

    return [...new Set(patterns)];
  }
}
