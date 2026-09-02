# Shared Agent Memory Architecture

Status: proposed V1 architecture for the `shopapps/agent-memory-server` fork.

The code that this design extends lives in [`V0/`](./V0/). The fork remains based
on Redis Agent Memory Server V0; this is an evolution of that code, not a rewrite.

## 1. Purpose

Build a fast shared memory service for Codex, Claude, and other agents. It should
return a small amount of useful context, keep unrelated domains apart, explain
why a memory was returned, and maintain itself without losing useful history.

The main design rule is:

> Store only durable knowledge, then return the smallest useful set for the
> current task.

Beads remains the system for tasks, blockers, dependencies, and work status.
This server stores knowledge. In short:

- Beads answers **what needs doing**.
- Agent Memory answers **what we know**.

A memory may link to a Beads issue, for example `bead://project-123`, but it must
not copy the issue or become another task tracker.

## 2. Goals

- Keep Redis as the primary live store.
- Keep the existing async Python, RedisVL, REST, MCP, and Docket design.
- Provide a Skill that tells agents when and how to use memory.
- Isolate memory with hierarchical namespaces and independent project, user,
  agent, and session scopes.
- Search by meaning and exact words using semantic plus BM25 hybrid retrieval.
- Return results within a caller-supplied token budget.
- Reject low-value memory before it reaches long-term storage.
- Rank durable, trusted, and useful memory above weak or stale memory.
- Keep temporal history by superseding old facts instead of overwriting them.
- Link memories through lightweight Redis-backed entities.
- Record an audit history for writes, feedback, lifecycle changes, and access.
- Let users and agents give explicit feedback about returned memories.
- Move old detail to readable Markdown or JSONL cold archives.
- Keep search fast and avoid an LLM call on the normal read path.
- Make every new feature testable through the existing unit and Redis
  integration test structure.

## 3. Non-goals for V1

- A full graph database such as Neo4j, Memgraph, or Graphiti.
- Image, audio, video, or other multimodal memory.
- Replacing Redis with a separate vector database.
- Replacing Beads, source files, Git history, or project documentation.
- Saving full conversations as the main long-term memory unit.
- Adding a large general-purpose query language before normal use cases need it.
- Calling an LLM for every search.
- Automatically deleting low-use facts only because they are old.
- Cross-namespace search by default.

## 4. Existing foundation

V0 already provides most of the base:

- `WorkingMemory` for session-scoped messages, structured memories, and summary
  context.
- `MemoryRecord` for persistent Redis-backed memory.
- automatic working-memory extraction and promotion.
- semantic, keyword, and hybrid search through `MemoryVectorDatabase` and
  `RedisVLMemoryVectorDatabase`.
- exact and semantic duplicate compaction.
- `namespace`, `user_id`, `session_id`, topics, entities, and `event_date`.
- `last_accessed`, `access_count`, pinned memories, recency reranking, and hard
  forgetting rules.
- REST endpoints in `agent_memory_server/api.py`.
- MCP tools in `agent_memory_server/mcp.py`.
- Redis index setup in `agent_memory_server/memory_vector_db_factory.py`.
- background work through Docket tasks.
- token counting helpers based on `tiktoken`, with a safe estimate fallback.

V1 should extend those seams. Searches must continue to use RedisVL query types,
as required by `V0/AGENTS.md`.

## 5. System overview

```text
Codex / Claude / other agent
              |
       shared-memory Skill
      when to read and write
              |
              v
       MCP or REST interface
              |
       admission + retrieval
              |
    +---------+----------+
    |                    |
    v                    v
Redis Hash/Search     Redis Streams
memories, vectors,    audit and access
scopes, entities      events
    |                    |
    +---------+----------+
              |
        Docket workers
  decay, compact, archive,
  reconcile, export events
              |
              v
    Markdown / JSONL archive
```

The Skill is the policy guide used by agents. MCP is the common tool interface.
REST remains available for apps and tests. Both interfaces call the same core
Python services.

Redis is the source of truth for live memory. Markdown and JSONL are cold,
human-readable exports, not live indexes.

