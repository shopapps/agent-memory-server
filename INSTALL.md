# Local installation

This guide runs the open-source `V0/` server on macOS.

This is the research version of Redis Agent Memory. For the supported managed
service, see [Redis Agent Memory in Redis Iris](https://redis.io/agent-memory/).

## Quickstart for a Mac

The quickstart installs the server, Redis 8, the shared-memory Skill, and the
MCP link used by Codex or Claude. MCP is the local link that lets an agent use
the memory tools.

After the npm package has been published, run:

```bash
npx --yes @umony/agent-memory@latest
```

The package is not on npm yet. From this repository, the same installer can be
run now with:

```bash
npx --yes ./V0/installer
```

The installer shows its plan before it changes anything. It then:

- checks Docker Desktop and the chosen agent apps;
- downloads fixed Docker image versions;
- starts Redis, the REST API, MCP, and the background worker;
- adds the shared-memory Skill for Codex, Claude, or both;
- adds the native MCP setting for each chosen agent;
- waits until the local server is healthy.

No hooks are added. A hook is a script that runs when an agent event happens.
Codex and Claude discover the Skill from their normal Skill folders and use
their normal MCP settings, so hooks are not needed.

### Quickstart needs and assumptions

- A Mac supported by the current Docker Desktop release. Apple Silicon and
  Intel Docker images are included.
- Node.js 20 or newer, with `npm` and `npx`.
- Docker Desktop with Docker Compose, installed, open, and ready.
- One supported command-line agent: Codex, Claude Code, or both.
- Internet access to npm and Docker Hub.
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

### Add an OpenAI key after install

You can skip the key during the first install and add it later. You do not need
to uninstall, and your saved memories are kept.

In a Mac Terminal using `zsh`, run:

```zsh
read -s "OPENAI_API_KEY?OpenAI API key: "
echo
export OPENAI_API_KEY
npx --yes @umony/agent-memory@latest install --yes
unset OPENAI_API_KEY
```

The key is hidden while you type it. The installer saves it in its protected
settings file and restarts the Docker services. Do not paste a key into chat or
save it in this repository.

Until the npm package is published, replace the install line above with this
command and run it from the repository root:

```zsh
npx --yes ./V0/installer install --yes
```

If the OpenAI dashboard only shows part of an old key, create a new secret key.
OpenAI only shows the full value when the key is created. See the
[official OpenAI API guide](https://developers.openai.com/api/reference/overview).

OpenAI API use is billed separately from a ChatGPT Plus or Pro plan. See
[OpenAI's billing guide](https://help.openai.com/en/articles/9039756).

### Open and test the local API

After the installer finishes, open:

- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- Health check: [http://127.0.0.1:8000/v1/health](http://127.0.0.1:8000/v1/health)

The REST API starts at `http://127.0.0.1:8000`. The MCP link used by Codex and
Claude starts at `http://127.0.0.1:9050/mcp`.

If you chose different ports, use those port numbers instead. You can also run
`npx --yes @umony/agent-memory@latest status` or `doctor` to check the install.

### Useful CLI commands

Use the same `npx --yes @umony/agent-memory@latest` prefix for each command:

```bash
npx --yes @umony/agent-memory@latest status
npx --yes @umony/agent-memory@latest doctor
npx --yes @umony/agent-memory@latest update
npx --yes @umony/agent-memory@latest start
npx --yes @umony/agent-memory@latest stop
npx --yes @umony/agent-memory@latest logs
npx --yes @umony/agent-memory@latest logs --follow
npx --yes @umony/agent-memory@latest uninstall
```

Until the npm package is published, replace that prefix with
`npx --yes ./V0/installer` and run it from this repository root.

For a team setup without questions:

```bash
npx --yes @umony/agent-memory@latest install \
  --agents auto \
  --scope user \
  --yes \
  --non-interactive
```

For one repository only, run this inside that repository:

```bash
npx --yes @umony/agent-memory@latest install \
  --agents codex \
  --scope project \
  --project-dir "$PWD" \
  --yes
```

Use `--api-port 8100` or `--mcp-port 9150` if a default port is busy. Run
`npx --yes @umony/agent-memory@latest --help` for every option.

Before giving the public command to the team, publish this npm package and a
matching project-owned server image, then update the fixed image digest in the
release manifest. The current package pins the upstream `0.15.2` research
image.

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
