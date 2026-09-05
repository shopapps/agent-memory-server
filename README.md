# Shopapps Agent Memory

## Project memory for Codex and Claude

Stop explaining the same project rules in every new chat.

Give your coding agents a shared notebook on your Mac. Keep useful decisions,
find them in later sessions, and see what your agents remember in a live,
clickable memory graph.

**[Install](#install-on-a-mac)** · **[See the features](#what-you-get)** ·
**[Full guide](./INSTALL.md)** · **[API and developer docs](./V0/docs/index.md)**

## Install on a Mac

You need **Node.js 20+**, **Git**, **Docker Desktop running**, and
**Codex Desktop or Claude Code**. Codex CLI is not required for Desktop users.

Run these two commands in Terminal:

```bash
git clone https://github.com/shopapps/agent-memory-server.git && cd agent-memory-server
./ams docker:install --working-memory --promotion review
```

Already have this checkout? Run just the second command from its root.

The guided installer builds and starts Redis, the memory server and its worker,
then connects your chosen agents. It adds the memory Skill, tool connection and
a small rules block without replacing your existing instructions. Choose user
scope to cover all your Git projects, or project scope for one repository.

This command also enables recent-chat capture. **Review mode lets you check
suggested facts before they become long-term shared memories.** Agent-requested
saves through memory tools are separate. Omit `--working-memory --promotion review`
if you only want agent-chosen reads and writes.

Accept the hook trust prompt in your agent when shown, then start a new task.
See the [full setup guide](./INSTALL.md#working-memory) for client details.

The default AI setup uses your OpenAI API key. You can skip it during install,
but AI filtering and embedding-based memory work need a configured provider.
The installer does not supply API credits; hosted AI use can incur provider charges.
[Add a key later](./INSTALL.md#add-an-openai-key-after-install) or
[configure another provider](./V0/docs/llm-providers.md).

**No npm release is required:** the installer runs from this checkout.
Do not use `npx @shopapps/agent-memory@latest`; that package is not published.

[Manual install, prerequisites and troubleshooting →](./INSTALL.md)

## See your memory

![An anonymised example of the memory graph](./V0/docs/images/memory-graph-example.png)

*Illustration with generic labels—not live project data.*

After install, open:

- **[Memory graph](http://127.0.0.1:8000/admin/memories/graph)** — explore, search,
  edit and organise saved facts.
- **[Working Memory](http://127.0.0.1:8000/admin/working-memory)** — see recent
  capture, review suggestions and check progress.
- **[API docs](http://127.0.0.1:8000/docs)** — try the server's HTTP API.

## What you get

| What you want | What Agent Memory does |
| --- | --- |
| Stop repeating project context | Shares durable facts between Codex and Claude on the same Mac, with separate project scopes. |
| Remember useful work automatically | Optional hooks capture recent prompts and final replies. Review suggestions yourself, or opt into automatic saving. |
| Bring context into a new task | Returns a small set of saved project facts and clearly labelled recent chat. |
| Keep a small handoff from a long chat | Optional, expiring excerpts retain earlier user-backed suggestions without another AI call. |
| Find facts even when wording changes | Supports meaning-based, keyword and combined search, with bounded results. |
| Understand what was saved | A live graph links projects, topics, entities and memories. Click to inspect, pan or zoom. |
| Correct a wrong fact | Edit a memory, inspect up to 20 earlier edits, and undo. Stale edits are rejected instead of overwriting newer changes. |
| Know whether capture is working | See received, checked, waiting, reviewed and saved counts. Follow a saved fact straight to its graph node. |
| Recover from a local outage | A small private queue retries permitted capture on the next enabled hook run. |
| Move current project facts | Export a project, preview a restore, and add missing facts without overwriting conflicting IDs. |
| Bring useful notes with you | Preview Markdown or Claude-Mem facts offline, then choose exactly which ones to save. |
| Watch filtering use | See reported AI tokens and set a daily pause threshold. It is not a hard spending cap. |
| Build your own integration | Use the HTTP API, Python client or MCP—the tool connection coding agents use. |

Working Memory keeps up to **30 exchanges for seven days**. Durable saved facts
are separate from that short-term chat. The graph checks for changes every
**10 seconds** without resetting your view.

## Try it in two tasks

In your project's first task:

> Save this as a shared project convention: use “Example Customer” in sample
> customer records. Tell me the saved memory ID.

In a new task for the same project:

> Search shared memory for our sample customer convention. Give me the saved
> name and matching memory ID. Do not answer from this chat alone.

The IDs should match. This tests an explicit save and later recall.
[Try the separate automatic-capture test](./INSTALL.md#working-memory).

## Stay in control

- **Local storage, not necessarily local AI.** The chosen provider receives
  text for filtering and embeddings. [Local model setup](./V0/docs/llm-providers.md#ollama-local-models)
  is available if you want to configure it yourself.
- **Capture is optional.** Private markers and common secret patterns are
  omitted before capture, but no automatic filter catches every secret.
  Keep credentials and sensitive customer data out of memory.
- **One Mac is the current supported quickstart.** Separate Macs do not sync.
  Project filters are not team access controls. Do not expose this local,
  authentication-disabled setup to a network.
- **Your existing files stay yours.** Rules updates replace only the marked
  block. Uninstall keeps the memory database and secret file.
- **Undo covers edits, not deletion.** Deleting a memory also deletes its edit
  history. Project exports contain current shared facts, not a full database
  backup.

[Privacy, retention and costs](./INSTALL.md#working-memory) ·
[Export and restore](./INSTALL.md#export-and-restore-project-facts)
· [Import selected notes](./INSTALL.md#import-selected-notes-or-claude-mem-facts)

## Everyday commands

Run from the repository root:

```bash
./ams doctor                  # Check setup and capture activity
./ams docker:up               # Start the installed stack
./ams docker:reset            # Rebuild this checkout; keep the memory database
```

After updating capture code, refresh the installed hook files too:

```bash
./ams working-memory update --agents all --scope user --yes
```

Use `--agents codex` or `--agents claude` for just one client. For a project-only
install, use the [matching project scope](./INSTALL.md#working-memory).
Restarting the agent does not rebuild Docker or copy changed hook files.

## Build on it

Source, tests and build commands live in [V0/](./V0/).
Read [V0/README.md](./V0/README.md) for the developer setup,
[ARCHITECTURE.md](./ARCHITECTURE.md) for the design, and
[INSTALL.md](./INSTALL.md) for the complete quickstart and manual steps.

The Shopapps fork is under active development. The features above describe
this checkout; unreleased changes are not included in upstream Docker images.

## Redis Agent Memory in Redis Iris

This fork builds on the open-source
[Redis Agent Memory Server](https://github.com/redis/agent-memory-server).
Credit to Redis and the upstream contributors for the foundation.

Redis's separate supported product is
[Redis Agent Memory in Redis Iris](https://redis.io/agent-memory/).
It is not installed by this Mac quickstart.

## License

[Apache License 2.0](./LICENSE).