## 6. Memory model

### 6.1 Atomic memory

The main storage unit is one clear fact, decision, preference, procedure,
reference, episode, or observation. It is not a raw chat chunk.

V1 extends the current `MemoryRecord` rather than creating a second unrelated
record type. A target record looks like this:

```json
{
  "id": "01K...",
  "version": 3,
  "text": "Archive events are transported through RabbitMQ.",
  "memory_type": "semantic",
  "kind": "decision",

  "namespace": "coding/shopapps/archive",
  "project_id": "shopapps/archive-content-relay",
  "user_id": "paul",
  "agent_id": null,
  "session_id": null,

  "importance": 0.9,
  "confidence": 1.0,
  "status": "active",
  "pinned": false,

  "created_at": "2026-08-26T20:00:00Z",
  "updated_at": "2026-08-26T20:00:00Z",
  "event_at": "2026-07-09T10:00:00Z",
  "valid_from": "2026-07-09T10:00:00Z",
  "valid_until": null,
  "expires_at": null,
  "last_accessed": "2026-08-26T20:00:00Z",
  "last_confirmed_at": "2026-08-26T20:00:00Z",

  "access_count": 18,
  "reinforcement_count": 5,
  "feedback_score": 0.2,

  "topics": ["archive", "transport"],
  "entity_ids": ["entity:rabbitmq", "entity:archive-event"],
  "entities": ["RabbitMQ", "archive event"],

  "supersedes_id": null,
  "superseded_by_id": null,
  "compacted_into_id": null,

  "source": {
    "type": "bead",
    "uri": "bead://acr-123",
    "agent_id": "codex",
    "session_id": "session-abc"
  },
  "metadata": {}
}
```

### 6.2 Field rules

- `id` is a ULID unless a trusted client supplies a stable ID.
- `version` starts at 1 and supports safe concurrent updates.
- `memory_type` keeps V0 compatibility: `semantic`, `episodic`, or `message`.
- `kind` adds useful policy detail: `fact`, `decision`, `preference`,
  `procedure`, `reference`, `episode`, or `observation`.
- `task` is not a valid kind. Tasks belong in Beads.
- `importance` and `confidence` are numbers from 0.0 to 1.0.
- `event_at` is when the described event happened.
- `valid_from` and `valid_until` say when a fact was true.
- `expires_at` says when a memory must stop appearing in normal results.
- `created_at` and `updated_at` describe the record, not the event.
- `event_date` remains a supported API alias during migration, but the V1
  canonical name is `event_at`.
- `entities` stays as readable compatibility data. `entity_ids` holds stable
  links to canonical entity records.
- `source` provides provenance without copying the full source document.
- vectors remain internal and are never returned to an agent.

### 6.3 Redis layout

Keep the existing Redis Hash plus Redis Search design.

```text
memory_idx:<memory_id>             live memory hash
entity:<entity_id>                 canonical entity hash
entity:memories:<entity_id>        set of linked memory IDs
memory:events                      immutable audit stream
memory:access-events               high-volume access stream
memory:idempotency:<operation_id>  short-lived operation result
```

The RedisVL schema gains indexed tag fields for `project_id`, `agent_id`,
`status`, `kind`, and `entity_ids`; numeric fields for importance, confidence,
version, temporal values, counts, and feedback; and keeps the existing text and
vector fields.

Schema changes use the existing migration command and migration module. A new
index can be built beside the old one and switched after backfill so search
stays available.

## 7. Namespace and scope rules

### 7.1 Namespace

A namespace describes the subject area. It is a slash-separated path:

```text
coding
coding/laravel
coding/shopapps
coding/shopapps/archive
dnd/5e/2024
dnd/campaigns/phandelver
```

Rules:

- no leading or trailing slash.
- no empty segments, `.` segments, or `..` segments.
- compare a normalized form, while keeping a display label if needed.
- a write always has one namespace. Legacy null namespaces migrate to a named
  default such as `global` chosen by the operator.
