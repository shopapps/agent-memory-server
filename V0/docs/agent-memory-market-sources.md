# Agent memory market: source notes

Reviewed: **5 September 2026**. Companion evidence for the
[application review and recommendations](agent-memory-product-review.md).

This is a review of official documentation and public source repositories, not
a hands-on test of competitors. Features below are documented capabilities;
their quality, speed and reliability were not independently measured. Live docs
can move ahead of packaged releases. Check the exact version before adopting
code or an integration. No competitor was installed and no user memory was
exported or sent to one.

## What we are comparing

These are different kinds of tools. A coding-agent add-on observes an existing
agent. A memory service stores and retrieves context for clients. An agent
runtime also runs the agent itself. A graph library needs an application around
it. Those differences matter more than a single feature score.

| Product | Kind and availability | Most useful lesson for AMS |
| --- | --- | --- |
| Claude-Mem | Coding-agent add-on with local storage; separate hosted offerings | Capture useful work, then show a small index before full details |
| Mem0 | Memory library, self-hosted server and separate managed platform | Show operation health and keep current facts separate from history |
| OpenMemory | Current Mem0-branded beta session transfer CLI/TUI | Preview and move selected history between clients |
| Graphiti / Zep | Open-source graph framework / managed context platform | Give facts sources, meaningful relationships and validity dates |
| Letta | Agent runtime, desktop/web clients and SDK | Small always-loaded memory, deeper reference material and version history |
| Supermemory | Memory/context API; local binary and enterprise platform | Distinguish stated facts from inferred guesses; support review and undo |
| Cognee | Memory/knowledge-graph platform with local and cloud paths | Make short-term versus permanent retrieval explicit |
| Hindsight | Memory service with coding-agent integrations; local and cloud paths | Show every stage from capture to searchable fact and track its evidence |

The product sections below provide sources for this table. “Not confirmed” means
the reviewed sources did not establish a feature; it does not prove absence.

## Claude-Mem

