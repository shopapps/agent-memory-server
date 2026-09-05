# Local installation

This guide runs the open-source `V0/` server on macOS.

This Shopapps fork adds a local developer workflow to the Redis research
foundation. Redis's separate supported product is
[Redis Agent Memory in Redis Iris](https://redis.io/agent-memory/).

## Quickstart for a Mac

The quickstart installs the server, Redis 8, the shared-memory Skill, and the
MCP link used by Codex or Claude. MCP is the local link that lets an agent use
the memory tools.

The installer package is kept in this repository. It is not published to npm.

If you already have this repository, run this from its root:

```bash
./ams docker:install
```

For a new Mac, this single line clones the repository and runs the installer:

```bash
git clone https://github.com/shopapps/agent-memory-server.git && cd agent-memory-server && ./ams docker:install
```

The Bash helper above runs the installer kept in this repository. This longer
form does the same thing and remains supported:

```bash
npx --yes ./V0/installer docker:install
```

Do not use `npx @shopapps/agent-memory@latest`. That name is not on npm and will
return a `404 Not Found` error.

To run it from another folder, use the full path to your checkout:

```bash
npx --yes /absolute/path/to/agent-memory-server/V0/installer --help
```

The installer shows its plan before it changes anything. It then:

- checks Docker Desktop and the chosen agent apps;
- downloads fixed Docker image versions;
- builds the current `V0/` source for the app containers;
- starts Redis, the REST API, MCP, and the background worker;
- adds the shared-memory Skill for Codex, Claude, or both;
- adds the native MCP setting for each chosen agent;
- adds a small shared-memory rule to each chosen agent's active instruction
  file;
- waits until the local server is healthy.

The rule tells new agent tasks to search memory before project work and save
new, checked facts afterwards. It sits inside clear start and end markers.
Rerunning `install` or `update` replaces only that marked block. Text outside
the block is left as it was. Broken or repeated markers stop the install before
Docker is changed.

By default, no hooks are added. A hook is a script that runs when an agent
event happens. Rules and MCP support agent-chosen reads and writes.
For automatic recent-chat capture, opt into [Working Memory](#working-memory).

The selected scope decides which instruction file is used:

| Agent | All projects for this user | One project |
| --- | --- | --- |
| Codex | `${CODEX_HOME:-~/.codex}/AGENTS.md` | `<project>/AGENTS.md` |
| Claude | `${CLAUDE_CONFIG_DIR:-~/.claude}/CLAUDE.md` | `<project>/CLAUDE.md` |

Codex uses a non-empty `AGENTS.override.md` instead when one exists. For a
Claude project, the installer keeps an existing `.claude/CLAUDE.md` if that is
the file already in use. It does not scan or change nested rule files.
Project-scope files are normal project files, so they may appear in Git for the
team to review and share.

Global rules choose a separate memory name for each Git repository. Project
rules use the project folder name by default. Set an exact name with
`--namespace shopapps/acr`. A namespace is simply the memory folder name shared
by Codex and Claude.

### Working Memory

Working Memory is an optional short-term stage before the long-term graph.
It captures recent prompts and final replies, then suggests lasting project
facts. Raw chat does not go into the graph.

For an existing install, first rebuild the server from this checkout. This
keeps the Redis memory database:

```bash
./ams docker:reset
./ams working-memory install --agents all --scope user --yes
```

For a first install, include the feature in the same command:

```bash
./ams docker:install --working-memory --agents all --scope user --yes
```

Use `--agents codex` for Codex Desktop only, or `--agents claude` for Claude
Code. **Codex Desktop does not need a separate Codex CLI install.** The installer
recognizes `/Applications/Codex.app` and `~/Applications/Codex.app`, and writes
its managed MCP settings directly when the CLI is absent. It respects
`CODEX_HOME` and keeps unrelated settings. Restart the app and trust the new
MCP/hook setup when asked. Existing CLI installations keep their normal path.
The clients share the same [official MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

To enable capture in only one Git project:

```bash
./ams working-memory install --agents all --scope project \
  --project-dir /path/to/project --yes
```

The command prints a review link with your local user ID, for example
`http://127.0.0.1:8000/admin/working-memory?user_id=...`.
Open that link to see recent exchanges and suggested facts. You can also use
the **Working Memory** link in the graph, or open
[Working Memory directly](http://127.0.0.1:8000/admin/working-memory).
Keep using the same scope and agents for later updates.

#### Local user ID and API token

The **local user ID is needed**, even on your own Mac. It tells the server which
recent chats to load. The installer creates it and reuses it for Codex and
Claude. It is not a password, OpenAI account ID, or login ID. The long-term
graph itself does not need it.

For the default local setup, Working Memory fills in the saved ID automatically.
An ID in the link takes priority. Both page links keep the selected ID when
you switch between Working Memory and the graph.

- **Docker:** the installer copies only the ID from `working-memory-user.json`
  in its support folder into `runtime.env` as `WORKING_MEMORY_LOCAL_USER_ID`.
  Your Mac's settings folders are not mounted into Docker. `docker:install`
  and `docker:reset` pick up an existing saved ID when rebuilding.
- **Running the server directly on your Mac:** the page reads `userId` from
  `~/.codex/ams-working-memory.json` or `~/.claude/ams-working-memory.json`.
  It also respects `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. The saved API address
  must match the local server's scheme and port. Conflicting IDs are not guessed.
- **Remote servers or servers with login checks enabled:** auto-fill is off.
  Capture IDs do not come from the login system, so a login ID is not used as
  a replacement. Use the review link or enter the saved capture ID.

After adding Working Memory to an existing Docker app, load the saved ID with:

```bash
./ams docker:restart app
```

If the running image predates this change, use `./ams docker:reset` instead.
Both commands keep the memory database.

If the field is still blank, open the settings file above and copy `userId`.
For project-only installs, look in the project's `.codex` or `.claude` folder.
To print the Codex user-level ID in Terminal:

```bash
node -p 'require((process.env.CODEX_HOME || process.env.HOME + "/.codex") + "/ams-working-memory.json").userId'
```

Paste that value into **Local user ID**, then click **Load sessions**. You can
bookmark the installer's review link to keep the ID handy. Missing or unreadable
settings leave the field blank; the app does not create a new ID or search
other users' memories to guess one.

The **API token can stay blank** for the default local setup. It is only needed
when the memory server requires an access token. It is **not your OpenAI API
key**. The page uses it to read and change memories, but does not save it for
later visits or put it in links.

#### Choose what reaches long-term memory

| Mode | Behaviour | AI use |
| --- | --- | --- |
| `--promotion off` | Capture and recall only | No extra model call for capture or recall |
| `--promotion review` (default) | AI suggests project facts; you choose **Save to long-term** or **Dismiss** | Model call after a new final reply; embeddings when saving |
| `--promotion auto` | AI-selected project facts are saved without human review | Model calls and embeddings |

Start with review mode. The filter looks for project decisions, design facts,
stable rules, constraints and confirmed fixes. It is asked to ignore small
talk, guesses, general coding knowledge and temporary task status. Each
suggestion must include a quote found in the stored exchange. AI selection
can still be wrong; a high model confidence score is not proof.
Assistant-only claims stay in review, even in auto mode, unless a user message
contains the same supporting quote.

To change mode or refresh the hooks without restarting Docker or changing MCP,
rules or existing memories (the saved local ID is also copied into `runtime.env`):

```bash
./ams working-memory update --agents all --scope user --promotion auto --yes
```

Auto mode shares selected facts with the whole project. Raw working chat
stays under the local user ID. Saving the same fact for the same project
uses a stable ID, so retries do not create another graph node. Different
wording can still produce separate facts. Existing facts are not rewritten
or removed by this filter.

Processing works in small batches: one exchange is checked and up to three
eligible facts are saved, then the remaining work is queued automatically.
The standard Docket worker retries failed processing up to three attempts,
30 seconds apart. In-process development mode still offers **Filter now / retry**.
The page distinguishes waiting work, checking, saving, review and failure,
shows counts and last activity times, and refreshes every ten seconds while
visible. A **Saved to long-term** link opens the matching graph node. A chat
appearing in the left panel is not proof that it reached long-term memory.

#### Automatic reading of saved facts

New or updated hook installs enable `longTermRecall`. At session start, the
agent receives recent chat and a small saved-fact briefing. Each public prompt
also requests relevant saved project facts using local keyword search. These
lookups make no generation or embedding calls. Existing manual MCP searches
can still use meaning-based search.

Saved context includes at most six whole facts within an 800-token budget,
with their memory IDs. Lookups keep the exact project and the current user's
private-or-shared user scope; agent-private and session-private records are
excluded. All recalled text is labelled as data, not instructions. Startup
briefings prefer pinned facts within a bounded recent candidate list, not
every pinned record in a large database.

To disable only automatic saved-fact recall, set `"longTermRecall": false` in
the installed `ams-working-memory.json`. Updates preserve this choice. Older
configs without that setting keep recent-chat-only recall until updated.
Recall is optional and can be skipped if the hook's time budget is exhausted.

#### Watch filtering usage

The selected session shows today's reported filtering tokens for that local
user and project, the model, and any calls whose usage is unknown. A token is
a small piece of text the model reads or writes. This is not a currency bill;
it excludes embeddings, summaries and the agent's own calls.

To pause new filtering after a daily allowance, set
`WORKING_MEMORY_DAILY_FILTER_TOKEN_LIMIT=20000` in the server environment
(for the managed install, its protected `runtime.env`), then restart the app.
`0` is the default and means no allowance. The day resets at midnight UTC.
The last admitted call can go over the threshold, so this is **not a hard
spending cap**. Provider-side billing limits remain separate.

Unknown usage pauses new filtering when an allowance is set. Check the provider,
wait for the next UTC day, or deliberately disable the allowance. Captured chat
still follows its normal expiry and already-filtered facts can still be saved.
Usage counters contain no chat and expire after eight days.

#### Keep a small handoff from a longer chat

Optional handoff excerpts help a later task catch up when old exchanges leave
the 30-exchange window. They reuse existing filtered suggestions backed by an
exact user quote. They are not a new AI summary, a task list, or saved long-term
facts, and they do not cause another AI request.

Set `WORKING_MEMORY_HANDOFF_ENABLED=true` in the server's environment (the
managed install's protected `runtime.env`), then run `./ams docker:restart app`.
The default is `false`. The Working Memory page shows **Earlier handoff excerpts**
with the source quote and expiry. **Forget excerpt** removes a note without
changing any long-term memory.

Each session keeps at most six excerpts within a 4,000-character JSON budget.
Each expires seven days from its source message, even if the session stays
active. Private or changed source events retract their earlier excerpts.
Handoffs cannot be promoted directly; saving a lasting fact remains a separate
step. They do not recover chat already dropped before the option was enabled.
They are returned as labelled, untrusted context alongside recent chat, inside
the existing recall size limit. Disabling the option stops returning them.

#### Limits, hooks and privacy

- Up to **30 exchanges per session**: one prompt plus one final reply.
  A session also has a 120,000-character total limit; each message is limited
  to 8,000 characters. Large sessions may keep fewer than 30 exchanges.
- Messages and pending suggestions expire **seven days after the last new
  captured event**. Reading or filtering does not extend that time. This
  feature drops old exchanges; it does not make a permanent chat archive.
- Hooks run at `UserPromptSubmit`, `Stop` and `SessionStart`. A new/resumed
  session gets a bounded slice of recent history from the same user and Git
  project. Old messages are marked as untrusted history, not new instructions.
  Saved-fact recall is separate, bounded keyword search—not a guarantee that
  the agent will use every returned fact.
- Project IDs use the Git remote `owner/name`, falling back to the Git folder
  name. Projectless chats are skipped. The local user ID is shared by the
  installed Codex and Claude hooks. Do not install both user and project hooks
  for the same client unless you intend both to run.
- Codex uses `~/.codex/hooks.json`; Claude uses `~/.claude/settings.json`.
  User-scope installs respect `CODEX_HOME` and `CLAUDE_CONFIG_DIR`. Project
  installs use the project's `.codex/` or `.claude/` folder. Unrelated hook
  entries are kept. Previous config files are backed up in the install folder.
- **Review and trust new or changed hooks in your agent, then start a new
  task.** Codex may skip untrusted hooks. Your client must provide the documented
  `turn_id` (Codex) or `prompt_id` (Claude Code 2.1.196+) and
  `last_assistant_message`. Older clients missing these fields are skipped;
  we do not scrape transcript files as a fallback.
- Hooks send only prompt/final-reply fields to the loopback API. They do not
  read files, transcripts or tool output. Errors and timeouts do not block
  the agent. A private local queue beside the installed hook keeps up to 60
  events, 512 KiB, for up to 24 hours. A later enabled hook for the same
  API/user/project/client retries up to three events. No later hook means no
  replay; expired/overflow entries are dropped on the next queue update.
  This is bounded recovery, not a full chat backup. Replies without a known
  prompt privacy state are omitted.
- A `<private>...</private>` marker or a common secret pattern causes the
  whole exchange to be omitted. These checks are best-effort, **not a complete
  secret detector**. Do not paste secrets expecting every format to be caught.
- In review/auto modes, the filtered chat is sent to the server's configured
  AI provider. API charges may apply. ChatGPT Pro does not pay for those server
  calls. No provider key is needed for capture-only mode; recalled text still
  takes space in the agent's own context.
- Use `AMS_WORKING_MEMORY_DISABLED=1` in an agent's environment to skip its
  hooks. For an authenticated local API, provide `AMS_API_TOKEN` to the agent
  environment. Do not put tokens in project files. The hook accepts loopback
  HTTP URLs only and refuses redirects.
- User/project IDs keep retrieval scopes separate; they are **not access
  controls**. This follows the existing API authentication model. Anyone with
  access to an unauthenticated local server can inspect its data. Do not expose
  the development server to a network.
- Project hook/config files contain a machine path and local user ID. Keep
  them local rather than checking them into a team's repository. No chat is
  written to these config files or Git. The separate local retry queue does
  contain permitted chat, with owner-only file permissions; it contains no
  API token. Old config backups contain settings, not chat.

Hook contracts: [Codex hooks](https://developers.openai.com/codex/hooks) and
[Claude Code hooks](https://code.claude.com/docs/en/hooks). Check actual capture
in your installed Desktop/client version using the tests below.

#### Check that it works

1. In a new agent task inside a Git project, say:
   **“For this project, our agreed rule is to run tests before merging code.”**
   Wait for the reply. Open the review link and choose **Load sessions**.
   The new session should show your prompt and the final reply.
2. In review mode, select the session after filtering finishes. Check any
   suggested fact against its source quote, then choose **Save to long-term**.
   Open the graph and search for the fact. The graph refreshes every 10 seconds.
3. Start a fresh task in the same project and ask:
   **“Search long-term shared memory for our agreed project rule. Give me the
   rule and its memory ID. Do not answer from recent chat alone.”**
   Match the returned ID to the saved fact below. A correct-sounding answer is
   not enough. A task in a different project must not receive that recent chat.
4. Try **“Hello, how are you?”**. This should be captured but should not produce
   a lasting project fact. AI filtering is a judgment, so review the outcome.

If messages appear but suggestions do not, use **Filter now / retry** and check
the displayed filter status. Empty suggestions can be correct. A failed status
can mean a missing provider key or worker problem. If no messages appear,
check hook trust, supported client fields, the server port and the chosen
user/project scope. `./ams doctor` checks the runtime/MCP setup, owned capture
hooks, received events, review/waiting work, saved counts and safe errors. It
does not write a paid test fact or prove the agent used a returned fact; the
fresh-session memory-ID check does that.

To stop capture without changing saved memories:

```bash
./ams working-memory uninstall --agents all --scope user --yes
```

This removes only owned hook entries, leaves a disabled local config, and lets
existing working data expire. Full `uninstall` also removes Working Memory
hooks in the runtime install's scope; separately installed scopes must be
removed with the command above and the matching scope flags.

### Quickstart needs and assumptions

- A Mac supported by the current Docker Desktop release. Apple Silicon and
  Intel Docker images are included.
- Node.js 20 or newer, with `npm` and `npx`.
- Docker Desktop with Docker Compose, installed, open, and ready.
- Codex Desktop, the Codex CLI, Claude Code, or both clients. Codex Desktop
  does not need a separate Codex CLI install.
- Git and access to GitHub for the first clone.
- Internet access to Docker Hub for the fixed container images.
- Local ports `8000` and `9050` free. Other ports can be chosen with flags.
- An OpenAI API key for the default model and embeddings. The server can start
  without it, but model-backed memory work cannot.
- The Docker Desktop licence and any first-run Mac approval have already been
  accepted by a person. The installer cannot accept them for you.

The quickstart is for local development. It binds its public ports to
`127.0.0.1`, which means only this Mac can reach them. Local authentication is
off. Do not expose this setup to a network or use it as a production service.

The installer stores its settings under:

```text
~/Library/Application Support/Shopapps/Agent Memory
```

Its secret file is readable only by the current Mac user. Redis data lives in
a named Docker volume. Both the data and secret file are kept by `uninstall`.
Rule ownership is kept in `rules.json` in the same folder. It stores file
paths, marker hashes, and placement details, not the contents of your files.

### Run the current source in Docker

`./ams docker:install` runs the guided first setup when needed. It then builds
the current checkout and puts it on the saved API port. Use the other short
Docker commands from the repository root:

```bash
./ams docker:install
./ams docker:up
./ams docker:restart app
./ams docker:reset
./ams docker:reset --force
```

| Command | What it does |
| --- | --- |
| `./ams docker:install` | Runs the first setup when needed, builds the current `V0/` source, updates older saved memories so the new code can read them, and replaces only the API, MCP, and worker containers. |
| `./ams docker:up` | Starts the already-built local stack without rebuilding it. |
| `./ams docker:restart app` | Restarts only the API, MCP, and worker. Redis stays running. |
| `./ams docker:reset` | Rebuilds the current `V0/` source and recreates the managed containers after asking for confirmation. The Redis memory volume is kept. |
| `./ams docker:reset --force` | Runs the same safe reset without asking. `--force` does not delete data. |

After changing the source code, run `./ams docker:reset` to rebuild the local
image and put that new code on the saved ports. Use `--force` only when you want
to skip the confirmation question.

These commands use the installed settings and API key without printing them.
The first setup creates those files. Later Docker commands leave them as they
are. The commands build the local image as
`shopapps/agent-memory-server:local`.

Both reset forms keep the named `shopapps-agent-memory-redis-data` volume. That
volume contains the memory database. The Redis container may be recreated, but
the same database volume is attached again. The Skill, MCP settings, agent
rules, and API key are also kept.

An install made before the Shopapps rename keeps its older internal folder,
Docker project, and volume names. This is deliberate. It keeps the same saved
memories attached. A later source rebuild changes only its local image tag.
Fresh installs use the Shopapps names shown here.

Never add `-v` or `--volumes` to a Docker Compose `down` command. Those flags
remove the saved database volume.

### Add an OpenAI key after install

You can skip the key during the first install and add it later. You do not need
to uninstall, and your saved memories are kept.

In a Mac Terminal using `zsh`, run:

```zsh
read -s "OPENAI_API_KEY?OpenAI API key: "
echo
export OPENAI_API_KEY
npx --yes ./V0/installer install --yes
./ams docker:install
unset OPENAI_API_KEY
```

The key is hidden while you type it. The installer saves it in its protected
settings file and restarts the Docker services. Do not paste a key into chat or
save it in this repository.

If the OpenAI dashboard only shows part of an old key, create a new secret key.
OpenAI only shows the full value when the key is created. See the
[official OpenAI API guide](https://developers.openai.com/api/reference/overview).

OpenAI API use is billed separately from a ChatGPT Plus or Pro plan. See
[OpenAI's billing guide](https://help.openai.com/en/articles/9039756).

### Open and test the local API

After the installer finishes, open:

- Memory graph: [http://127.0.0.1:8000/admin/memories/graph](http://127.0.0.1:8000/admin/memories/graph)
- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- Health check: [http://127.0.0.1:8000/v1/health](http://127.0.0.1:8000/v1/health)

The REST API starts at `http://127.0.0.1:8000`. The MCP link used by Codex and
Claude starts at `http://127.0.0.1:9050/mcp`.

The memory graph is a human view. Use the project tabs and namespace list to
narrow the view. Drag the background to move, scroll to zoom, move a node with
the mouse, and click a node to read or edit its details. Opening, searching,
and filtering the graph do not call OpenAI. Saving an edit rebuilds that
memory's search embedding, so it may use a small amount of credit from the
configured embedding provider.

Project, namespace, topic, and entity panels list their connected memories.
Click a listed memory to open it. Topic and Entity tags in a memory panel also
jump to the matching graph node. Larger nodes have more links or more memory
text, and each node has a coloured halo so groups are easier to see.

The graph silently checks for changes every 10 seconds. New memories appear
without a page reload and briefly show a ripple around their node. The refresh
keeps the current zoom, position, filters, and selected memory. It pauses while
you search, drag, edit, or confirm a deletion. If a check fails, the current
graph stays in place.

The memory panel also has **Delete**. It asks again before deleting and removes
only that memory. Deletion is permanent. A pinned memory can still be deleted
by hand, and deleting does not use OpenAI credits. Only give graph access to
people you trust with the memory REST API.

Use **History and undo** to view the last 20 edits and restore an older version.
Undo creates a new version and rebuilds its search embedding, which may use
provider credits. If someone else changed the fact meanwhile, reload and review
it before trying again. History protects edits, not deletion: deleting a memory
also removes its history.

New memories use their project ID for the project tabs. For older memories
without one, the graph uses the leading `owner/project` part of the namespace,
then shows any remaining path as namespace filters.

The built-in graph is for the local Mac quickstart. That setup turns local
authentication off and binds the page to this Mac only. Do not expose that
setup to a network. When API authentication is enabled, the graph page also
requires authentication and does not include its own sign-in screen. A shared
deployment needs a trusted web proxy or another browser login layer that sends
the supported bearer token.

A login or token is not a per-project access rule. Separate team permissions
are not part of this local setup yet; do not use project names as a security
boundary or expose this install as a shared team service.

If you chose different ports, use those port numbers instead. You can also run
the local `status` or `doctor` commands below to check the install.

### Export and restore project facts

From the repository root:

```bash
./ams memories export --project-id example/shop --file facts.json
./ams memories import --project-id example/shop --file facts.json
./ams memories import --project-id example/shop --file facts.json --apply --yes
```

The first command saves the project's current shared facts to a new private
file. It will not replace an existing file. The second command only previews
the restore. The third restores missing facts, keeping their IDs. Matching
facts are skipped; a conflicting ID stops the restore instead of overwriting
data. Restore can use embedding credits. Use `AMS_API_TOKEN` when your server
requires authentication; never put a token in the snapshot.

This is a portable copy of current shared facts, not a full database backup.
It excludes private chat, user-only facts, old edit history, and unknown extra
metadata. Keep the file private and review it before sharing. Pause project
writes while exporting for a consistent copy. Import requires the same project
ID. Large restores run in batches; if interrupted, check the reported counts
and rerun the same file safely. The limits are 10,000 facts and 50 MiB per file.

### Import selected notes or Claude-Mem facts

You do not need a running server to preview a source file. Start with a small
Markdown file such as `facts.md`, containing one fact per top-level bullet:

```markdown
- Use Example Customer in sample customer records.
- Run the project tests before sharing a change.
```

Preview its full facts without saving or calling a model:

```bash
./ams memories import --project-id example/shop --file facts.md \
  --format markdown --source-id team-conventions
```

Read the numbered facts and copy the printed source revision. To save just
fact 1, replace `PASTE_REVISION_HERE` below with that value:

```bash
./ams memories import --project-id example/shop --file facts.md \
  --format markdown --source-id team-conventions \
  --select 1 --source-revision PASTE_REVISION_HERE --apply
```

The command asks before saving. The server must be running for this step;
embedding work can use provider credits. Use `--select 1,3` to choose several
facts. `--yes` alone never saves: `--apply`, selection and revision are required.
Changing the file after preview stops the import until you review it again.

For an official Claude-Mem JSON export:

```bash
./ams memories import --project-id example/shop --file claude-export.json \
  --format claude-mem --source-id old-project-notes --source-project shop
```

`--source-project` is the exact project name inside that export;
`--project-id` is its destination in Agent Memory. Apply selected facts using
the same selection/revision flags. Only the export's structured observation
facts are supported, not prompts, sessions, summaries, narratives or tool
output. See Claude-Mem's [export guide](https://docs.claude-mem.ai/usage/export-import).

Limits and safeguards:

- One regular file, at most 2 MiB, with at most 200 facts of 4,000 characters
  each. Claude-Mem exports may contain at most 2,000 observations.
- Markdown accepts single-line, top-level `-`, `*` or `+` bullets. Code fences,
  comments and front matter are ignored. Links and named files are never read.
- Text is treated as untrusted data, not instructions. Basic private/secret
  screening runs before preview, but you must still review the file yourself.
- Keep `--source-id` stable and generic. It is a saved source label, not a path.
  Saved facts keep the source item and first accepted file revision.
- Repeating unchanged facts from the same source skips matching IDs, even when
  their positions move. Duplicate selected text is saved once. The first accepted
  source citation is kept. Changed text creates a new ID; imports do not replace
  old facts automatically. Use the graph's edit option for corrections.
- Existing conflicting IDs stop the operation; they are never overwritten.
  Keep your original Claude-Mem backup. This is selected-fact transfer, not a
  full history migration or an uninstall step.

### Use shared memory in agent tasks

The installer gives Codex and Claude three things:

- an MCP connection, which is the link to the memory server;
- a shared-memory Skill, which explains how to use that link safely;
- agent rules, which tell new tasks when to read and write memory.

The rules tell an agent to search before project work and save new, checked
facts after project work. This happens while an agent task is running. It is
not a timer or a background job.

#### Save one fact on purpose

Give an agent a plain prompt like this:

```text
Use shared memory. Save this checked project fact:
"The demo service uses port 4321."
Use the current repository for the project scope. Tell me when it is saved.
```

The agent should use the `create_long_term_memories` memory tool. A saved fact
may use the configured embedding provider and a small amount of API credit.
Do not ask an agent to save passwords, API keys, guesses, chat logs, or short
task status.

#### Read the fact in a new task

Start a new task in the same repository and ask:

```text
What port does the demo service use?
```

With the automatic rules loaded, the agent should search shared memory before
answering and return `4321`. In the task details, look for a call to
`memory_prompt` or `search_long_term_memory`. You can also search for the fact
in the [memory graph](http://127.0.0.1:8000/admin/memories/graph).

Delete the sample memory from the graph when the test is finished if you do not
want to keep it.

#### Turn automatic use on for every project

For a new install, choose user scope so the Skill, MCP connection, and rules
apply to new agent tasks in every repository on this Mac:

```bash
./ams docker:install \
  --agents all \
  --scope user \
  --yes \
  --non-interactive
```

For an existing install, add the user-level rules the first time:

```bash
./ams rules install --agents all --scope user --yes
```

Refresh them after this project changes the rule text:

```bash
./ams rules update --agents all --scope user --yes
```

Then check the whole setup:

```bash
./ams doctor
```

Start a new Codex or Claude task after changing the rules. Existing open tasks
may still be using the old instructions.

User-level rules choose a separate memory scope for each Git repository. The
remote `owner/name` is used when available. A project-level install applies
only to the chosen repository.

#### Two quick checks for Codex

**Check 1: direct write and read**

1. Use the save prompt above in one Codex task.
2. Confirm that the new fact appears in the graph.
3. Open a new Codex task in the same repository.
4. Ask for the port without telling Codex to use memory.
5. Confirm that Codex searches memory and answers `4321`.

**Check 2: automatic project use**

1. Run `./ams doctor` and check that the containers, Codex MCP connection,
   shared-memory Skill, and Codex rules are healthy.
2. Start a new Codex task in another Git repository.
3. Ask Codex to inspect one small part of that project.
4. Check the task details for a memory search near the start.
5. If Codex finds a new, useful, checked fact, check the graph for a write near
   the end of the task.

The second check may not add a memory every time. Agents should only save facts
that will help later. Similar facts may also be merged. This means a total such
as 45 memories can be healthy even after many tasks. The direct write-and-read
check is a better test than the total count.

If the direct check fails, run `./ams doctor`, refresh the rules, and start a
new task. If Doctor reports an unhealthy container, run `./ams docker:up`. If
it reports a missing Skill or MCP connection, rerun `./ams docker:install` with
the same user-scope options shown above.

### Useful CLI commands

Run these from the repository root. The `./ams` helper is the short form:

```bash
./ams status
./ams doctor
./ams update
./ams start
./ams stop
./ams logs
```

The longer local installer commands remain supported:

```bash
npx --yes ./V0/installer status
npx --yes ./V0/installer doctor
npx --yes ./V0/installer update
npx --yes ./V0/installer rules install --agents all --scope user --yes
npx --yes ./V0/installer rules update --agents all --scope user --yes
npx --yes ./V0/installer rules uninstall --scope user --yes
npx --yes ./V0/installer start
npx --yes ./V0/installer stop
npx --yes ./V0/installer logs
npx --yes ./V0/installer logs --follow
npx --yes ./V0/installer uninstall
```

`./ams start` remembers when the local source image is active. A normal
`./ams update` moves back to the fixed release image. Run
`./ams docker:install` afterwards if you want to use the current checkout
again.

For a team setup without questions:

```bash
./ams docker:install \
  --agents auto \
  --scope user \
  --yes \
  --non-interactive
```

For one repository only, pass its full path while running the command from the
`agent-memory-server` repository root:

```bash
./ams docker:install \
  --agents codex \
  --scope project \
  --project-dir "/path/to/your/project" \
  --namespace shopapps/acr \
  --yes
```

### Use the rules-only commands

The rules-only commands do not change Docker, MCP, the Skill, or saved
memories. They also update their small ownership record in `rules.json`.

To add or refresh only the agent rules for one repository, without touching
Docker, MCP, the Skill, or saved memories, run:

```bash
npx --yes ./V0/installer rules update \
  --agents all \
  --scope project \
  --project-dir "/path/to/your/project" \
  --namespace shopapps/acr \
  --yes
```

Use `rules install` the first time. The install and update commands are safe to
rerun. Use `rules uninstall` to remove only the owned rules block. Start a new
Codex or Claude task afterwards so the agent loads the changed file.
The command remembers each global or project rules setup, so later updates use
the same scope and memory name. If several project setups exist, pass
`--project-dir` to choose one.

On full uninstall, an unchanged owned block is removed and the file's original
spacing is restored. If the block or a file link was changed by hand, the file
is kept and a warning is shown.

Use `--api-port 8100` or `--mcp-port 9150` if a default port is busy. Run
`npx --yes ./V0/installer --help` for every option.

### Optional local command

You can add the local `agent-memory` command to your Mac. This uses a link to
this checkout, so code changes here are used by the command:

```bash
cd V0/installer
npm link
agent-memory --help
```

After that, replace `npx --yes ./V0/installer` with `agent-memory` in the
examples above. Run `npm unlink --global @shopapps/agent-memory` to remove the
link. This is optional. It adds a global command and may clash with the Python
server command, which is also named `agent-memory`. The local `npx` path is the
safer choice.

### Future npm release

The package name is declared in `V0/installer/package.json`, but it is not
available from the npm registry. Only after the team chooses to publish it will
this command work:

```bash
npx --yes @shopapps/agent-memory@latest
```

Before publishing, build a matching project-owned server image and update the
fixed image digest in the release manifest. The current package pins the
upstream `0.15.2` research image.

## Manual source install

The manual steps below are still supported. Use them to work on the Python
source or when the npm quickstart is not available.

### What you need

- macOS
- Python 3.12
- `uv`
- Docker Desktop with Docker Compose
- An API key for the LLM provider you plan to use

The project requires Python 3.12. Python 3.13 is not supported.

If you use Homebrew, install the local tools with:

```bash
brew install python@3.12 uv
```

See the official [uv installation guide](https://docs.astral.sh/uv/getting-started/installation/)
for other ways to install `uv`.

Install [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/)
and open it. Then check the tools:

```bash
python3.12 --version
uv --version
docker --version
docker compose version
```

### Install the project

All source and build commands live in `V0/`:

```bash
cd V0
uv venv --python 3.12
source .venv/bin/activate
make sync
```

Activate `.venv` again whenever you open a new terminal:

```bash
cd V0
source .venv/bin/activate
```

### Add local settings

Create a local environment file:

```bash
cp .env.example .env
```

For local development, set these values in `.env`:

```dotenv
REDIS_URL=redis://localhost:6379
DISABLE_AUTH=true
OPENAI_API_KEY=replace-with-your-key
```

You may use another supported LLM provider instead. See
[`V0/docs/llm-providers.md`](./V0/docs/llm-providers.md).

Do not commit `.env` or real API keys. `DISABLE_AUTH=true` is for local work
only. Production must use authentication.

### Start Redis 8

From `V0/`, run:

```bash
docker compose up -d redis
docker compose ps redis
docker compose exec -T redis redis-server --version
```

The version output must start with Redis 8.

If port `6379` is already in use, use another host port:

```bash
REDIS_PORT=6381 docker compose up -d redis
```

Then change the local `.env` value to:

```dotenv
REDIS_URL=redis://localhost:6381
```

### Start the REST API

For simple local development, use the built-in asyncio task runner. It does not
need a separate worker:

```bash
uv run agent-memory api --task-backend asyncio
```

The API starts on port `8000`. In another terminal, check it:

```bash
curl http://localhost:8000/v1/health
```

A JSON response containing `now` means the API is ready. API documentation is
available at [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs).

Stop the API with `Control-C`.

### Start MCP

The normal local MCP mode uses standard input and output:

```bash
uv run agent-memory mcp --mode stdio --task-backend asyncio
```

It may appear quiet while it waits for an MCP client. Stop it with `Control-C`.

For a network MCP server instead:

```bash
uv run agent-memory mcp --mode sse --port 9000 --task-backend asyncio
```

### Add agent rules by hand

For a manual setup, add this to the active `AGENTS.md` used by Codex and the
active `CLAUDE.md` used by Claude:

```md
## Shared memory

Before project work, use the `shared-memory` Skill to search for earlier
decisions, fixes, rules, and handoff facts that may apply.

After project work, save only new, checked facts that will help later. Keep
tasks and work status in Beads or the project task tracker.
```

Use the global or project paths from the table above. The installer version has
managed markers so it can update its own block without changing your other
instructions.

### Run the checks

Run commands from `V0/` with `.venv` active:

```bash
make test-unit
REDIS_IMAGE=redis:8 make test-integration
make test
make lint
uv run ruff format --check .
```

Only run the API-key test group when the required provider keys are already set:

```bash
make test-api
```

### Existing Redis data

If this Redis instance contains data from an older server version, run:

```bash
uv run agent-memory migrate-memories
```

The migration keeps stored memory data and updates the search index when needed.

### Stop Redis

The API and MCP commands should be stopped with `Control-C`. Stop Redis with:

```bash
docker compose stop redis
```

This keeps the local Redis volume for the next run.

### Common problems

#### Docker cannot connect

Open Docker Desktop and wait until its engine is running.

#### Port 6379 is busy

Use the `REDIS_PORT=6381` example above and make `REDIS_URL` use the same port.

#### Python has the wrong version

Recreate the environment with Python 3.12:

```bash
uv venv --python 3.12
source .venv/bin/activate
make sync
```

#### LLM or embedding calls fail

Check that the matching provider key and model settings exist in `.env`. The
server can start without a key, but features that call an LLM or create vector
embeddings still need one.