- a search starts at one namespace.
- `inherit_parents=true` searches the exact namespace and its parents.
- `inherit_global=true` may add the configured global namespace.
- `cross_namespace=false` by default. Sideways search requires an explicit list
  of allowed namespaces.

For `coding/shopapps/archive`, parent inheritance may read:

```text
coding/shopapps/archive
coding/shopapps
coding
```

It must not read `dnd` or `coding/laravel` unless the caller asks for them.
Parent paths should be expanded into exact Redis tag filters. The existing
`startswith` filter is useful for subtree administration, but it is too broad
for safe parent inheritance.

### 7.2 Independent scopes

Scopes answer who and what a memory belongs to:

- `project_id`: project or repo family, for example
  `shopapps/archive-content-relay`.
- `user_id`: user-owned knowledge.
- `agent_id`: knowledge private to or written for one agent.
- `session_id`: one run or conversation.

A null scope means **shared at that dimension**, not "match everything".

Default reads include:

- the caller's exact project plus project-shared memory when requested.
- the caller's exact user plus user-shared memory when requested.
- the caller's exact agent plus agent-shared memory when requested.
- the exact session only when session memory is requested.

They never include another user's, agent's, project's, or session's private
memory. Wildcard administration is a separate permission, not a search default.

The server must build these filters from authenticated caller context where
possible. A client must not gain access simply by putting another `user_id` in a
tool call.

Namespace and project solve different problems. Namespace is a knowledge tree;
project is an ownership boundary. They must stay as separate fields.

## 8. Memory admission

The best way to stop bloat is to refuse weak memory before storing it.

### 8.1 Admission pipeline

```text
candidate
   |
   v
validate and normalize
   |
   v
scope and safety checks
   |
   v
exact hash + near-duplicate search
   |
   v
durability / usefulness / confidence check
   |
   +-- new and useful ------> ADD
   +-- already known -------> REINFORCE
   +-- changed truth -------> SUPERSEDE
   +-- unclear conflict ----> REVIEW
   +-- weak or temporary ---> REJECT
```

### 8.2 Deterministic rules first

Reject or review a candidate when any of these is true:

- text is empty, vague, or still contains unresolved references such as "it"
  or "that project".
- it is a task, progress update, routine chat, transient thought, secret, or
  unverified guess.
- the namespace or caller scope is missing or not allowed.
- it repeats an exact memory without new evidence.
- confidence is below the configured threshold.
- it has no likely value in a later session.
- it is already represented by source files or Beads and adds no durable lesson.

Accept likely decisions, stable facts, verified fixes, preferences, procedures,
constraints, and durable references.

Use deterministic checks for known cases. An optional cheap model may classify
unclear candidates, but it must return a structured decision and reason. A model
failure must not silently admit the candidate.

### 8.3 Importance and confidence

The caller may suggest values, but the server owns the final values.

- importance measures future value.
- confidence measures how well the memory is supported.
- repeated confirmation increases `reinforcement_count` and may raise
  confidence.
- importance cannot exceed a configured ceiling without trusted evidence or a
  privileged caller.
- admission stores its decision and reason in the audit stream.

The response reports `added`, `reinforced`, `superseded`, `rejected`, or
`review`, plus the affected memory IDs. Rejection is a normal result, not a
server error.

## 9. Retrieval and scoring

### 9.1 Candidate retrieval

1. Resolve authenticated project, user, agent, and session scopes.
2. Expand the requested namespace into allowed exact parents.
3. Exclude expired, archived, compacted, and superseded records unless history
   was requested.
4. Ask RedisVL for an over-fetched candidate set using hybrid semantic and BM25
   search.
5. Add candidates linked to entities found in the query.
6. Optionally run a configured second-pass reranker in `quality="deep"` mode.
7. Apply lifecycle, scope, time, strength, and feedback factors.
8. Pack the best diverse results into `max_tokens`.
9. Update access history asynchronously only for memories actually returned.

Normal search has no LLM call. The optional reranker is behind an interface and
is disabled by default.

### 9.2 Starting score model

