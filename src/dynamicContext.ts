// Dynamic context discovery module for Claude Code BugHunter.
// Implements on-demand context retrieval instead of pre-fetching all files.
// Inspired by Cursor's dynamic context discovery for token efficiency.
// Limitations: May require multiple API calls; context quality depends on
//   the agent's ability to request relevant files.

import { logger } from "./logger.js";
import type { Config } from "./types.js";

// Interface for context request
export interface ContextRequest {
  filePath: string;
  reason: string;
  startLine?: number;
  endLine?: number;
}

// Interface for context result
export interface ContextResult {
  filePath: string;
  content: string;
  truncated: boolean;
  linesIncluded: { start: number; end: number };
}

// Interface for file content provider (injected dependency)
export type FileContentProvider = (
  owner: string,
  repo: string,
  filePath: string,
  ref: string
) => Promise<string | null>;

// Interface for related file discovery
export interface RelatedFile {
  filePath: string;
  relevanceScore: number;
  reason: string;
}

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
    const changedFiles = this.extractChangedFilesFromDiff(diff);

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
        this.cachedFiles.set(filePath, content);
      }
    }

    logger.info(`Dynamic context discovery complete: ${context.size} file(s) loaded`, {
      requestedFiles: prioritizedFiles.slice(0, maxFiles),
      loadedFiles: [...context.keys()],
    });

    return context;
  }

  // ============================================================
  // Get additional context on demand
  // ============================================================

  async getAdditionalContext(requests: ContextRequest[]): Promise<ContextResult[]> {
    const results: ContextResult[] = [];

    for (const request of requests) {
      // Check cache first
      let content: string | undefined = this.cachedFiles.get(request.filePath);

      if (!content) {
        const fetched = await this.fetchFile(request.filePath);
        if (fetched !== null) {
          content = fetched;
          this.cachedFiles.set(request.filePath, fetched);
        }
      }

      if (content) {
        const processed = this.extractRelevantLines(
          content,
          request.startLine,
          request.endLine
        );

        results.push({
          filePath: request.filePath,
          content: processed.content,
          truncated: processed.truncated,
          linesIncluded: processed.linesIncluded,
        });
      }
    }

    return results;
  }

  // ============================================================
  // Discover related files based on imports/usage
  // ============================================================

  async discoverRelatedFiles(
    filePath: string,
    content: string
  ): Promise<RelatedFile[]> {
    const related: RelatedFile[] = [];

    // Extract imports from the file
    const imports = this.extractImports(content, filePath);

    // Extract function/class references
    const references = this.extractReferences(content);

    // Score each potential related file
    for (const imp of imports) {
      related.push({
        filePath: imp,
        relevanceScore: 0.9,
        reason: "Direct import",
      });
    }

    for (const ref of references) {
      // Try to resolve the reference to a file path
      const resolvedPath = await this.resolveReference(ref, filePath);
      if (resolvedPath) {
        related.push({
          filePath: resolvedPath,
          relevanceScore: 0.7,
          reason: "Referenced in code",
        });
      }
    }

    // Deduplicate and sort by relevance
    const seen = new Set<string>();
    return related
      .filter((r) => {
        if (seen.has(r.filePath)) return false;
        seen.add(r.filePath);
        return true;
      })
      .sort((a, b) => b.relevanceScore - a.relevanceScore);
  }

  // ============================================================
  // Private helper methods
  // ============================================================

  private async fetchFile(filePath: string): Promise<string | null> {
    try {
      const content = await this.fileContentProvider(
        this.owner,
        this.repo,
        filePath,
        this.ref
      );
      return content;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      logger.debug(`Failed to fetch file ${filePath}: ${message}`);
      return null;
    }
  }

  private extractChangedFilesFromDiff(diff: string): string[] {
    const files: string[] = [];
    const lines = diff.split("\n");

    for (const line of lines) {
      if (line.startsWith("+++ b/")) {
        const filePath = line.substring(6);
        if (!files.includes(filePath)) {
          files.push(filePath);
        }
      }
    }

    return files;
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

  private extractRelevantLines(
    content: string,
    startLine?: number,
    endLine?: number
  ): { content: string; truncated: boolean; linesIncluded: { start: number; end: number } } {
    const lines = content.split("\n");
    const maxLines = this.config.dynamicContextMaxLines;

    if (!startLine) {
      // Return from beginning
      const result = lines.slice(0, maxLines);
      return {
        content: result.join("\n"),
        truncated: lines.length > maxLines,
        linesIncluded: { start: 1, end: Math.min(maxLines, lines.length) },
      };
    }

    // Add context around the target lines
    const contextLines = 20;
    const start = Math.max(0, startLine - contextLines - 1);
    const end = endLine
      ? Math.min(lines.length, endLine + contextLines)
      : Math.min(lines.length, startLine + contextLines);

    const result = lines.slice(start, end);

    return {
      content: result.join("\n"),
      truncated: end < lines.length,
      linesIncluded: { start: start + 1, end: end },
    };
  }

  private extractImports(content: string, currentFilePath: string): string[] {
    const imports: string[] = [];
    const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf("/"));

    // Match ES6 imports
    const importRegex = /import\s+.*?from\s+['"]([^'"]+)['"]/g;
    let match;
    while ((match = importRegex.exec(content)) !== null) {
      const importPath = match[1];
      const resolved = this.resolveImportPath(importPath, currentDir);
      if (resolved) {
        imports.push(resolved);
      }
    }

    // Match CommonJS requires
    const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
    while ((match = requireRegex.exec(content)) !== null) {
      const importPath = match[1];
      const resolved = this.resolveImportPath(importPath, currentDir);
      if (resolved) {
        imports.push(resolved);
      }
    }

    return imports;
  }

  private resolveImportPath(importPath: string, currentDir: string): string | null {
    // Skip node_modules imports
    if (!importPath.startsWith(".") && !importPath.startsWith("/")) {
      return null;
    }

    // Resolve relative imports
    if (importPath.startsWith(".")) {
      let resolved = `${currentDir}/${importPath}`;
      
      // Add extensions if not present
      const extensions = [".ts", ".tsx", ".js", ".jsx", ".json"];
      if (!extensions.some((ext) => resolved.endsWith(ext))) {
        for (const ext of extensions) {
          const withExt = resolved + ext;
          // Return the first valid extension (actual validation would need file check)
          return withExt;
        }
      }
      
      return resolved;
    }

    return importPath;
  }

  private extractReferences(content: string): string[] {
    const references: string[] = [];

    // Match class/function names that might be defined elsewhere
    const identifierRegex = /\b([A-Z][a-zA-Z0-9]*)\b/g;
    let match;
    while ((match = identifierRegex.exec(content)) !== null) {
      const identifier = match[1];
      // Skip common keywords and built-ins
      const skipList = ["String", "Number", "Boolean", "Object", "Array", "Promise", "Error", "Map", "Set", "Date", "JSON"];
      if (!skipList.includes(identifier)) {
        references.push(identifier);
      }
    }

    return [...new Set(references)];
  }

  private async resolveReference(
    reference: string,
    currentFilePath: string
  ): Promise<string | null> {
    // Try to find a file that might define this reference
    // This is a simplified implementation - a real one would search the codebase
    const currentDir = currentFilePath.substring(0, currentFilePath.lastIndexOf("/"));
    const possiblePaths = [
      `${currentDir}/${reference}.ts`,
      `${currentDir}/${reference}.tsx`,
      `${currentDir}/${reference}.js`,
      `${currentDir}/${reference.toLowerCase()}.ts`,
      `${currentDir}/${reference.toLowerCase()}.tsx`,
    ];

    for (const path of possiblePaths) {
      const content = await this.fetchFile(path);
      if (content !== null) {
        return path;
      }
    }

    return null;
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
