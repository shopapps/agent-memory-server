import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { Installer, mergeEnv } from "../src/installer.js";
import { createSystem } from "../src/system.js";

const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("mergeEnv preserves unknown settings and replaces owned keys", () => {
  const merged = mergeEnv(
    "# local note\nCUSTOM=value\nAMS_API_PORT=7000\n",
    { AMS_API_PORT: "8000", AMS_MCP_PORT: "9050" },
  );
  assert.match(merged, /# local note/);
  assert.match(merged, /CUSTOM=value/);
  assert.match(merged, /AMS_API_PORT="8000"/);
  assert.match(merged, /AMS_MCP_PORT="9050"/);
});

test("installs the runtime before adding client configuration", async () => {
  const fixture = await createFixture();
  const result = await fixture.installer.run("install", {
    agents: ["codex", "claude"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });

  assert.equal(result.ok, true);
  assert.equal(result.providerConfigured, true);
  const upIndex = fixture.calls.findIndex((call) => call.args.includes("--wait-timeout") && !call.args.includes("redis"));
  const codexAddIndex = fixture.calls.findIndex((call) => call.command === "codex" && call.args[1] === "add");
  const claudeAddIndex = fixture.calls.findIndex((call) => call.command === "claude" && call.args[1] === "add");
  assert.ok(upIndex >= 0);
  assert.ok(codexAddIndex > upIndex);
  assert.ok(claudeAddIndex > upIndex);

  const paths = fixture.installer.paths();
  const saved = JSON.parse(await readFile(paths.state, "utf8"));
  assert.equal(saved.phase, "ready");
  assert.deepEqual(Object.keys(saved.agents), ["codex", "claude"]);
  assert.equal((await stat(paths.runtimeEnv)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(fixture.home, ".agents", "skills", "shared-memory"))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(fixture.home, ".claude", "skills", "shared-memory"))).isSymbolicLink(), true);
});

test("a failed Docker health gate does not add Skills or MCP entries", async () => {
  const fixture = await createFixture({ failFullUp: true });

  await assert.rejects(
    fixture.installer.run("install", {
      agents: ["codex"],
      apiPort: 8000,
      mcpPort: 9050,
      projectDir: fixture.project,
      scope: "user",
    }),
    { code: "E_STARTUP_TIMEOUT" },
  );

  assert.equal(
    fixture.calls.some((call) => call.command === "codex" && call.args[1] === "add"),
    false,
  );
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.home, ".agents", "skills", "shared-memory")),
    null,
  );
  const cleanup = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("down"),
  );
  assert.ok(cleanup);
  assert.equal(cleanup.args.includes("--volumes"), false);
});

test("uninstall removes only owned client entries and preserves the Docker volume", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  const result = await fixture.installer.run("uninstall", {});

  assert.equal(result.ok, true);
  assert.equal(result.dataPreserved, true);
  const down = fixture.calls.find((call) => call.command === "docker" && call.args.includes("down"));
  assert.ok(down);
  assert.equal(down.args.includes("--volumes"), false);
  assert.equal(down.args.includes("-v"), false);
  const state = JSON.parse(await readFile(fixture.installer.paths().state, "utf8"));
  assert.equal(state.phase, "uninstalled");
});

test("repeat install keeps ownership so uninstall can remove installer entries", async () => {
  const fixture = await createFixture();
  const options = {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  };
  await fixture.installer.run("install", options);
  await fixture.installer.run("install", options);
  await fixture.installer.run("uninstall", {});

  assert.equal(
    fixture.calls.some((call) => call.command === "codex" && call.args[1] === "remove"),
    true,
  );
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.home, ".agents", "skills", "shared-memory")),
    null,
  );
});

test("plain rerun repairs every requested agent after client registration fails", async () => {
  const fixture = await createFixture({ failClaudeAddOnce: true });
  const options = {
    agents: ["codex", "claude"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  };

  await assert.rejects(
    fixture.installer.run("install", options),
    { code: "E_AGENT_CONFIG" },
  );

  const repaired = await fixture.installer.run("install", {
    agents: null,
    apiPort: null,
    mcpPort: null,
    projectDir: null,
    scope: null,
  });

  assert.deepEqual(repaired.agents, ["codex", "claude"]);
  const state = JSON.parse(await readFile(fixture.installer.paths().state, "utf8"));
  assert.equal(state.phase, "ready");
  assert.deepEqual(Object.keys(state.agents), ["codex", "claude"]);
});

test("update keeps saved custom ports when no new ports are passed", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8010,
    mcpPort: 9060,
    projectDir: fixture.project,
    scope: "user",
  });

  await fixture.installer.run("update", {
    agents: null,
    apiPort: null,
    mcpPort: null,
    projectDir: fixture.project,
    scope: null,
  });

  const state = JSON.parse(await readFile(fixture.installer.paths().state, "utf8"));
  assert.equal(state.apiPort, 8010);
  assert.equal(state.mcpPort, 9060);
});

test("repair rejects a scope move so old client entries are not orphaned", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });

  await assert.rejects(
    fixture.installer.run("install", {
      agents: ["codex"],
      apiPort: null,
      mcpPort: null,
      projectDir: fixture.project,
      scope: "project",
    }),
    { code: "E_RECONFIGURE" },
  );
});

async function createFixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-installer-"));
  const home = path.join(root, "home with spaces");
  const project = path.join(root, "project with spaces");
  const calls = [];
  const mcp = new Map();
  let claudeAddFailed = false;
  const system = createSystem({
    cwd: project,
    env: { OPENAI_API_KEY: "test-secret" },
    fetch: async () => ({ ok: true }),
    home,
    input: { isTTY: true },
    isPortAvailable: async () => true,
    now: () => new Date("2026-08-27T08:00:00.000Z"),
    output: { isTTY: true, write() {} },
    platform: "darwin",
    run: async (command, args) => {
      calls.push({ args, command });
      if (["codex", "claude"].includes(command) && args[0] === "--version") {
        return success(`${command} 1.0`);
      }
      if (["codex", "claude"].includes(command) && args[1] === "get") {
        if (!mcp.has(command)) {
          return { code: 1, stderr: "not found", stdout: "" };
        }
        const url = mcp.get(command);
        return command === "codex"
          ? success(JSON.stringify({ transport: { url } }))
          : success(`URL: ${url}`);
      }
      if (["codex", "claude"].includes(command) && args[1] === "add") {
        if (command === "claude" && options.failClaudeAddOnce && !claudeAddFailed) {
          claudeAddFailed = true;
          return { code: 1, stderr: "registration failed", stdout: "" };
        }
        const url = command === "codex" ? args[4] : args.at(-1);
        mcp.set(command, url);
        return success();
      }
      if (["codex", "claude"].includes(command) && args[1] === "remove") {
        mcp.delete(command);
        return success();
      }
      if (
        command === "docker"
        && options.failFullUp
        && args.includes("up")
        && args.includes("--wait-timeout")
        && !args.includes("redis")
      ) {
        return { code: 1, stderr: "unhealthy", stdout: "" };
      }
      return success();
    },
  });
  await system.mkdir(home);
  await system.mkdir(project);
  const ui = { confirm: async () => true, info() {}, warn() {} };
  const installer = new Installer({ packageRoot: PACKAGE_ROOT, system, ui });
  return { calls, home, installer, project, system };
}

function success(stdout = "") {
  return { code: 0, stderr: "", stdout };
}
