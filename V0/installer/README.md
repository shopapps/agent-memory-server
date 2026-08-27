# Agent Memory installer

This package gives a Mac one command to run the local Agent Memory server and
connect it to Codex or Claude Code.

```bash
npx --yes @umony/agent-memory@latest
```

It needs Node.js 20 or newer, Docker Desktop with Docker Compose, internet
access, and Codex or Claude Code on the command path. Docker Desktop must be
open. Ports `8000` and `9050` must be free unless other ports are passed.

The default model and embeddings need `OPENAI_API_KEY`. The guided installer
can collect it without showing it on screen. Secrets are stored in a file that
only the current Mac user can read.

No hooks are installed. The package adds a normal Skill folder and a normal
MCP setting for each chosen agent.

## Add an OpenAI key later

You can skip the key during the first install. Add it later without deleting
your saved memories:

```zsh
read -s "OPENAI_API_KEY?OpenAI API key: "
echo
export OPENAI_API_KEY
npx --yes @umony/agent-memory@latest install --yes
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

```text
agent-memory install
agent-memory status
agent-memory doctor
agent-memory update
agent-memory start
agent-memory stop
agent-memory logs [--follow]
agent-memory uninstall
```

Run `agent-memory --help` for flags. `uninstall` keeps Redis data and secrets.

## Work on this package

From `V0/installer/`:

```bash
npm test
npm run check
npm run pack:check
node bin/agent-memory.js --help
```

The release manifest pins exact Docker image digests. Publish a matching server
image first, update that manifest, run the checks, and only then publish this
npm package.