All raw search signals are normalized to 0.0-1.0. Missing signals cause the
remaining weights to be rebalanced.

```text
content_score =
    0.55 * semantic_score
  + 0.30 * bm25_score
  + 0.15 * entity_score

soft_strength = clamp(0.30, 1.50,
    0.55
  + 0.30 * access_recency
  + 0.15 * access_frequency
  + 0.30 * importance
  + 0.20 * confidence
  + feedback_adjustment)

final_score = content_score
            * soft_strength
            * namespace_factor
            * temporal_factor
            * lifecycle_factor
```

Starting factors:

- exact namespace: `1.00`.
- each parent hop: multiply by `0.92`, with a floor of `0.75`.
- active: `1.00`; dormant: `0.70`; superseded/archived: excluded normally.
- explicit temporal match: up to `1.15`; outside validity: excluded.
- useful feedback raises strength; incorrect or outdated feedback flags review
  and sharply lowers or excludes the memory.

The numbers are starting settings, not hidden constants. Tests and real search
logs should tune them.

`access_recency` uses a half-life based on `last_accessed`.
`access_frequency` uses a capped logarithm of `access_count` so popular memories
do not dominate forever. Importance, confidence, pinned state, and memory kind
protect rarely used but critical knowledge.

Every debug result may include:

```json
{
  "score": 0.87,
  "score_details": {
    "semantic": 0.81,
    "bm25": 0.92,
    "entity": 0.75,
    "access_recency": 0.84,
    "access_frequency": 0.66,
    "importance": 0.90,
    "confidence": 1.00,
    "namespace_factor": 1.00,
    "temporal_factor": 1.00,
    "lifecycle_factor": 1.00
  }
}
```

This detail is returned only when `debug=true`.

### 9.3 Entity linking

Entity extraction already produces readable names. V1 adds canonical records:

```json
{
  "id": "entity:rabbitmq",
  "name": "RabbitMQ",
  "normalized_name": "rabbitmq",
  "type": "technology",
  "aliases": ["rabbit mq"],
  "namespace": "coding",
  "project_id": null
}
```

On admission, the server resolves extracted names to entity IDs, creates safe
new entities, and updates Redis sets linking entities to memories. Search finds
query entities and gives linked memories an entity score.

Entity links are lightweight lookup edges. V1 does not add graph traversal or a
graph database.

## 10. Token-budget retrieval

`limit` alone is not enough because ten long memories can waste far more context
than ten short memories.

Search and prime accept:

- `max_tokens`: hard output budget for memory content and its small wrapper.
- `max_results`: safety cap, not the main budget.
- `tokenizer`: optional known model/tokenizer name.
- `include_fields`: optional response detail.

The server uses the existing `tiktoken` helper where possible and the existing
character estimate fallback otherwise.

Packing rules:

1. Reserve tokens for the response wrapper.
2. Rank an over-fetched candidate set.
3. Add the highest-value memory that fits.
4. Avoid near-duplicate results and keep useful topic diversity.
5. Do not split an atomic memory by default.
6. Skip an oversized result and try the next one.
7. Return `tokens_used`, `token_budget`, `budget_exhausted`, and a continuation
   cursor.

Pinned memory is preferred but is not allowed to silently break the hard budget.
An administrator may set a separate maximum size for one stored memory.

Suggested defaults:

- `memory.prime`: 300 tokens.
- normal `memory.search`: 800 tokens.
- deep search: 1,500 tokens.

The caller can lower these values.

## 11. Lifecycle

### 11.1 States

```text
working -> candidate -> active -> dormant -> compacted -> archived
                           |          |            |
                           +------> superseded ----+
```

- `working`: current session data, using the existing working-memory TTL and
  summary flow.
- `candidate`: extracted but not yet admitted.
- `active`: included in normal search.
- `dormant`: still searchable, but ranked lower.
- `superseded`: kept for history and time-aware queries, excluded from current
  truth by default.
- `compacted`: detailed memories represented by a summary memory.
- `archived`: removed from the hot index after durable export.

Hard deletion is an explicit privileged action or a retention/legal rule. It is
not the normal result of low access.

