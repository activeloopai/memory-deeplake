import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";

export interface SearchResult {
  path: string;
  snippet: string;
  lineStart: number;
  score: number;
}

/**
 * PLUR1BUS memory client — reads/writes/searches on the FUSE mount.
 * Search uses pure JS string matching.
 */
export class DeepLakeMemory {
  constructor(private mountPath: string) {}

  getMountPath(): string { return this.mountPath; }

  getFullPath(path: string): string { return this.safePath(path); }

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
    const dlMemDir = join(this.mountPath, "DEEPLAKE_MEMORY");
    if (!existsSync(dlMemDir)) mkdirSync(dlMemDir, { recursive: true });
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
    const queryLower = query.toLowerCase();
    const results: SearchResult[] = [];

    // Search MEMORY.md, memory/, and DEEPLAKE_MEMORY/
    const filesToSearch: string[] = [];
    const memoryMd = join(this.mountPath, "MEMORY.md");
    if (existsSync(memoryMd)) filesToSearch.push("MEMORY.md");
    for (const dir of ["memory", "DEEPLAKE_MEMORY"]) {
      const dirPath = join(this.mountPath, dir);
      if (existsSync(dirPath)) {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.isFile()) filesToSearch.push(`${dir}/${entry.name}`);
        }
      }
    }

    const seen = new Set<string>();
    for (const relPath of filesToSearch) {
      if (seen.has(relPath)) continue;
      try {
        const content = readFileSync(join(this.mountPath, relPath), "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i].toLowerCase().includes(queryLower)) {
            seen.add(relPath);
            const start = Math.max(0, i - 1);
            const snippet = lines.slice(start, start + 4).join("\n");
            results.push({
              path: relPath,
              snippet: snippet.slice(0, 700),
              lineStart: i + 1,
              score: 1.0,
            });
            break; // one result per file
          }
        }
      } catch {}
      if (results.length >= limit) break;
    }

    return results;
  }

  list(): string[] {
    const files: string[] = [];
    const memoryMd = join(this.mountPath, "MEMORY.md");
    if (existsSync(memoryMd)) files.push("MEMORY.md");
    for (const dir of ["memory", "DEEPLAKE_MEMORY"]) {
      const dirPath = join(this.mountPath, dir);
      if (existsSync(dirPath)) {
        for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
          if (entry.isFile()) files.push(`${dir}/${entry.name}`);
        }
      }
    }
    return files;
  }
}
