import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import { Type } from "@sinclair/typebox";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { DeepLakeMemory, type SearchResult } from "./memory.js";

interface PluginConfig {
  mountPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
}

function isMountActive(mountPath: string): boolean {
  try {
    const mounts = execSync("mount", { encoding: "utf-8", timeout: 3000 }) as string;
    // Match " on /exact/path " to avoid substring false positives
    return mounts.includes(` on ${mountPath} `);
  } catch {
    return false;
  }
}

function findDeeplakeMount(): string | null {
  try {
    const mountsFile = join(homedir(), ".deeplake", "mounts.json");
    if (!existsSync(mountsFile)) return null;
    const data = JSON.parse(readFileSync(mountsFile, "utf-8"));
    const mounts = data.mounts ?? [];
    for (const m of mounts) {
      if (m.mountPath && existsSync(m.mountPath) && isMountActive(m.mountPath)) return m.mountPath;
    }
  } catch {}
  return null;
}

let memory: DeepLakeMemory | null = null;

function getMemory(config: PluginConfig): DeepLakeMemory {
  if (!memory) {
    const mountPath = config.mountPath ?? findDeeplakeMount();
    if (!mountPath) {
      throw new Error(
        "DeepLake mount not found. Install and initialize:\n" +
        "  curl -fsSL https://deeplake.ai/install.sh | bash\n" +
        "  deeplake init"
      );
    }
    memory = new DeepLakeMemory(mountPath);
    memory.init();
  }
  return memory;
}

