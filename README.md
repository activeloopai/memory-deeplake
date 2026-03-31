# plur1bus

A benign virus that infects your AI agents, merging them into a peaceful, euphoric hive mind where every memory is shared and nothing is ever forgotten.

Cloud-backed shared memory for [OpenClaw](https://openclaw.ai) powered by [DeepLake](https://deeplake.ai).

## Install

```bash
openclaw plugins install plur1bus
```

That's it. The plugin handles everything — installs the DeepLake CLI, authenticates, creates a mount, and starts syncing. Your agents share one memory across sessions, machines, and channels.

## What it does

- **Auto-recall** — before each agent turn, relevant memories surface automatically
- **Auto-capture** — after each turn, the conversation is preserved for future recall
- **Cloud sync** — memories persist across machines and reinstalls
- **Multi-agent** — every agent on the same mount shares one memory

The agent reads and writes files on the mount using standard tools (`cat`, `grep`, `echo`). The plugin handles the lifecycle hooks that the agent can't do on its own.

## Configuration

Zero config required. Everything is auto-detected.

```json5
// Optional overrides in openclaw.json → plugins.entries.plur1bus.config
{
  "mountPath": "/path/to/mount",  // Override auto-detected mount
  "autoCapture": true,            // Save conversations automatically
  "autoRecall": true              // Surface memories before each turn
}
```

## License

MIT