### 11.2 Supersession

When a new memory changes an old truth:

1. create the new memory.
2. set its `supersedes_id`.
3. set the old memory's `superseded_by_id` and `valid_until`.
4. set the new memory's `valid_from`.
5. emit one atomic supersession audit event.

Current searches exclude the old memory. A query for a past date may return it
when that date falls between `valid_from` and `valid_until`.

### 11.3 Expiry and decay

`expires_at` is a hard visibility boundary. An expired memory stops appearing in
normal reads immediately, even before a worker archives it.

Soft decay changes rank, not truth. It combines access recency, capped access
frequency, importance, confidence, feedback, memory kind, and pinned state.

Suggested decay policy by kind:

- observation: short half-life.
- episode: medium half-life.
- fact and decision: long half-life.
- preference and procedure: no hard expiry unless superseded.
- reference: no hard expiry unless versioned or explicitly expired.
- pinned: never auto-archive.

The existing destructive forgetting job should remain available for explicit
retention limits, but normal V1 maintenance moves memory through lifecycle states
and cold archive first.

## 12. Explicit feedback

Feedback values are:

- `useful`
- `irrelevant`
- `incorrect`
- `outdated`
- `duplicate`

Feedback records the query hash, caller scope, memory ID, optional note, and
timestamp. It never silently rewrites the memory.

- `useful` gives a small bounded score lift.
- `irrelevant` lowers the result for similar query context.
- `incorrect` flags review and may exclude the memory from normal search.
- `outdated` asks the admission service to find or create a superseding memory.
- `duplicate` queues safe compaction review.

Repeated or untrusted feedback is rate-limited. Aggregate feedback is stored on
the memory for fast ranking; each original event remains in the audit stream.

## 13. MCP interface

The shared-memory Skill should teach an agent when to call these tools and what
not to save. The MCP server enforces the rules; the Skill is not a security
boundary.

### `memory.prime`

Return pinned and highly important memory for a scope within a very small token
budget.

```json
{
  "namespace": "coding/shopapps/archive",
  "project_id": "shopapps/archive-content-relay",
  "inherit_parents": true,
  "max_tokens": 300
}
```

### `memory.search`

Search current memory with safe scope defaults.

```json
{
  "query": "How do archive jobs use RabbitMQ?",
  "namespace": "coding/shopapps/archive",
  "project_id": "shopapps/archive-content-relay",
  "agent_id": "codex",
  "inherit_parents": true,
  "search_mode": "hybrid",
  "quality": "normal",
  "max_tokens": 800,
  "debug": false
}
```

### `memory.remember`

Submit one or more candidates to the admission pipeline. Accept an
`operation_id` for safe retry. Return the admission outcome for each candidate.

### `memory.get`

Get one memory by ID when the caller is allowed to read its scope.

### `memory.feedback`

Record `useful`, `irrelevant`, `incorrect`, `outdated`, or `duplicate` feedback.

### `memory.history`

Return the audit and supersession history for one memory. Large snapshots are
paginated.

### `memory.forget`

Archive or explicitly delete selected memory. Archive is the default. Permanent
deletion requires a privileged caller and a clear reason.

### Compatibility

Keep the current V0 MCP tools while V1 clients move:

- `create_long_term_memories` maps to `memory.remember`.
- `search_long_term_memory` maps to `memory.search`, with a result-count limit
  when no token budget is supplied.
- `get_long_term_memory`, `edit_long_term_memory`, and
  `delete_long_term_memories` keep their current behavior behind permission and
  audit checks.
- `memory_prompt` uses the new token-budget search internally.
- working-memory tools remain separate because they manage session context, not
  just atomic long-term memory.

REST request and response models should expose the same core service behavior.

## 14. Concurrency, idempotency, and audit

Multiple agents may read and write at the same time.

### 14.1 Concurrency

- every memory has an integer `version`.
- updates use optimistic concurrency: the caller may supply `expected_version`.
- Redis `WATCH`/`MULTI` or a Lua script checks and updates the record, entity
  links, supersession fields, and audit event as one logical operation.