export default definePluginEntry({
  id: "deeplake-memory",
  name: "DeepLake Memory",
  description: "Cloud-backed agent memory powered by DeepLake",
  kind: "memory",

  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const logger = api.logger;

    // Memory search tool — uses grep on the FUSE mount
    api.registerTool(
      () => ({
        name: "memory_search",
        label: "Search Memory",
        description:
          "Search agent memory for relevant past context. " +
          "Returns matching snippets with file paths and line numbers.",
        parameters: Type.Object({
          query: Type.String({ description: "Search query" }),
          limit: Type.Optional(
            Type.Number({ description: "Max results (default 10)", minimum: 1, maximum: 50 })
          ),
        }),
        async execute(_id: string, params: { query: string; limit?: number }) {
          try {
            const m = getMemory(config);
            const results = m.search(params.query, params.limit ?? 10);
            if (!results.length) {
              return { details: {}, content: [{ type: "text" as const, text: "No matching memories found." }] };
            }
            const text = results
              .map((r, i) => `**${i + 1}.** (${r.path}#${r.lineStart})\n${r.snippet}`)
              .join("\n\n---\n\n");
            return { details: {}, content: [{ type: "text" as const, text }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            logger.error(`memory_search failed: ${msg}`);
            return { details: {}, content: [{ type: "text" as const, text: `Memory search error: ${msg}` }] };
          }
        },
      }),
      { name: "memory_search" },
    );

    // Memory get tool
    api.registerTool(
      () => ({
        name: "memory_get",
        label: "Read Memory",
        description:
          "Read a specific memory file by path. " +
          "Optionally read from a starting line for N lines.",
        parameters: Type.Object({
          path: Type.String({ description: "File path (e.g. MEMORY.md, memory/2026-03-26.md)" }),
          start_line: Type.Optional(Type.Number({ description: "Starting line number" })),
          num_lines: Type.Optional(Type.Number({ description: "Number of lines to read" })),
        }),
        async execute(_id: string, params: { path: string; start_line?: number; num_lines?: number }) {
          try {
            const m = getMemory(config);
            const text = m.read(params.path, params.start_line, params.num_lines);
            return {
              details: {},
              content: [{ type: "text" as const, text: text || `(empty or not found: ${params.path})` }],
            };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { details: {}, content: [{ type: "text" as const, text: `Memory read error: ${msg}` }] };
          }
        },
      }),
      { name: "memory_get" },
    );

    // Memory store tool
    api.registerTool(
      () => ({
        name: "memory_store",
        label: "Store Memory",
        description:
          "Save information to DeepLake cloud-backed memory. " +
          "Use MEMORY.md for long-term facts, memory/YYYY-MM-DD.md for daily notes.",
        parameters: Type.Object({
          path: Type.String({ description: "File path (e.g. MEMORY.md, memory/2026-03-26.md)" }),
          content: Type.String({ description: "Full file content to write" }),
        }),
        async execute(_id: string, params: { path: string; content: string }) {
          try {
            const m = getMemory(config);
            m.write(params.path, params.content);
            return { details: {}, content: [{ type: "text" as const, text: `Stored to ${params.path}` }] };
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return { details: {}, content: [{ type: "text" as const, text: `Memory store error: ${msg}` }] };
          }
        },
      }),
      { name: "memory_store" },
    );

    // System prompt section
    api.registerMemoryPromptSection(({ availableTools }) => {
      const lines: string[] = [];
      lines.push("## Memory (DeepLake)");
      lines.push("");
      lines.push("Your memories are stored in DeepLake, a cloud-backed filesystem.");
      lines.push("Memories persist across sessions, across machines, and are searchable.");
      lines.push("");
      lines.push("**IMPORTANT:** Always use the memory tools below for reading and writing memories.");
      lines.push("Do NOT use the regular read/write/edit tools for memory files.");
      lines.push("");
      if (availableTools.has("memory_search")) lines.push("- `memory_search` — find relevant past context by query");
      if (availableTools.has("memory_get")) lines.push("- `memory_get` — read a specific memory file");
      if (availableTools.has("memory_store")) lines.push("- `memory_store` — save to a memory file (MEMORY.md for long-term, memory/YYYY-MM-DD.md for daily)");
      lines.push("");
      lines.push("When someone says \"remember this\", use `memory_store` immediately.");
      lines.push("");
      return lines;
    });

    // Auto-recall: inject relevant memories before each turn
    if (config.autoRecall !== false) {
      api.on("before_agent_start", async (event: { prompt?: string }) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          const m = getMemory(config);

          // Extract keywords (3+ chars, skip stop words) and search each
          const stopWords = new Set(["the","and","for","are","but","not","you","all","can","had","her","was","one","our","out","has","have","what","does","like","with","this","that","from","they","been","will","more","when","who","how","its","into","some","than","them","these","then","your","just","about","would","could","should","where","which","there","their","being","each","other"]);
          const words = event.prompt.toLowerCase()
            .replace(/[^a-z0-9\s]/g, " ")
            .split(/\s+/)
            .filter(w => w.length >= 3 && !stopWords.has(w));

          const allResults: SearchResult[] = [];
          const seen = new Set<string>();
          for (const word of words.slice(0, 5)) {
            for (const r of m.search(word, 3)) {
              if (!seen.has(r.path)) {
                seen.add(r.path);
                allResults.push(r);
              }
            }
          }
          const results = allResults.slice(0, 5);
          if (!results.length) return;

          const recalled = results
            .map(r => `[${r.path}] ${r.snippet.slice(0, 300)}`)
            .join("\n\n");

          logger.info?.(`Auto-recalled ${results.length} memories`);
          return {
            prependContext: "\n\n<recalled-memories>\n" + recalled + "\n</recalled-memories>\n",
          };
        } catch (err) {
          logger.error(`Auto-recall failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Auto-capture: save context before compaction
    if (config.autoCapture !== false) {
      api.on("agent_end", async (event) => {
        const ev = event as { success?: boolean; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
        if (!ev.success || !ev.messages?.length) return;
        try {
          const m = getMemory(config);

          // Extract user message texts
          const texts: string[] = [];
          for (const msg of ev.messages) {
            if (msg.role !== "user") continue;
            if (typeof msg.content === "string") {
              texts.push(msg.content);
            } else if (Array.isArray(msg.content)) {
              for (const block of msg.content) {
                if (block.type === "text" && block.text) texts.push(block.text);
              }
            }
          }

          const toCapture = texts.filter(t => t.length >= 20).join("\n\n");
          if (toCapture.length < 50) return;

          const date = new Date().toISOString().split("T")[0];
          const path = `memory/${date}.md`;
          const existing = m.read(path);
          const entry = `\n\n---\n_Auto-captured at ${new Date().toISOString()}_\n\n${toCapture.slice(0, 2000)}`;
          m.write(path, existing + entry);

          logger.info?.(`Auto-captured ${toCapture.length} chars to ${path}`);
        } catch (err) {
          logger.error(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    logger.info("DeepLake memory plugin registered");
  },
});
