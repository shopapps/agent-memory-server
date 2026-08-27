# Agent Memory installer

This package gives a Mac one command to run the local Agent Memory server and
connect it to Codex or Claude Code. It is not published to npm.

From the root of this repository, run:

```bash
npx --yes ./V0/installer
```

Do not use `npx @umony/agent-memory@latest`; npm will return `404 Not Found`.

It needs Node.js 20 or newer, Docker Desktop with Docker Compose, internet
access, and Codex or Claude Code on the command path. Docker Desktop must be
open. Ports `8000` and `9050` must be free unless other ports are passed.

The default model and embeddings need `OPENAI_API_KEY`. The guided installer
can collect it without showing it on screen. Secrets are stored in a file that
only the current Mac user can read.

No hooks are installed. The package adds a normal Skill folder, MCP setting,
and marked instruction block for each chosen agent. Updates replace only that
marked block in `AGENTS.md` or `CLAUDE.md`; all other text is preserved.

## Add an OpenAI key later

You can skip the key during the first install. Add it later without deleting
your saved memories:

```zsh
read -s "OPENAI_API_KEY?OpenAI API key: "
echo
export OPENAI_API_KEY
npx --yes ./V0/installer install --yes
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
  --namespace umony/acr \
  --yes
```

The available commands are:

```text
agent-memory install
agent-memory rules install
agent-memory rules update
agent-memory rules uninstall
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

Normal `install` and `update` also install or refresh the rules. The rules-only
commands do not touch Docker, MCP, the Skill, or saved memories.

## Optional local command

To use `agent-memory` without the longer `npx` prefix:

```bash
cd V0/installer
npm link
agent-memory --help
```

This links the command to your local checkout. Remove it with
`npm unlink --global @umony/agent-memory`. This is optional. It adds a global
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
`npx --yes @umony/agent-memory@latest` work.