- a stale update returns a conflict with the current version. It does not win by
  last write.
- background jobs use the same service layer and rules as API and MCP writes.

### 14.2 Idempotency

- mutating calls accept an `operation_id`.
- `memory:idempotency:<operation_id>` stores the result for a configured retry
  window.
- retrying the same operation returns the first result.
- using one operation ID with a different payload returns a conflict.
- Docket jobs use stable operation IDs derived from their source event.

Client-provided memory IDs continue to support V0 deduplication, but they are not
a replacement for operation idempotency.

### 14.3 Audit history

`memory:events` is an append-only Redis Stream. Event types include:

```text
ADMIT ADD REINFORCE UPDATE SUPERSEDE FEEDBACK
DORMANT COMPACT ARCHIVE RESTORE DELETE
```

An event contains:

```json
{
  "event_id": "01K...",
  "operation_id": "01K...",
  "memory_id": "01K...",
  "event_type": "SUPERSEDE",
  "actor_type": "agent",
  "actor_id": "codex",
  "session_id": "session-abc",
  "previous_version": 2,
  "new_version": 3,
  "reason": "composer.json changed",
  "before_hash": "...",
  "after_hash": "...",
  "occurred_at": "2026-08-26T20:00:00Z",
  "metadata": {}
}
```

Small state changes may store before/after data directly. Large snapshots use a
content hash and archived JSONL payload.

Access events are much more frequent, so they use `memory:access-events` and are
aggregated in batches. The event is emitted only for a memory actually returned
to the caller, not every candidate considered.

## 15. Background maintenance

Docket remains the scheduler and worker system.

Jobs should be small, retry-safe, and scoped by namespace/project where possible:

- **access aggregation**: update `last_accessed`, counts, and recent-use windows
  from access events.
- **expiry sweep**: move expired memory out of the normal index.
- **strength refresh**: precompute slow-changing decay values when useful.
- **entity reconciliation**: merge safe aliases and repair entity-memory sets.
- **duplicate review**: exact duplicate reinforcement first; semantic compaction
  only after cohesion checks.
- **supersession check**: resolve queued conflicts that admission could not
  decide safely.
- **lifecycle evaluation**: move weak active memory to dormant and old detail to
  compacted or archived.
- **cold archive export**: append immutable JSONL plus readable Markdown
  summaries, then store a manifest and checksum.
- **audit export and stream trim**: export acknowledged events before bounded
  stream trimming.
- **index reconciliation**: repair missing index fields and entity links.

Maintenance never archives pinned memory. Compaction keeps provenance and links
the source memories to the summary memory.

Cold archive layout may be:

```text
archive/<namespace>/<year>/<month>/memories.jsonl
archive/<namespace>/<year>/<month>/summary.md
archive/<namespace>/<year>/<month>/manifest.json
```

The archive path is configurable and written atomically. Export success is
verified before live records change to `archived`.

## 16. Skill behavior

The shared-memory Skill should use progressive disclosure and stay short. Its
full instructions should say:

Search memory when:

- starting or resuming project work.
- a prior decision, preference, procedure, or verified fix may matter.
- the user refers to earlier work.
- an agent is about to make a choice that should stay consistent.

Do not search when:

- the request is standalone and current context is enough.
- the answer should come from live source code or current external data.

Remember when:

- a durable decision, constraint, preference, procedure, or verified lesson is
  established.
- the source and scope are clear.
- it is likely to help a later session.

Do not remember:

- tasks, progress, routine chat, guesses, secrets, raw reasoning, or temporary
  implementation detail.
- content already represented by Beads or project files without a new durable
  lesson.

The Skill should call `memory.feedback` when a returned memory is proven useful,
wrong, old, irrelevant, or duplicate.

## 17. Phased roadmap

Each phase is a small tested slice. Keep current REST and MCP behavior working
during migration.

### Phase 0: local baseline

