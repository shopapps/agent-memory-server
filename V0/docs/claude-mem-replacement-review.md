# Replacing Claude Mem with Agent Memory

Reviewed on 4 September 2026. This is a readiness review, not an uninstall
instruction. No settings, hooks, stored memories or running services were
changed as part of this review.

**Update, 5 September 2026:** the current Shopapps source now includes offline
capture retry, visible processing and doctor checks, saved-fact recall, optional
expiring handoff excerpts, and a reviewed importer for selected Claude-Mem
observation facts. See the [current install guide](../../INSTALL.md#working-memory)
and [import instructions](../../INSTALL.md#import-selected-notes-or-claude-mem-facts).
Handoff excerpts are not full session summaries; tool-output capture and full
Claude-Mem history transfer are still not provided. The findings below record
the earlier review, not the current feature list or your current install state.

## Bottom line

Agent Memory can replace the basic recent-chat and shared-project-memory
workflow. It is not yet a like-for-like copy of Claude Mem. Prove that a new
agent session receives recent context and can find a saved project fact before
switching Claude Mem off. Keep a backup of its existing history.

## What is different?

Claude Mem is not just a rolling list of prompts. Its documented Claude Code
flow captures tool-use observations, compresses them, makes session summaries
and feeds earlier context into later sessions. Its search tools return an
index, nearby events in time, and full observation details.
[Overview](https://docs.claude-mem.ai/introduction),
[hook lifecycle](https://docs.claude-mem.ai/architecture/hooks),
[search tools](https://docs.claude-mem.ai/usage/search-tools).

| Area | Claude Mem | This fork's capture stage |
| --- | --- | --- |
| What is kept | Prompts and compressed observations of tool use | User prompts and final replies; no tool output or transcript scraping |
| Recent context | Prior observations and session summaries | Up to 30 exchanges per session, with seven-day expiry |
| Longer history | Searchable observations, summaries and timeline | Reviewed or opt-in automatically saved project facts in the long-term graph |
| What gets lost | Depends on its own settings and stored history | Old chat and unsaved candidates when their source is trimmed or expires |
| Start of a session | Prior context added through hooks | Recent context requested for the exact local user and project |

Claude behavior above is described in its
[hook lifecycle](https://docs.claude-mem.ai/architecture/hooks) and
[search docs](https://docs.claude-mem.ai/usage/search-tools).
Agent Memory behavior is defined in
[Working Memory](working-memory.md#automatic-agent-capture) and the
[installed hook runner](../installer/assets/working-memory-hook.mjs).
The existing generic Working Memory API has summarization features, but the
new agent-capture stage does **not** use them to preserve evicted chat.

The official Codex plugin also declares start, prompt, tool-use and stop
hooks. These declarations alone do not prove that every event works in a
particular installed Codex Desktop build. Check the actual local plugin and
real captured records rather than assuming Claude Code and Codex behave the
same way.
[Codex hook source](https://github.com/thedotmack/claude-mem/blob/main/plugin/hooks/codex-hooks.json).

## Local checks in this review

Read-only checks found:

- Agent Memory capture enabled in the local Codex settings, using review mode.
- The installed runner matches this checkout, and its three hooks are trusted.
- The live local server has five user messages, five final replies and three
  pending suggestions for this project. Capture is receiving real messages.
- The exact-scope recall endpoint returns recent context. This proves retrieval,
  not that a new Desktop session has received it automatically.
- The Working Memory page includes the latest local-ID auto-fill.
- The `claude-mem@claude-mem-local` plugin remains enabled.
- Its installed Codex hooks include `PreToolUse` for file context and
  `PostToolUse` for observations, plus start, prompt and stop hooks.

These checks used local settings, hook registrations and the exact
user/project sessions endpoint. They did not inspect private message text.
They do not yet prove that a fresh Desktop session gets the context, or that
a reviewed fact is saved and later found through the agent's memory tools.

## What to prove before switching

1. **Capture both sides.** In a small test project, make one harmless statement
   and get a reply. Confirm both appear under that project in Working Memory.
2. **Recall in a new session.** Start a fresh agent session in the same project.
   Ask about the test statement without giving it the answer again. Check that
   the answer came from Agent Memory, not Claude Mem or the old chat.
3. **Keep a useful fact.** Review and save one suggested project fact. Find it
   using the agent's long-term search and the graph. It must not depend on the
   short-term record remaining present.
4. **Check privacy and scope.** Use a fake `<private>` example, not a real secret.
   Confirm it is omitted. A different project must not receive this project's
   recent chat. Agent Memory's capture runner omits sensitive exchanges and
   only connects to a local server; the later filtering step can send permitted
   chat to the configured model provider.
5. **Check normal use.** After a Desktop restart, confirm new sessions continue
   to arrive, filtering finishes, and saved facts remain searchable. A health
   check alone is not proof of these paths.

The expected local behavior and limits are in the
[install guide](../../INSTALL.md#working-memory) and
[capture documentation](working-memory.md#automatic-agent-capture).
These are proposed acceptance checks, not claims that all five passed.

For stronger Claude Mem parity, the main optional additions are compact
session summaries before chat expires, useful tool-result capture, and a
history search/timeline. These are not required if recent chat plus selected
long-term facts is the intended product. Capturing more data also needs a
clear privacy and model-cost choice.

Two practical gaps are worth addressing before relying on this as the only
memory system:

- **Clear health checks and retries.** The capture hook quietly skips failed
  events; it has no saved retry queue for a stopped server. The current doctor
  command does not prove that hooks ran. A last-capture/last-recall status would
  make failures visible. See the [hook runner](../installer/assets/working-memory-hook.mjs)
  and [current limits](../../INSTALL.md#limits-hooks-and-privacy).
- **Automatic recall of lasting facts.** The capture start hook loads recent
  chat, not relevant long-term facts. Long-term search exists, but agents use
  it through the shared-memory rules and tools. Including a small set of
  relevant saved facts at session start could make recall more dependable.
  See the [recall endpoint](../agent_memory_server/working_memory_capture.py)
  and [shared-memory rules](../installer/assets/rules/shared-memory.md).

## Preserve the old history

Claude Mem documents JSON export of observations, sessions, summaries and
prompts, including project filtering. Those exports contain plain text and
can contain private data. Its import script targets another **Claude Mem**
installation; it is not an Agent Memory importer. Keep the export private.
Importing selected useful facts into this fork would need an explicit mapping
and duplicate checks; do not load all old chat straight into the graph.
[Export/import guide](https://docs.claude-mem.ai/usage/export-import).

Its default local data directory is `~/.claude-mem`, but
`CLAUDE_MEM_DATA_DIR` can move it. Resolve the actual directory before backing
it up. A full backup and a selective JSON export serve different purposes.
[Installation data locations](https://docs.claude-mem.ai/installation).

## Switch off first; uninstall later

After a backup, use a reversible trial with only Agent Memory supplying
memory context. Disable the exact installed Claude Mem plugin and check for
separately registered hooks or watchers. Keep its database. Once the tests
above pass during normal work, remove the plugin through its actual install
route. This is a recommendation; nothing was disabled here.

The upstream `npx claude-mem uninstall` implementation currently stops its
worker, removes plugin registrations and caches, and says it preserves the
main data directory. It also changes some settings. Treat that as behavior of
the reviewed source, not a guarantee about every installed version or a
Desktop-only plugin. Do not use data-purge commands during this transition.
[Uninstall source](https://github.com/thedotmack/claude-mem/blob/main/src/npx-cli/commands/uninstall.ts).

The current upstream Codex cleanup disables plugin entries and removes its
marketplace only when the Codex command is available. It also removes old
managed context blocks. A Desktop-only setup therefore needs a check of its
own plugin state after removal; running an npm command is not sufficient proof.
[Codex installer/removal source](https://github.com/thedotmack/claude-mem/blob/main/src/services/integrations/CodexCliInstaller.ts).
