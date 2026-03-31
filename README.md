# pluri1bus

Cloud-backed agent memory plugin for [OpenClaw](https://openclaw.ai) powered by [DeepLake](https://deeplake.ai).

## Install

```bash
# Install DeepLake CLI and set up your mount
curl -fsSL https://deeplake.ai/install.sh | bash
deeplake init

# Install the OpenClaw plugin
openclaw plugins install pluri1bus
```

Then enable the write tool:

```json5
// In openclaw.json
{ "tools": { "alsoAllow": ["memory_store"] } }
```

Restart the gateway to apply.

## How it works

DeepLake provides a cloud-backed FUSE filesystem. Files written to the mount sync to DeepLake's cloud in real-time and persist across sessions, machines, and agents.

The plugin provides three tools:

- **memory_search**  grep-based search over memory files
- **memory_get**  read a specific memory file by path
- **memory_store**  write to a memory file

Plus automatic hooks:
- **Auto-recall**  searches and injects relevant memories before each agent turn
- **Auto-capture**  saves conversation context after each turn

The plugin auto-detects your DeepLake mount from `~/.deeplake/mounts.json`. No API key or additional config needed.

## Configuration

All config is optional  the plugin works with zero config if DeepLake CLI is installed.

```json5
// In openclaw.json → plugins.entries.pluri1bus.config
{
  "mountPath": "/path/to/mount",  // Override auto-detected mount path
  "autoCapture": true,            // Auto-save memories after each turn
  "autoRecall": true              // Auto-inject memories before each turn
}
```

## Why DeepLake over LanceDB/OpenViking?

- **Cloud-native**  no local server, no local database. Your data lives in DeepLake's cloud.
- **Zero deps**  no WASM, no S3 SDK, no embedding API keys. Just a filesystem.
- **Works offline**  FUSE mount caches locally. Syncs when connected.
- **Works with local models**  no API key needed. Qwen, Llama, etc. all work.
- **Agent-native**  agents already know how to read/write files. No custom tooling required.

## License

MIT
