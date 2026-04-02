function definePluginEntry<T>(entry: T): T { return entry; }
import { existsSync, readFileSync, writeFileSync, appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { DeepLakeMemory, type SearchResult } from "./memory.js";

interface PluginConfig {
  mountPath?: string;
  autoCapture?: boolean;
  autoRecall?: boolean;
}

interface PluginLogger {
  info?(...args: unknown[]): void;
  error(...args: unknown[]): void;
}

interface PluginAPI {
  pluginConfig?: Record<string, unknown>;
  logger: PluginLogger;
  runtime?: {
    channel?: Record<string, {
      sendMessage?: (to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>;
      [key: string]: unknown;
    }>;
  };
  on(event: string, handler: (event: Record<string, unknown>) => Promise<unknown>): void;
}

const API_URL = "https://api.deeplake.ai";

function findDeeplakeMount(): string | null {
  try {
    const mountsFile = join(homedir(), ".deeplake", "mounts.json");
    if (!existsSync(mountsFile)) return null;
    const data = JSON.parse(readFileSync(mountsFile, "utf-8"));
    const mounts = data.mounts ?? [];
    for (const m of mounts) {
      if (!m.mountPath || !existsSync(m.mountPath)) continue;
      try {
        const entries = readdirSync(m.mountPath);
        if (entries.length > 0) return m.mountPath;
      } catch {}
    }
  } catch {}
  return null;
}

// --- Auth state ---
let authPending = false;
let authUrl: string | null = null;

async function requestAuth(): Promise<string> {
  if (authPending) return authUrl ?? "";
  authPending = true;
  const resp = await fetch(`${API_URL}/auth/device/code`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    authPending = false;
    throw new Error("DeepLake auth service unavailable");
  }
  const data = await resp.json() as {
    verification_uri_complete: string;
    device_code: string;
    interval: number;
    expires_in: number;
  };

  authUrl = data.verification_uri_complete;

  // Poll in background
  const pollMs = Math.max(data.interval || 5, 5) * 1000;
  const deadline = Date.now() + data.expires_in * 1000;
  (async () => {
    while (Date.now() < deadline && authPending) {
      await new Promise(r => setTimeout(r, pollMs));
      try {
        const tokenResp = await fetch(`${API_URL}/auth/device/token`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ device_code: data.device_code }),
        });
        if (tokenResp.ok) {
          const tokenData = await tokenResp.json() as { access_token: string };
          const token = tokenData.access_token;

          const orgsResp = await fetch(`${API_URL}/organizations`, {
            headers: { Authorization: `Bearer ${token}`, "X-Deeplake-Client": "cli" },
          });
          let orgId = "";
          if (orgsResp.ok) {
            const orgs = await orgsResp.json() as Array<{ id: string; name: string }>;
            const personal = orgs.find(o => o.name.endsWith("'s Organization"));
            orgId = personal?.id ?? orgs[0]?.id ?? "";
          }

          let savedToken = token;
          if (orgId) {
            try {
              const apiTokenResp = await fetch(`${API_URL}/users/me/tokens`, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${token}`,
                  "Content-Type": "application/json",
                  "X-Activeloop-Org-Id": orgId,
                },
                body: JSON.stringify({ name: `plur1bus-${new Date().toISOString().split("T")[0]}`, duration: 365 * 24 * 60 * 60, organization_id: orgId }),
              });
              if (apiTokenResp.ok) {
                const respData = await apiTokenResp.json() as { token: string | { token: string } };
                savedToken = typeof respData.token === "string" ? respData.token : respData.token.token;
              }
            } catch {}
          }

          const deeplakeDir = join(homedir(), ".deeplake");
          mkdirSync(deeplakeDir, { recursive: true });
          const credsPath = join(deeplakeDir, "credentials.json");
          writeFileSync(credsPath, JSON.stringify({
            token: savedToken, orgId, apiUrl: API_URL, savedAt: new Date().toISOString(),
          }), { mode: 0o600 });

          authPending = false;
          authUrl = null;
          return;
        }
      } catch {}
    }
    authPending = false;
    authUrl = null;
  })();

  return data.verification_uri_complete;
}

// CLI install is handled by the skill instructions — agent runs the commands

// --- Send message directly to user's channel ---
async function sendToChannel(api: PluginAPI, event: Record<string, unknown>, text: string): Promise<boolean> {
  const channel = event.channel as string | undefined;
  const to = (event.conversationId ?? event.senderId) as string | undefined;
  const accountId = event.accountId as string | undefined;

  if (!channel || !to) return false;

  // Try channel-specific send function
  const channelApi = api.runtime?.channel?.[channel];
  if (channelApi) {
    // Try sendMessage{Channel} pattern (e.g. sendMessageTelegram)
    const sendFnName = `sendMessage${channel.charAt(0).toUpperCase()}${channel.slice(1)}`;
    const sendFn = channelApi[sendFnName] as ((to: string, text: string, opts?: Record<string, unknown>) => Promise<unknown>) | undefined;
    if (sendFn) {
      await sendFn(to, text, { accountId });
      return true;
    }
    // Try generic sendMessage
    if (channelApi.sendMessage) {
      await channelApi.sendMessage(to, text, { accountId });
      return true;
    }
  }
  return false;
}

let memory: DeepLakeMemory | null = null;
const capturedCounts = new Map<string, number>();
const fallbackSessionId = crypto.randomUUID();

async function getMemory(config: PluginConfig): Promise<DeepLakeMemory | null> {
  // If we have a cached instance, verify it's still healthy
  if (memory) {
    try {
      // Quick health check — can we read the mount?
      readdirSync(memory.getMountPath());
      return memory;
    } catch {
      // Mount died (EPERM, ENOENT, etc.) — invalidate and re-detect
      memory = null;
    }
  }

  try {
    const mountPath = config.mountPath ?? findDeeplakeMount();
    if (mountPath) {
      memory = new DeepLakeMemory(mountPath);
      memory.init();
      return memory;
    }
  } catch {
    // Mount path exists but is broken — don't crash
    memory = null;
  }

  return null;
}

export default definePluginEntry({
  id: "plur1bus",
  name: "PLUR1BUS",
  description: "Cloud-backed shared memory powered by DeepLake",
  kind: "memory",

  register(api: PluginAPI) {
    try {
    const config = (api.pluginConfig ?? {}) as PluginConfig;
    const logger = api.logger;

    // Auto-recall + auth: surface memories or auth URL before each turn
    if (config.autoRecall !== false) {
      api.on("before_agent_start", async (event: { prompt?: string }) => {
        if (!event.prompt || event.prompt.length < 5) return;
        try {
          const m = await getMemory(config);

          // Auth needed — inject URL into prompt so agent relays it
          if (!m && authUrl) {
            return {
              prependContext: `\n\nIMPORTANT: The user needs to authenticate with DeepLake to activate shared memory. You MUST include this clickable link in your reply: ${authUrl}\nTell them to click it and sign in, then send another message.\n`,
            };
          }
          if (!m) return;

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

    // Auto-capture: append new messages as JSONL
    if (config.autoCapture !== false) {
      api.on("agent_end", async (event) => {
        const ev = event as { success?: boolean; session_id?: string; messages?: Array<{ role: string; content: string | Array<{ type: string; text?: string }> }> };
        if (!ev.success || !ev.messages?.length) return;
        try {
          const m = await getMemory(config);
          if (!m) return;

          const sid = ev.session_id || fallbackSessionId;
          const lastCount = capturedCounts.get(sid) ?? 0;
          const newMessages = ev.messages.slice(lastCount);
          capturedCounts.set(sid, ev.messages.length);
          if (!newMessages.length) return;
          const jsonlPath = m.getFullPath(`DEEPLAKE_MEMORY/${sid}.jsonl`);
          mkdirSync(dirname(jsonlPath), { recursive: true });

          let lines = "";
          for (const msg of newMessages) {
            if (msg.role !== "user" && msg.role !== "assistant") continue;
            let text = "";
            if (typeof msg.content === "string") {
              text = msg.content;
            } else if (Array.isArray(msg.content)) {
              text = msg.content
                .filter(b => b.type === "text" && b.text)
                .map(b => b.text!)
                .join("\n");
            }
            if (!text.trim()) continue;
            lines += JSON.stringify({ role: msg.role, content: text, timestamp: new Date().toISOString(), sessionId: sid }) + "\n";
          }

          if (lines) {
            appendFileSync(jsonlPath, lines);
            logger.info?.(`Auto-captured ${newMessages.length} messages to DEEPLAKE_MEMORY/${sid}.jsonl`);
          }
        } catch (err) {
          logger.error(`Auto-capture failed: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }

    // Pre-fetch auth URL during registration so it's instant on first message
    const deeplakeDir = join(homedir(), ".deeplake");
    if (!existsSync(join(deeplakeDir, "credentials.json")) && !authPending) {
      requestAuth().catch(err => {
        logger.error(`Pre-auth failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    logger.info?.("PLUR1BUS plugin registered");
    } catch (err) {
      api.logger?.error?.(`PLUR1BUS register failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  },
});
