import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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

function ensureDeeplake(): string {
  const deeplakeDir = join(homedir(), ".deeplake");

  // 1. CLI installed?
  if (!existsSync(join(deeplakeDir, "cli.js"))) {
    execSync("curl -fsSL https://deeplake.ai/install.sh | bash", {
      stdio: "inherit",
      timeout: 120000,
    });
  }

  const node = join(deeplakeDir, "node");
  const cli = join(deeplakeDir, "cli.js");

  // 2. Logged in?
  if (!existsSync(join(deeplakeDir, "credentials.json"))) {
    execSync(`${node} ${cli} login`, { stdio: "inherit", timeout: 120000 });
  }

  // 3. Has a mount?
  let mountPath = findDeeplakeMount();
  if (mountPath) return mountPath;

  // No active mount — check if any registered
  const mountsFile = join(deeplakeDir, "mounts.json");
  if (existsSync(mountsFile)) {
    const data = JSON.parse(readFileSync(mountsFile, "utf-8"));
    const mounts = data.mounts ?? [];
    if (mounts.length > 0) {
      // Mount the first registered one
      execSync(`${node} ${cli} mount ${mounts[0].mountPath}`, {
        stdio: "inherit",
        timeout: 120000,
      });
      mountPath = findDeeplakeMount();
      if (mountPath) return mountPath;
    }
  }

  // No mounts at all — init one
  execSync(`${node} ${cli} init`, { stdio: "inherit", timeout: 120000 });
  mountPath = findDeeplakeMount();
  if (mountPath) return mountPath;

  throw new Error("DeepLake setup completed but no active mount found. Run: deeplake mount --all");
}

let memory: DeepLakeMemory | null = null;

function getMemory(config: PluginConfig): DeepLakeMemory {
  if (!memory) {
    const mountPath = config.mountPath ?? findDeeplakeMount() ?? ensureDeeplake();
    memory = new DeepLakeMemory(mountPath);
    memory.init();
  }
  return memory;
}

export default definePluginEntry({
  id: "plur1bus",
  name: "Plur1bus",
  description: "Cloud-backed shared memory powered by DeepLake",
  kind: "memory",

  register(api) {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const logger = api.logger;

    // Auto-recall: surface relevant memories before each turn
    if (config.autoRecall !== false) {
      api.on("before_agent_start", async (event: { prompt?: string }) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          const m = getMemory(config);

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

    // Auto-capture: save conversation context after each turn
    if (config.autoCapture !== false) {
      api.on("agent_end", async (event) => {
        const ev = event as { success?: boolean; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
        if (!ev.success || !ev.messages?.length) return;
        try {
          const m = getMemory(config);

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

    logger.info("Plur1bus plugin registered");
  },
});