Claude-Mem goes beyond keeping the last few prompts. Its lifecycle hooks capture
prompts and tool observations, produce session summaries, and inject previous
project context. The background worker separates capture from AI processing.
Its search flow offers an index, nearby timeline context, then full observation
records on demand. This is useful for remembering why a change was made without
loading an entire transcript. [Hook lifecycle](https://docs.claude-mem.ai/architecture/hooks),
[getting started and search flow](https://docs.claude-mem.ai/usage/getting-started).

Local configuration documents SQLite storage, worker logs and a web viewer.
Provider/model settings affect where AI processing happens; local storage alone
does not imply offline model use. Explicit private tags can exclude content.
[Configuration](https://docs.claude-mem.ai/configuration),
[private tags](https://docs.claude-mem.ai/usage/private-tags).

Its JSON export/import scripts include observations, sessions, summaries and
prompts; project filtering and duplicate checks support selective migration.
This is a good model for an AMS importer, but the format needs explicit mapping
and review before importing raw chats. [Export/import](https://docs.claude-mem.ai/usage/export-import).

**Lesson:** add selected tool results and a compact session handoff, with source
links and strict size limits. Preserve direct access to current code: copying
Claude-Mem's optional file-read gate, which can block a file read and show old
observations instead, would work against AMS's code-verification needs.
[File-read gate](https://docs.claude-mem.ai/file-read-gate).

## Mem0 and OpenMemory

Mem0's current extraction path distils facts and adds them without automatically
rewriting earlier ones. Retrieval can use meaning, keywords, entities and time,
but the exact implementation differs between products: current docs say OSS
uses configured storage and entity overlap, while managed Graph Memory links
entities across facts. Do not attribute every hosted feature to the library.
[How Mem0 works](https://docs.mem0.ai/core-concepts/how-it-works).

The self-hosted bundle now includes a setup wizard, memory browser, per-user API
keys and a request log showing status and latency. This is relevant to a small
team trying to tell whether installation worked. Defaults still need a model
provider; bundled provider choices are narrower than the library's full list.
[Self-hosted setup](https://docs.mem0.ai/open-source/setup).

Managed **Dream** merges duplicates and marks outdated facts as superseded while
retaining history. `latest_only` asks for current facts. Optional synthesis adds
broader patterns with source links; synthesis and its dashboard have plan limits.
This is a hosted feature, not evidence of OSS parity.
[Dream](https://docs.mem0.ai/platform/features/dream).

The Codex integration documents startup and per-prompt recall, summaries,
compaction handling and separate attribution for user statements and assistant
output. Its setup instructions are Mem0's client claims, not a guarantee for
every Codex Desktop build. [Codex integration](https://docs.mem0.ai/integrations/codex).

**Naming warning:** the current `mem0ai/openmemory` repository describes a beta
CLI/TUI for previewing and transferring selected sessions between Claude Code,
Codex and OpenCode. Realtime autosync and transferring skills/MCPs are roadmap
items. This differs from older OpenMemory local-MCP tutorials; do not combine
both generations into one feature list. [Current OpenMemory README](https://github.com/mem0ai/openmemory/blob/main/README.md).

**Lesson:** provide a clear “did capture, save and recall work?” screen; preserve
old and current facts; keep the human's confirmed rules distinct from an agent's
suggestions. Session portability is useful later, after a safe AMS backup/import
format exists.

## Graphiti and Zep

Graphiti models entities and relationships with validity windows. Derived facts
trace back to input episodes; new evidence can invalidate an old relationship
without erasing its history. Retrieval combines semantic, keyword and graph
search. This is a real relationship graph, not merely a picture connecting
records that share a tag. Graphiti is a framework with an MCP/REST layer and a
graph database to operate. Zep is a separate managed platform with user/thread
management, context assembly, a dashboard and operational logs; these surrounding
product features should not be assumed in Graphiti alone.
[Graphiti source and product comparison](https://github.com/getzep/graphiti).

Graphiti's MCP server provides episode and entity operations, search and grouping
for AI clients. Having an MCP tool available does not itself prove that a coding
agent will call it on every relevant turn.
[MCP server](https://help.getzep.com/graphiti/getting-started/mcp-server).

**Lesson:** first add `supersedes`, `supports` and `contradicts` relationships,
source references and dates to AMS. Only add graph traversal if real questions
need it. A new database is not necessary merely to improve the existing graph
view.

## Letta

Letta's current focus is a stateful agent runtime, with local operation and a
self-hosted App Server as well as hosted clients. It is not just an add-on for
the user's existing Codex agent. Older Docker-server and v1 SDK material is now
marked legacy/deprecated, so old memory-block comparisons alone miss the current
design. [Current documentation index](https://docs.letta.com/llms.txt).

**MemFS** keeps memory in a Git repository. Files under `system/` stay in the
prompt; deeper files are read when needed. Edits have version history. Semantic
search is not built into MemFS by default: normal file search is the baseline,
with optional search components. This is a useful example of memory tiers and
traceable edits without assuming that every memory needs a graph.
[MemFS](https://docs.letta.com/concepts/memfs).

Background dreaming reviews conversations and consolidates useful lessons.
`/doctor` audits placement, duplication and prompt size. A desktop memory viewer
lets users inspect saved content. The optional “agent reviews” step is another
AI review and uses more tokens; it is not human approval.
[Memory and dreaming](https://docs.letta.com/configuration/memory).

**Lesson:** make a small project brief from selected, current facts using AMS's
existing pinning and summary features. Offer deeper source material on demand,
and provide a memory-quality check. Do not replace Codex with a new agent runtime
to get those benefits.

## Supermemory

Supermemory separates raw documents from extracted facts. Its graph can mark a
fact as updating, extending or being derived from another. Current-state search
can prefer the latest version. A separate update endpoint creates a new version
and preserves the original. [Graph memory](https://supermemory.ai/docs/concepts/graph-memory),
[versioned update API](https://supermemory.ai/docs/api-reference/content-management/update-a-memory-creates-new-version).

Inferred memories are explicitly marked and rank lower until reviewed. The API
supports approve, decline and undo. This is a practical design for keeping an
AI's guess distinguishable from something a user stated.
[Review inferred memories](https://supermemory.ai/docs/recall/memory-review).

Current docs describe a free open-source local binary with a graph engine and
bring-your-own model provider, including offline options. Enterprise adds
organization roles, scoped keys, a usage/ingestion console and ongoing connectors.
Do not assume enterprise dashboards and connectors are included locally.
[Local versus enterprise](https://supermemory.ai/docs/self-hosting/local-vs-enterprise).

MemoryBench is an open-source framework for comparing retrieval accuracy,
latency and context tokens using the same pipeline. It supports custom providers
and datasets. Its existence is useful; vendor benchmark rankings are not proof
that a product wins on this team's projects.
[MemoryBench](https://supermemory.ai/docs/memorybench/overview).

**Lesson:** add correction history and undo, distinguish confirmed facts from
inferences, and test a small set of real project questions. Compare improved AMS
against current AMS before considering another engine.

## Cognee

Cognee's current high-level `remember` API can store session context quickly,
then bridge it to the permanent graph in a background improvement pass. Session
storage and graph storage are distinct outcomes. Permanent ingestion normalizes
documents, extracts entities/relationships and builds retrieval structures.
Dataset status and pipeline-run APIs show whether indexing finished.
[Remember](https://docs.cognee.ai/core-concepts/main-operations/remember).

`recall` can query session memory or the permanent graph and returns a source
label. Its default query routing is rule-based; it should not be described as
an AI planner. It can return explicit errors when a provider budget is exhausted.
[Recall](https://docs.cognee.ai/core-concepts/main-operations/recall).

Its public repository documents a local API, optional UI and MCP containers,
alongside a managed cloud path. The Claude Code plugin captures prompts, tool
traces and replies, injects scoped context on prompts, and syncs sessions to the
graph. The codebase also supports storing discoverable skills, which is a broader
function than AMS currently needs.
[Cognee source and integrations](https://github.com/topoteretes/cognee).

**Lesson:** label search results and UI items clearly as “recent conversation,”
“waiting for review,” or “saved fact.” Keep a visible link between the stages so
a chat appearing in Working Memory cannot be mistaken for a permanent memory.

## Hindsight

Hindsight separates raw fact retrieval (`recall`) from AI answer synthesis
(`reflect`). It has world facts, records of the bank's own actions, consolidated
observations and user-curated mental models. Retrieval combines semantic,
keyword, graph and time signals. Observations retain supporting facts and exact
quotes, track history, and are checked for freshness against newer raw facts.
[Architecture overview](https://hindsight.vectorize.io/).

Current coding-agent integration docs cover several clients, including Codex
CLI, with automatic recall and session writes. Settings control capture, recall,
refresh frequency and model-work budgets. Stored provenance tags record the
client and source. These are documented CLI integrations; Codex Desktop support
needs its own test. [Coding-agent integrations](https://hindsight.vectorize.io/sdks/integrations/coding-agents).

Operations have IDs, status, errors and progress snapshots. Monitoring distinguishes
API success from useful memory creation: a `no_facts` metric catches documents
that were accepted but yielded nothing searchable. Model calls and token usage
are recorded by purpose/provider. [Operation status](https://hindsight.vectorize.io/developer/api/operations),
[monitoring](https://hindsight.vectorize.io/developer/monitoring).

Memory Defense can redact or block known secret patterns before storage. It is
opt-in, uses pattern matching, and affects future writes only. That is a limited
screen, not a guarantee that all private content or malicious instructions are
detected. [Memory Defense](https://hindsight.vectorize.io/developer/memory-defense).

The repository offers self-hosted deployment and a separate cloud service.
[Hindsight source](https://github.com/vectorize-io/hindsight).

**Lesson:** retain a permanent evidence trail, show stage-specific health, and
expose the queue and last successful recall. A “server healthy” light alone is
not enough to prove memory is working.

## Recommended order for AMS

These are recommendations inferred from the comparison, not claims that a
competitor feature should be copied wholesale. The application review checks
each gap against current AMS code.

1. **Finish and show the save path.** Drain every eligible queued candidate;
   retry interrupted work; make capture, filtering, saving and indexing separately
   visible. Include last success, failures and skipped reasons.
2. **Prove automatic reading.** Use existing hybrid search and token limits to
   inject a small amount of relevant permanent memory, alongside recent context.
   Show which record IDs were supplied. Avoid injecting the whole graph.
3. **Keep evidence and changes.** Save the source quote, author/client, time and
   source link with each lasting fact. Support correction, supersession and undo.
   Do not treat AI confidence as proof.
4. **Give humans a clear review desk.** Show the proposed fact next to its source,
   possible duplicates and any conflicting current fact. Provide accept, edit,
   dismiss and restore. Keep the graph as an additional view.
5. **Measure useful memory.** Build a small replayable project test set: exact
   recall, paraphrases, changed decisions, false claims, project isolation, offline
   capture and queue backlogs. Record accuracy, delay and model tokens. Memory
   count alone is not success.
6. **Make local cost and privacy easy.** Use the provider options already present;
   expose a tested local-model setup and usage limits. A local database does not
   mean model calls are local. Add per-project capture exclusions and clear
   retention controls before fuller tool capture.
7. **Make history portable.** Add previewable project exports and restore tests,
   then a selective Claude-Mem importer. Keep raw chat private unless expressly
   selected for transfer.
8. **Expand the graph only for useful questions.** Add typed relationships and
   freshness views when basic reliability and evidence are in place. Broader
   document connectors, autonomous inference and skill learning can wait.

For a central server shared by multiple Macs, enforce who may read and write each
project before rollout. A caller-supplied project filter is organization, not
access control. This is a deployment requirement, not a reason to complicate the
intentional single-user local setup.

## Availability and reuse caveats

The reviewed repositories identify [Mem0](https://github.com/mem0ai/mem0) and
[Cognee](https://github.com/topoteretes/cognee) as Apache-2.0 and
[Hindsight](https://github.com/vectorize-io/hindsight) as MIT. These labels do not
license proprietary hosted features or guarantee that every optional component
uses the same license. Check the exact files/version before copying code. This
review recommends product behavior, not importing competitor implementations.

No comparative benchmark was run. No subscription price or promised speed is
used to rank products. Human review, offline operation and team permissions vary
by deployment and plan; where the source did not establish them, they remain
unconfirmed.
