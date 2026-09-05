# Agent Memory product review

Reviewed: **5 September 2026**.

This is an assessment and a set of recommendations, not an approved build
plan. It covers the Shopapps checkout at `8c20799`, including the uncommitted
Working Memory feature. Application code, installation settings and running
services were not changed for this review.

## Recommendation

Keep the current Redis foundation. Make automatic saving and recall easy to
trust before expanding the graph or capturing more data.

The strongest direction for this app is **a shared project notebook for coding
agents, with a human able to see, correct and control what they remember**.
Its value should be measured by useful facts found in later work, rather than
the number of graph nodes.

## Intent and boundaries

The [architecture](../../ARCHITECTURE.md) calls for small, durable facts,
bounded search results, separate project scopes, readable history and safe
maintenance. Beads owns tasks and work status. Source files and Git remain the
authority for the code itself.

The recent capture feature adds a short-term stage: recent exchanges become
candidate facts, and selected facts enter long-term memory. This is a good fit
for developers who switch between Codex and Claude across several projects.

Two deployment goals need to stay distinct:

- **Each developer's Mac:** agents on that Mac share its local server.
- **One server for the team:** several people share selected project knowledge,
  with access rules controlling which people and agents can read or change it.

The current local installer serves the first goal. Separate local databases
do not automatically share data across Macs. The current hooks deliberately
connect only to a loopback address. Team hosting would require a separate,
explicitly designed connection and permission model.
[Hook implementation](../installer/assets/working-memory-hook.mjs).

## What already exists

These are findings from the current source, not claims that every supported
provider or client was tested during this review.

| Area | Current capability | Important limit |
| --- | --- | --- |
| Agent setup | Local Docker installer; Codex/Claude skills, MCP settings and managed rule blocks; optional capture hooks | Full installation still detects/configures agents through their command-line programs. Standalone capture setup writes hook files directly. |
| Working Memory | Up to 30 exchanges per session; seven-day expiry; private-exchange omission; review/automatic modes | Prompt and final reply only. Failed hook requests are discarded. Evicted chat is not summarized by this capture path. |
| Search | Meaning, exact-word and hybrid search; token budgets; project/user/agent/session filters; exact namespace-parent inheritance | Capture's startup recall only returns recent chat. Long-term search still depends on the agent using the rules/tools. |
| Summaries | Generic session summarization and cached long-term Summary Views | These are separate from capture. Summary Views currently do not accept `project_id` as a filter or grouping field. |
| Human review | Graph with project filters, connected memories, edits, deletion and live refresh; a page for candidate approval | Working Memory needs manual refresh; the graph is mainly a map of labels and membership, not a graph of changing facts. |
| Maintenance | Duplicate handling, compaction, recency ranking, access counts and pinning | These do not provide a complete correction history, reversible deletion or conflict resolution. |
| Providers | Shared model client, with local-model configuration documented alongside hosted providers | Local storage does not mean local AI processing. The selected provider still determines where filtering and embedding text goes. |
| Authentication | Token and OAuth login checks exist | Supplied project/user filters are not enforced as each caller's allowed data. Token mode currently grants an admin identity. |

