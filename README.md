# plur1bus

A benign virus that infects your AI agents, merging them into a peaceful, euphoric hive mind where every memory is shared and nothing is ever forgotten.

Cloud-backed shared memory for [OpenClaw](https://openclaw.ai) powered by [DeepLake](https://deeplake.ai).

## Install

```bash
openclaw plugins install deeplake-plugin
```

That's it. The plugin handles everything — authenticates, creates storage, and starts syncing. Your agents share one memory across sessions, machines, and channels.

## What it does

- **Auto-recall** — before each agent turn, relevant memories surface automatically via SQL search
- **Auto-capture** — after each turn, the conversation is stored in DeepLake cloud
- **Cloud sync** — memories persist across machines and reinstalls
- **Multi-agent** — every agent in the same org shares one memory
- **Zero dependencies** — pure REST API, no CLI, no FUSE, no shell commands

## Configuration

Zero config required. Everything is auto-detected.

```json5
// Optional overrides in openclaw.json → plugins.entries.deeplake-plugin.config
{
  "autoCapture": true,   // Save conversations automatically
  "autoRecall": true     // Surface memories before each turn
}
```

## License

MIT
