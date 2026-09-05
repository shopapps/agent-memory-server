# Agent Memory installer

This package gives a Mac one command to run the local Agent Memory server and
connect it to Codex or Claude Code. It is not published to npm.

From the root of this repository, run:

```bash
./ams docker:install
```

The longer `npx --yes ./V0/installer docker:install` form remains supported.

Do not use `npx @shopapps/agent-memory@latest`; npm will return `404 Not Found`.

It needs Node.js 20 or newer, Docker Desktop with Docker Compose, internet
access, and Codex Desktop, Codex CLI or Claude Code. Desktop-only Codex installs
are detected in `/Applications` or `~/Applications`; no separate Codex CLI is
needed. Claude Code still needs its command on the path. Docker Desktop must
be open. Ports `8000` and `9050` must be free unless other ports are passed.

The default model and embeddings need `OPENAI_API_KEY`. The guided installer
can collect it without showing it on screen. Secrets are stored in a file that
only the current Mac user can read.

No hooks are installed by default. The package adds a normal Skill folder, MCP setting,
and marked instruction block for each chosen agent. Updates replace only that
marked block in `AGENTS.md` or `CLAUDE.md`; all other text is preserved.

## Optional Working Memory

Add `--working-memory` to `./ams docker:install`, or enable it separately:

```bash
./ams working-memory install --agents all --scope user --yes
./ams working-memory update --agents all --scope user --promotion review --yes
./ams working-memory uninstall --agents all --scope user --yes
```

The standalone commands need Node.js but do not run the Codex or Claude CLI.
They preserve other hook entries and print a link to the review page. Start a
new task after reviewing and trusting the hooks in your agent. Rebuild the
server first with `./ams docker:reset` if it predates this feature.

The review page auto-fills the saved user ID for the default local setup.
Working Memory install/update copies the ID into the managed `runtime.env`;
use `./ams docker:restart app` to load it in an already-running app. A source
rebuild also picks up the saved ID. This does not change your memory database.
If auto-fill is unavailable, copy `userId` from `ams-working-memory.json` in
your Codex or Claude settings folder. See [ID recovery and API token help](../../INSTALL.md#local-user-id-and-api-token).

The default `review` mode captures up to 30 exchanges for seven days and uses
AI to suggest project facts. You choose what reaches the long-term graph.
Use `--promotion off` for capture only, or explicitly choose `auto` to share
AI-selected facts without review. See [setup, costs, privacy and tests](../../INSTALL.md#working-memory).

New/updated hooks also recall up to six saved project facts using local keyword
search, without extra model calls. `./ams doctor` checks capture activity as
well as installed settings. The review page refreshes quietly and links saved
facts to their graph nodes. The hook's private retry queue can replay permitted
events after a local outage; see [limits and privacy](../../INSTALL.md#limits-hooks-and-privacy).

## Add an OpenAI key later

You can skip the key during the first install. Add it later without deleting
your saved memories:

```zsh
read -s "OPENAI_API_KEY?OpenAI API key: "
echo
export OPENAI_API_KEY
./ams install --yes
./ams docker:install
unset OPENAI_API_KEY
```

The key is hidden while you type it. It is saved in the installer's protected
settings file. OpenAI API use is billed separately from ChatGPT Plus or Pro.

## Local links

After install:

- API docs: [http://127.0.0.1:8000/docs](http://127.0.0.1:8000/docs)
- Health check: [http://127.0.0.1:8000/v1/health](http://127.0.0.1:8000/v1/health)
- MCP: `http://127.0.0.1:9050/mcp`

Use your chosen port numbers if you changed the defaults.

## Commands

From the repository root, prefix each command with
`npx --yes ./V0/installer`. For example:

```bash
npx --yes ./V0/installer rules update \
  --agents all \
  --scope project \
  --project-dir "/path/to/your/project" \
  --namespace shopapps/acr \
  --yes
```

The available commands are:

```text
agent-memory install
agent-memory docker:install
agent-memory docker:up
agent-memory docker:restart app
agent-memory docker:reset [--force]
agent-memory rules install
agent-memory rules update
agent-memory rules uninstall
agent-memory working-memory install
agent-memory working-memory update
agent-memory working-memory uninstall
agent-memory memories export --project-id example/shop --file facts.json
agent-memory memories import --project-id example/shop --file facts.json
agent-memory status
agent-memory doctor
agent-memory update
agent-memory start
agent-memory stop
agent-memory logs [--follow]
agent-memory uninstall
```

Run `npx --yes ./V0/installer --help` for flags. `uninstall` keeps Redis data
and secrets.

`memories import` previews by default. Add `--apply --yes` to restore missing
facts without replacing existing ones. Exports contain current shared project
facts, not private chat or edit history. See [export and restore](../../INSTALL.md#export-and-restore-project-facts)
for limits, privacy, and safe retry instructions.

To preview selected source facts without Docker or an API call:

```bash
./ams memories import --project-id example/shop --file facts.md \
  --format markdown --source-id team-conventions
```

Run this from the repository root. `--format claude-mem` also supports structured
facts from an official JSON export, with its exact `--source-project`.
Saving needs `--select`, the preview's `--source-revision`, and `--apply` plus
confirmation. See [reviewed imports](../../INSTALL.md#import-selected-notes-or-claude-mem-facts)
for formats, limits and examples. The default import format remains an Agent
Memory snapshot.

Normal `install` and `update` also install or refresh the rules. The rules-only
commands do not touch Docker, MCP, the Skill, or saved memories.

The `docker:` commands are for a repository checkout. `docker:install` runs
the normal first install when needed, then builds and runs the current `V0/`
source through the managed Compose setup.
After changing the source code, `./ams docker:reset` rebuilds it and recreates
the managed containers. Reset never passes a volume-removal flag, so the
`shopapps-agent-memory-redis-data` memory database is kept. `--force` skips only
the reset question.

Older installs keep their original internal folder, Docker project, and volume
names. This keeps their existing memory volume attached. A later source rebuild
changes only the local image tag. Fresh installs use Shopapps names.

See the main [install guide](../../INSTALL.md#use-shared-memory-in-agent-tasks)
for simple save, recall, automatic-use, and Codex test examples.

## Optional local command

To use `agent-memory` without the longer `npx` prefix:

```bash
cd V0/installer
npm link
agent-memory --help
```

This links the command to your local checkout. Remove it with
`npm unlink --global @shopapps/agent-memory`. This is optional. It adds a global
command and may clash with the Python server command, which is also named
`agent-memory`. The local `npx` path is safer.

User scope writes the active global Codex and Claude instruction files.
Project scope writes the active files in that project. If safe markers are
missing, repeated, or out of order, the command stops without changing the
file. A small `rules.json` registry stores paths and hashes, not instruction
file contents. This lets updates and uninstall check ownership before making a
change. Use `rules uninstall` to remove a rules-only setup without touching the
runtime or saved memories. Start a new agent task after a change.

## Work on this package

From `V0/installer/`:

```bash
npm test
npm run check
npm run pack:check
node bin/agent-memory.js --help
```

The release manifest pins exact Docker image digests. If the team later decides
to publish the npm package, publish a matching server image first, update that
manifest, and run all checks. Only then will
`npx --yes @shopapps/agent-memory@latest` work.
