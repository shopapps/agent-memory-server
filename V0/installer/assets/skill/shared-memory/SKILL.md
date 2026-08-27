---
name: shared-memory
description: Use the local Agent Memory MCP server to recall durable project context and save reusable knowledge across sessions. Use when prior work may help, when resuming a project, or when a verified fact or decision should survive. Keep tasks and issue state in Beads or the project's task tracker.
---

# Shared memory

Use the Agent Memory MCP tools when they are available. Do not invent memory
results when the server is missing or unhealthy.

## Read memory

- Search at the start of related work when earlier decisions or fixes may help.
- Prefer `memory_prompt` for a small context block and
  `search_long_term_memory` when you need individual records.
- Use `project_id` for the repository or project family.
- Use `agent_id` only for memory meant for one agent. Leave it empty for memory
  that Codex and Claude should share.
- Use `session_id` only for one conversation. Use `user_id` only for private
  user context.
- Keep private scopes exact. Never broaden them to find more results.
- For hierarchical namespaces, request parent inheritance only when the current
  namespace should inherit its exact parents.
- A useful starting budget is 300 tokens for a quick prime and 800 tokens for a
  normal search. Prefer whole memories over cut-off fragments.

## Write memory

Use `create_long_term_memories` for small, durable, verified knowledge such as:

- an architectural decision;
- a stable project rule;
- a confirmed workaround and its cause;
- a reusable handoff fact.

Write one clear fact per memory. Include the narrowest useful namespace and
scope. Do not store secrets, raw chat logs, transient command output, guesses,
or information that is useful only for the current turn.

If a feedback tool is available, mark retrieved memories as useful or not useful
after the result is known. Do not invent a feedback call when the tool is absent.

## Beads and task trackers

Memory stores knowledge. Beads or the project's issue tracker stores work.
Never copy backlog items, assignments, blockers, or issue status into memory.