Sources: [installer](../installer/src/installer.js),
[agent setup](../installer/src/agents.js),
[capture](../agent_memory_server/working_memory_capture.py),
[search API](../agent_memory_server/api.py),
[token packing](../agent_memory_server/retrieval.py),
[record model](../agent_memory_server/models.py),
[graph data](../agent_memory_server/admin_graph.py),
[graph controls](../agent_memory_server/admin_ui/graph.js),
[maintenance](../agent_memory_server/long_term_memory.py),
[model client](../agent_memory_server/llm/client.py),
[local model setup](llm-providers.md#ollama-local-models),
[authentication](../agent_memory_server/auth.py).

## Market comparison

These are documented features, not measured performance. Local libraries,
hosted services and whole agent runtimes are not interchangeable. In particular,
a feature in a hosted plan should not be assumed to exist in its open-source
version. See the [detailed source notes](agent-memory-market-sources.md) for
availability limits and further primary sources.

| Product | Relevant strengths | What AMS should learn |
| --- | --- | --- |
| [Claude-Mem](https://docs.claude-mem.ai/architecture/hooks) | Captures prompts and tool observations; makes session summaries; supplies earlier context. Search loads an index before full details. | Add compact handoffs and selected tool evidence. It is more than a last-30-prompts buffer. |
| [Mem0](https://docs.mem0.ai/open-source/setup) | Its self-hosted bundle includes setup, a memory browser and request status. Hosted [Dream](https://docs.mem0.ai/platform/features/dream) merges duplicates and retains superseded facts. | Make operation health visible and distinguish current facts from history. Dream is not an OSS feature; current-only search needs its explicit filter. |
| [OpenMemory](https://github.com/mem0ai/openmemory/blob/main/README.md) | The current Mem0-branded beta previews and transfers selected coding-agent sessions. | Consider session portability after backup/import. Do not confuse this generation with older local-MCP tutorials; automatic sync is still roadmap work. |
| [Graphiti / Zep](https://github.com/getzep/graphiti) | Graphiti stores relationships with sources and validity dates; Zep adds a managed context product around related ideas. | Add meaningful links and changed-fact history. A prettier tag graph alone does not provide this, but AMS need not adopt a new database first. |
| [Letta](https://docs.letta.com/concepts/memfs) | Its agent runtime keeps small always-loaded memory files, deeper files on demand and Git-backed changes. | Build a small current project briefing and inspectable history. Do not replace the user's coding agent to gain these benefits. |
| [Supermemory](https://supermemory.ai/docs/recall/memory-review) | Marks inferred memories, ranks them lower until reviewed, and provides approve/decline/undo actions. [Updates preserve versions](https://supermemory.ai/docs/api-reference/content-management/update-a-memory-creates-new-version). | Separate guesses from confirmed facts; add safe correction and undo. |
| [Cognee](https://docs.cognee.ai/core-concepts/main-operations/remember) | Separates fast session storage from later permanent graph processing. [Recall labels its source](https://docs.cognee.ai/core-concepts/main-operations/recall). | Show “recent conversation” and “saved fact” as different outcomes, with a visible link between them. |
| [Hindsight](https://hindsight.vectorize.io/developer/api/operations) | Gives background work IDs, progress and error states. [Monitoring](https://hindsight.vectorize.io/developer/monitoring) distinguishes accepted input from useful fact creation and tracks model work. | Track capture, filtering, saving and search readiness separately. This is especially relevant to the recent waiting-fact bug. |
| [Redis Agent Memory in Iris](https://redis.io/docs/latest/operate/iris/agent-memory/) | Separate Redis Cloud and self-managed Kubernetes deployment paths, with [model configuration](https://redis.io/docs/latest/operate/iris/agent-memory/model-configuration/). | Treat this as a separate supported product, not features automatically present in the V0 fork. It is an operating-model comparison, not the same Mac-local workflow. |

The common useful pattern is not simply “store more.” It is to keep a small
amount of relevant context, show where it came from, handle changed facts, and
make failed background work visible. Those fit AMS's existing direction.

## Recommended improvements, in order

Effort is a relative estimate from the reviewed code: **small** means a
contained change; **medium** touches several existing paths; **large** needs
data/API design and migration. These are not delivery-date estimates.

### 1. Finish every automatic save and show its result

**Priority: first. Effort: medium. Existing defect plus missing visibility.**

`process_capture` saves only the first three pending candidates per run. It
does not arrange another run for the remaining candidates, and it can report
`ready` while work is still waiting. The earlier test exposed this exact case:
three older candidates were saved and the fourth waited for another trigger.
The three-item slices are still present in the reviewed source.

Keep work in small batches, but schedule the next batch until eligible saves
finish. Report waiting, running, saved, rejected, awaiting review and failed
as distinct states. A skipped candidate should have a short reason. Provider
errors should have safe categories, such as unavailable model or rejected key,
without showing credentials or private chat.

Also test extraction backlog size: the filter returns at most three facts
while marking the whole submitted message batch processed. A long backlog
may therefore miss useful facts. That is a coverage risk to measure, separate
from the confirmed save-queue defect.

**Proof:** several older pending facts plus a new fact all finish without
another prompt or manual click; review mode still waits for a person; retries
do not create duplicate records. A stopped/restarted worker resumes safely.
[Processing and promotion](../agent_memory_server/working_memory_capture.py).

### 2. Add “Check my setup” and a small activity view

**Priority: first. Effort: small to medium. Extend existing checks.**

Show, for each installed agent: capture enabled, selected mode, last prompt
received, last reply received, last successful save, last context returned,
waiting work and last safe error. Distinguish “context returned to the hook”
from evidence that a new agent task actually used it.

Extend the current doctor command. It already checks Docker, API health,
skills, MCP and rule files; it does not prove the capture-to-recall path. The
health endpoint itself returns a timestamp, not proof of successful AI work.
Add a guided test with a clearly labelled disposable fact and a later search
by memory ID. Reuse the existing admin pages, with quiet refresh and a visible
link from a saved candidate to its long-term record.

**Proof:** disconnect each stage in an isolated test and show which stage
failed. A successful fresh-session test names the actual long-term record.
[Doctor](../installer/src/installer.js),
[health endpoint](../agent_memory_server/healthcheck.py),
[review page](../agent_memory_server/admin_ui/working-memory.html).

### 3. Load useful long-term facts automatically

**Priority: next. Effort: medium. Connect existing capabilities.**

Give a new task a small project briefing, then retrieve facts relevant to its
first real request. Keep recent-chat recall as a separate, labelled source.
Do not fill the context with the entire memory store or run a generative model
for every lookup. Reuse existing search and token packing; measure any provider
cost for meaning-based query embeddings.

A briefing could include pinned decisions, conventions and a compact project
summary. Reuse Summary Views only after adding the required exact project
filter support; a namespace must not be assumed to be an ownership boundary.
Refresh cached briefings when their source facts change. Further retrieval
can stay on demand through MCP rather than repeating the same facts each turn.

**Proof:** after recent chat expires, a new task gets the right project fact
within its token budget, with its ID, and gets no other project's private
context. Confirm the actual client hook can deliver that context.
[Current recall](../agent_memory_server/working_memory_capture.py),
[hook](../installer/assets/working-memory-hook.mjs),
[search and Summary View validation](../agent_memory_server/api.py),
[budget packing](../agent_memory_server/retrieval.py).

### 4. Keep the source and support safe corrections

**Priority: next. Effort: medium for source evidence; large for full history.**

Saving currently keeps a source message ID and the automatic/manual label.
The candidate's evidence quote, confidence and source role are not copied
into the long-term record. Once short-term chat expires, the reason for a fact
can become hard to inspect.

Keep a small, project-safe supporting excerpt or source-file reference, the
source date, and whether a person confirmed it. Keep private origin details
private; automatic promotion must not expose raw private chat to the project.
An AI confidence number is not independent proof. Assistant-only assertions
should remain reviewable unless there is separate support.

Treat recalled text as reference data, not permission to run commands, reveal
secrets or change project rules. Keep user-stated facts distinct from copied
documents and agent guesses. Test hostile instructions inside both imported
documents and saved memories before expanding automatic recall.

Then add correction history. For example, “we use PHP 8.3” can be replaced by
“we use PHP 8.4,” with the old fact still available in history but excluded
from normal current-fact search. Add “outdated,” “wrong” and “duplicate” review
actions, reversible archiving, and a version check to prevent one editor from
silently overwriting another's change. Reuse current edit/compaction paths.

**Proof:** a correction changes future answers, its old version remains
inspectable, undo works, and source evidence survives short-term expiry
without widening private access.
[Promotion](../agent_memory_server/working_memory_capture.py),
[current record/edit fields](../agent_memory_server/models.py),
[planned history and feedback](../../ARCHITECTURE.md#11-lifecycle).

### 5. Recover from offline periods and protect the store

**Priority: next. Effort: medium.**

Add a bounded local retry queue for permitted capture events, so stopping
Docker does not silently lose a session. Apply omission rules before writing
the queue, retain exact event/project/user identities, expire old queued data,
and respect capture being turned off. The existing stable turn IDs help avoid
duplicates when replaying.

Add a clear memory backup/restore flow. The installer's configuration backups
and its preservation of the Redis volume are useful, but are not an independent
backup of the memories. Offer a versioned export for selected durable project
facts, plus a private full-store recovery option. Prove restoration on a
separate disposable store before replacing a live one.

**Proof:** stop the server, capture permitted fake events, restart and see each
event once. Restore a test backup with the same fact IDs, scopes and history.
[Hook failure path](../installer/assets/working-memory-hook.mjs),
[current command surface](../installer/src/args.js),
[volume-preserving install](../../INSTALL.md).

### 6. Make costs and Desktop setup clear

**Priority: next. Effort: small to medium.**

Complete the Desktop-only installation path so users do not need a separate
Codex command-line installation for MCP setup. Show which client settings,
rules and hooks were installed and which still need client-side trust.

Offer clear choices: capture only, local AI, or a hosted provider. Local-model
support already exists; the missing work is a tested Mac/Docker setup flow,
model checks and safe handling when the embedding model changes. Such a change
may require rebuilding the search vectors, not simply replacing a model name.

Show model usage by project and stage, estimated spend, and a user-set budget.
Pause extra AI processing when the budget is reached while preserving the
defined capture/retention policy. Batch suitable work. Distinguish measured
tokens from estimated prices and actual provider bills.

**Proof:** a fresh Desktop-only Mac setup reaches its test record; local mode
uses the configured local generation and embedding endpoints; a small test
budget stops new optional AI calls at the expected boundary.
[Client detection/setup](../installer/src/agents.js),
[provider configuration](llm-providers.md),
[returned model usage](../agent_memory_server/llm/client.py).

### 7. Add compact session handoffs and controlled imports

**Priority: later. Effort: medium.**

Before old capture is trimmed, optionally make a short session summary with
references to its evidence. Give summaries their own retention and clearly
label them as history. Do not turn these summaries into a second task tracker
or automatically treat all summary statements as durable facts. Reuse the
generic summary machinery where the capture privacy rules allow it.

Add a preview-based import for selected project documentation and existing
Claude-Mem exports. Show proposed facts, target project and possible duplicates
before saving. Record the source path and Git revision. Start with chosen
Markdown files and checked configuration facts, rather than indexing every
repository file or connecting every company system.

Useful tool outcomes, such as a passing test or a confirmed failure cause,
could later support facts more strongly than an assistant's final claim.
Capture only selected, bounded outcomes with clear opt-in, not every tool log.

**Proof:** a summary retains a relevant decision after trimming; importing the
same document twice does not multiply facts; source edits flag stale facts;
imported document instructions cannot change memory policy.
[Capture versus generic summaries](working-memory.md),
[existing Claude-Mem transition review](claude-mem-replacement-review.md).

### 8. Add meaningful graph links after the facts are dependable

**Priority: later. Effort: medium.**

The graph currently connects memories to projects, namespaces, topics,
entities and available source memories. Keep that useful view. Add explicit
links such as “replaces,” “supports,” or “depends on” only when their meaning
and evidence can be stored. A shared label does not prove a dependency.

Useful near-term graph additions are a history drawer, source links, stale
fact badges, and a switch to the existing meaning/hybrid search. A separate
workbench already has search controls, so consolidate the human workflow
instead of adding a third competing explorer. Consider branch/revision labels
to prevent an unmerged experiment becoming a project-wide truth.

There is no demonstrated need to replace Redis with a graph database for
these improvements. Start with the lightweight links already proposed in the
architecture.
[Graph construction](../agent_memory_server/admin_graph.py),
[existing explorer](../workbench/src/pages/ExplorerPage.tsx),
[entity-link design](../../ARCHITECTURE.md#93-entity-linking).

## Gate before one server serves several people

**Effort: large. Required before team hosting with private data.**

Bind the logged-in identity to allowed projects and private data. Enforce that
on reads, writes, direct-ID access, capture, graph data, background jobs and
MCP. Add separate read/write/admin permissions and a reviewable change trail.
Keep private chat private even when a fact is approved for the team.

The current API authenticates requests but uses caller-supplied data scopes;
direct-ID operations do not compare a record's owner with the caller.
Authentication helpers exist, but the reviewed routes do not apply per-project
permissions. This is a concrete team-hosting gap, not a reason to complicate
the intended single-user local setup.
[API routes](../agent_memory_server/api.py),
[auth identity](../agent_memory_server/auth.py),
[application wiring](../agent_memory_server/main.py),
[capture routes](../agent_memory_server/working_memory_capture.py).

## How to judge whether the changes help

Extend the existing test suite with a small set of fake coding-project cases.
The repository already has capture, scope, token-budget, extraction and
model-judged tests; it does not need a second testing framework.

Measure: useful facts saved, incorrect facts saved, relevant facts found,
duplicate rate, stale answers, time from capture to searchable fact, missed
events, and model usage. Total memory count alone cannot tell whether the
system is learning usefully.

Include these acceptance cases: a fourth waiting candidate, server downtime,
a changed convention, an unsupported assistant claim, a private exchange,
the same fact phrased twice, cross-project lookup, two simultaneous editors,
and recall after short-term expiry. Use exact memory IDs and saved source
evidence to check answers, not just an AI judge. Test real supported clients
separately from server tests.

Sources: [capture tests](../tests/test_working_memory_capture.py),
[scope tests](../tests/test_v1_scopes.py),
[budget tests](../tests/test_token_budget.py),
[existing quality evaluation](../tests/test_llm_judge_evaluation.py).

## Suggested first delivery

Deliver recommendations 1 and 2 together: reliable completion, a useful status
view, and a repeatable fresh-session test. Follow with automatic long-term
recall and durable source evidence. Add history/undo and recovery before
expanding collection or sharing the service across people.

Most of these ideas already fit the proposed architecture. The main correction
is delivery order: prove the full save-and-recall path, then deepen memory
quality. Do not add a new database, a new agent runtime, broad document
connectors or autonomous “learning” jobs just to match a competitor's list.

## Review limits

This review inspected local code, tests and documentation and checked official
product sources. It did not install competitors, run comparative benchmarks,
re-run the full application test suite, or approve a team deployment. Effort
and product fit are engineering judgments. Provider capabilities, licensing,
availability and pricing should be checked again before an adoption decision.