- follow `V0/AGENTS.md` and run from `V0/`.
- install Python 3.12 and `uv` on macOS.
- start the required Redis 8 service.
- run unit tests, then Redis integration tests.
- record any existing failures before changing code.
- confirm the actual Docker image matches the Redis 8 project rule; update the
  local setup if the checked-in Compose file still points at an older Redis
  Stack image.

### Phase 1: scope and budget foundation

- add `project_id` and `agent_id` to models, RedisVL schema, filters, MCP, REST,
  client models, migration, and tests.
- normalize hierarchical namespaces and implement exact parent expansion.
- enforce project/user/agent/session isolation and shared-scope rules.
- add `max_tokens` packing and response budget details to search and
  `memory_prompt`.
- add score explanations behind `debug=true`.

### Phase 2: safe memory writes and soft decay

- add `kind`, importance, confidence, reinforcement count, status, and version.
- implement the deterministic admission service and structured outcomes.
- route existing create/promotion paths through admission.
- replace hard age-first defaults with access-based soft strength while keeping
  explicit retention deletion available.
- add optimistic concurrency and operation idempotency.
- add audit and access streams with focused tests.

### Phase 3: temporal truth and feedback

- add canonical `event_at`, `valid_from`, `valid_until`, `expires_at`, and
  supersession links.
- keep `event_date` compatibility during migration.
- implement time-aware current and historical search.
- add feedback events, aggregate feedback, and review queues.
- test concurrent supersession and retries.

### Phase 4: entity links and cold lifecycle

- add canonical entities, aliases, Redis sets, and entity scoring.
- add dormant, compacted, and archived transitions.
- export checked Markdown/JSONL cold archives.
- add reconciliation and restore tools.
- test archive failure safety and entity-link repair.

### Phase 5: optional quality features

- define a reranker interface and add one local implementation.
- keep it disabled for normal search and enable it only for `quality="deep"`.
- tune scoring with real, privacy-safe evaluation queries.
- consider richer filters only after clear use cases appear.

## 18. Test strategy

Follow the current `pytest` layout and test from `V0/`.

Unit tests should cover:

- namespace normalization and exact parent expansion.
- scope visibility and forbidden cross-scope reads.
- token packing, oversized records, and fallback token estimates.
- admission outcomes and importance/confidence bounds.
- score normalization, decay floors/caps, and feedback effects.
- temporal validity and supersession.
- idempotency payload conflicts and optimistic version conflicts.
- entity normalization and alias resolution.
- archive manifests and checksums.

Redis integration tests should cover:

- new RedisVL fields and migrations.
- semantic, keyword, and hybrid search with scope filters.
- atomic memory/entity/audit writes.
- concurrent reinforcement and supersession.
- access-event aggregation.
- lifecycle transitions and safe archive retries.
- old MCP and REST compatibility paths.

Use fixed clocks and deterministic fake embeddings where possible. LLM-backed
tests stay separate from the core deterministic suite.

## 19. Open questions

1. What is the required default namespace for old records with no namespace?
2. Should project parent inheritance be supported, or should `project_id` always
   be exact?
3. Should shared memories be included automatically, or only when
   `include_shared=true` is explicit?
4. Which auth claim maps to `user_id`, `agent_id`, and allowed projects?
5. What maximum memory size and default token budgets work best for Codex and
   Claude?
6. Which memory kinds may be admitted without a model check?
7. What confidence threshold sends a candidate to review instead of rejection?
8. Which event snapshots must remain in Redis, and how long may exported streams
   remain hot?
9. Where should cold archives live on one Mac and in a later multi-machine
   setup?
10. Should an `incorrect` report hide memory after one trusted report or require
    review?
11. Which entity types and alias rules are useful without making entity
    extraction expensive?
12. Which local reranker, if any, gives enough benefit to justify its latency?
13. How should data deletion requests remove a user's live memory, audit data,
    and cold archives while retaining the minimum legal audit proof?
14. Should the V1 public API use namespaced MCP tool names directly, or expose
    flat names because some MCP clients have compatibility limits?

These choices should be decided with small tests and real agent use. They do not
block Phase 0 or the first schema, scope, and token-budget slice.
