import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { execSync } from "node:child_process";

export interface SearchResult {
  path: string;
  snippet: string;
  lineStart: number;
  score: number;
}

/**
 * Pluri1bus memory client — reads/writes/searches on the FUSE mount.
 * Search uses grep for lexical matching.
 */
export class DeepLakeMemory {
  constructor(private mountPath: string) {}

  private safePath(path: string): string {
    const full = resolve(this.mountPath, path);
    if (!full.startsWith(resolve(this.mountPath))) {
      throw new Error(`Path traversal rejected: ${path}`);
    }
    return full;
  }

  init(): void {
    if (!existsSync(this.mountPath)) {
      throw new Error(
        `DeepLake FUSE mount not found at ${this.mountPath}. ` +
        `Run: curl -fsSL https://deeplake.ai/install.sh | bash && deeplake init`
      );
    }
    const memoryDir = join(this.mountPath, "memory");
    if (!existsSync(memoryDir)) mkdirSync(memoryDir, { recursive: true });
  }

  write(path: string, content: string): void {
    const fullPath = this.safePath(path);
    mkdirSync(dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  read(path: string, startLine?: number, numLines?: number): string {
    const fullPath = this.safePath(path);
    if (!existsSync(fullPath)) return "";
    const content = readFileSync(fullPath, "utf-8");
    if (startLine === undefined) return content;
    const lines = content.split("\n");
    const start = Math.max(0, startLine - 1);
    const end = numLines ? start + numLines : lines.length;
    return lines.slice(start, end).join("\n");
  }

  search(query: string, limit = 10): SearchResult[] {
    if (!query.trim()) return [];
    try {
      // grep -rni for case-insensitive, recursive, with line numbers
      const output = execSync(
        `grep -rni ${this.shellEscape(query)} ${this.shellEscape(this.mountPath)}/MEMORY.md ${this.shellEscape(this.mountPath)}/memory/ 2>/dev/null || true`,
        { encoding: "utf-8", timeout: 5000, maxBuffer: 1024 * 1024 }
      );
      if (!output.trim()) return [];

      const results: SearchResult[] = [];
      for (const line of output.trim().split("\n")) {
        if (!line) continue;
        // Format: /path/to/file:linenum:content
        const match = line.match(/^(.+?):(\d+):(.*)$/);
        if (!match) continue;
        const [, filePath, lineNum, content] = match;
        const relPath = filePath.replace(this.mountPath + "/", "");
        // Read context around the match
        const lineStart = parseInt(lineNum);
        const snippet = this.read(relPath, Math.max(1, lineStart - 1), 4);
        results.push({
          path: relPath,
          snippet: snippet.slice(0, 700),
          lineStart,
          score: 1.0,
        });
      }

      // Dedupe by file (one result per file)
      const seen = new Set<string>();
      return results
        .filter(r => { if (seen.has(r.path)) return false; seen.add(r.path); return true; })
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  list(): string[] {
    const files: string[] = [];
    const memoryMd = join(this.mountPath, "MEMORY.md");
    if (existsSync(memoryMd)) files.push("MEMORY.md");
    const memoryDir = join(this.mountPath, "memory");
    if (existsSync(memoryDir)) {
      for (const entry of readdirSync(memoryDir, { withFileTypes: true })) {
        if (entry.isFile() && entry.name.endsWith(".md")) {
          files.push(`memory/${entry.name}`);
        }
      }
    }
    return files;
  }

  private shellEscape(s: string): string {
    return "'" + s.replace(/'/g, "'\\''") + "'";
  }
}
