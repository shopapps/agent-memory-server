# Local installation

This guide runs the open-source `V0/` server on macOS.

This is the research version of Redis Agent Memory. For the supported managed
service, see [Redis Agent Memory in Redis Iris](https://redis.io/agent-memory/).

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

Do not use `npx @umony/agent-memory@latest`. That name is not on npm and will
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

No hooks are added. A hook is a script that runs when an agent event happens.
The normal instruction file, Skill folder, and MCP setting are enough.

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
`--namespace umony/acr`. A namespace is simply the memory folder name shared
by Codex and Claude.

### Quickstart needs and assumptions

- A Mac supported by the current Docker Desktop release. Apple Silicon and
  Intel Docker images are included.
- Node.js 20 or newer, with `npm` and `npx`.
- Docker Desktop with Docker Compose, installed, open, and ready.
- One supported command-line agent: Codex, Claude Code, or both.
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
~/Library/Application Support/Umony/Agent Memory
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
`umony/agent-memory-server:local`.

Both reset forms keep the named `umony-agent-memory-redis-data` volume. That
volume contains the memory database. The Redis container may be recreated, but
the same database volume is attached again. The Skill, MCP settings, agent
rules, and API key are also kept.

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

The memory panel also has **Delete**. It asks again before deleting and removes
only that memory. Deletion is permanent. A pinned memory can still be deleted
by hand, and deleting does not use OpenAI credits. Only give graph access to
people you trust with the memory REST API.

New memories use their project ID for the project tabs. For older memories
without one, the graph uses the leading `owner/project` part of the namespace,
then shows any remaining path as namespace filters.

The built-in graph is for the local Mac quickstart. That setup turns local
authentication off and binds the page to this Mac only. Do not expose that
setup to a network. When API authentication is enabled, the graph page also
requires authentication and does not include its own sign-in screen. A shared
deployment needs a trusted web proxy or another browser login layer that sends
the supported bearer token.

If you chose different ports, use those port numbers instead. You can also run
the local `status` or `doctor` commands below to check the install.

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
  --namespace umony/acr \
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
  --namespace umony/acr \
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
examples above. Run `npm unlink --global @umony/agent-memory` to remove the
link. This is optional. It adds a global command and may clash with the Python
server command, which is also named `agent-memory`. The local `npx` path is the
safer choice.

### Future npm release

The package name is declared in `V0/installer/package.json`, but it is not
available from the npm registry. Only after the team chooses to publish it will
this command work:

```bash
npx --yes @umony/agent-memory@latest
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
