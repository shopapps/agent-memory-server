import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { detectAgents, inspectMcp, installMcp, removeOwnedMcp, skillTargetPath } from "../src/agents.js";
import { createSystem } from "../src/system.js";

test("uses the current Codex and Claude Skill paths", () => {
  assert.equal(
    skillTargetPath("codex", "user", "/Users/dev", "/repo"),
    "/Users/dev/.agents/skills/shared-memory",
  );
  assert.equal(
    skillTargetPath("claude", "project", "/Users/dev", "/repo"),
    "/repo/.claude/skills/shared-memory",
  );
});

test("detects Codex Desktop in either Applications directory when CLI is absent", async () => {
  for (const installed of ["/Applications/Codex.app", "/Users/dev/Applications/Codex.app", null]) {
    const calls = [];
    const system = {
      env: {}, home: "/Users/dev", platform: "darwin",
      run: async (command, args) => {
        calls.push([command, args]);
        throw Object.assign(new Error("not installed"), { code: "ENOENT" });
      },
      lstatSafe: async (target) => target === installed ? { isDirectory: () => true } : null,
    };
    assert.deepEqual(await detectAgents(system), installed ? ["codex"] : []);
    assert.equal(calls.every(([, args]) => args[0] === "--version"), true);
  }
});

test("Desktop-only MCP setup preserves user config and honors CODEX_HOME", async () => {
  for (const customHome of [false, true]) {
    const home = await mkdtemp(path.join(os.tmpdir(), "agent-memory-desktop-"));
    const directory = path.join(home, customHome ? "custom-codex" : ".codex");
    const configPath = path.join(directory, "config.toml");
    const calls = [];
    const system = createSystem({ home, env: customHome ? { CODEX_HOME: directory } : {},
      run: async (command, args) => {
        calls.push([command, args]);
        throw Object.assign(new Error("not installed"), { code: "ENOENT" });
      } });
    const original = "# My settings\nmodel = \"gpt-5\"\n\n\n[features]\nexample = true\n";
    await system.writeFileAtomic(configPath, original, 0o600);
    const options = { name: "shared-memory", scope: "user", projectDir: path.join(home, "repo"), url: "http://127.0.0.1:9050/mcp" };
    assert.equal((await installMcp(system, "codex", options)).created, true);
    const installed = await readFile(configPath, "utf8");
    assert.equal(installed.startsWith(original), true);
    assert.equal((await installMcp(system, "codex", options)).created, false);
    assert.equal(await readFile(configPath, "utf8"), installed);
    assert.equal((await inspectMcp(system, "codex", options)).status, "matching");
    assert.equal((await stat(configPath)).mode & 0o777, 0o600);
    assert.equal(await removeOwnedMcp(system, "codex", options), true);
    assert.equal(await readFile(configPath, "utf8"), original);
    assert.equal(await removeOwnedMcp(system, "codex", options), false);
    assert.equal(calls.some(([, args]) => args[1] === "add"), false);
    if (customHome) assert.equal(await system.lstatSafe(path.join(home, ".codex")), null);
  }
});

test("Desktop-only setup keeps foreign quoted MCP tables and linked files untouched", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "agent-memory-desktop-conflict-"));
  const system = createSystem({ home, env: {}, run: async () => {
    throw Object.assign(new Error("not installed"), { code: "ENOENT" });
  } });
  const configPath = path.join(home, ".codex", "config.toml");
  const foreign = '[mcp_servers."shared-memory"]\n  url = "http://127.0.0.1:9999/mcp"\n';
  await system.writeFileAtomic(configPath, foreign);
  const options = { name: "shared-memory", scope: "user", url: "http://127.0.0.1:9050/mcp" };
  await assert.rejects(installMcp(system, "codex", options), { code: "E_MCP_CONFLICT" });
  assert.equal(await removeOwnedMcp(system, "codex", options), false);
  assert.equal(await readFile(configPath, "utf8"), foreign);
  const linkedHome = path.join(home, "linked-codex");
  await system.mkdir(linkedHome);
  await system.symlink(configPath, path.join(linkedHome, "config.toml"));
  system.env.CODEX_HOME = linkedHome;
  await assert.rejects(installMcp(system, "codex", options), { code: "E_MCP_CONFLICT" });
  await assert.rejects(removeOwnedMcp(system, "codex", options), { code: "E_MCP_CONFLICT" });
  assert.equal(await readFile(configPath, "utf8"), foreign);
});

test("adds a marked Codex project block without replacing existing TOML", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-codex-"));
  const configPath = path.join(root, ".codex", "config.toml");
  const system = createSystem({ cwd: root, home: root, platform: "darwin" });
  await system.writeFileAtomic(configPath, "model = \"gpt-5\"\n", 0o644);
  await chmod(configPath, 0o644);

  const options = {
    name: "shared-memory",
    projectDir: root,
    scope: "project",
    url: "http://127.0.0.1:9050/mcp",
  };
  assert.equal((await inspectMcp(system, "codex", options)).status, "absent");
  const result = await installMcp(system, "codex", options);

  assert.equal(result.created, true);
  const content = await readFile(configPath, "utf8");
  assert.match(content, /model = "gpt-5"/);
  assert.match(content, /Managed|@shopapps\/agent-memory/);
  assert.match(content, /http:\/\/127\.0\.0\.1:9050\/mcp/);
  assert.equal((await inspectMcp(system, "codex", options)).status, "matching");
  assert.equal((await stat(configPath)).mode & 0o777, 0o644);
});

test("updates a legacy Codex project MCP marker without adding a second block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-codex-brand-"));
  const configPath = path.join(root, ".codex", "config.toml");
  const system = createSystem({ cwd: root, home: root, platform: "darwin" });
  await system.writeFileAtomic(
    configPath,
    [
      "model = \"gpt-5\"",
      "# >>> @umony/agent-memory shared-memory >>>",
      "[mcp_servers.shared-memory]",
      "url = \"http://127.0.0.1:9050/mcp\"",
      "# <<< @umony/agent-memory shared-memory <<<",
      "",
    ].join("\n"),
  );
  const options = {
    name: "shared-memory",
    projectDir: root,
    scope: "project",
    url: "http://127.0.0.1:9050/mcp",
  };

  const result = await installMcp(system, "codex", options);
  const updated = await readFile(configPath, "utf8");

  assert.equal(result.created, false);
  assert.match(updated, /@shopapps\/agent-memory shared-memory/);
  assert.doesNotMatch(updated, /@umony\/agent-memory shared-memory/);
  assert.equal((updated.match(/mcp_servers\.shared-memory/g) ?? []).length, 1);
});

test("finds a foreign Codex project MCP section before another section", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-codex-conflict-"));
  const configPath = path.join(root, ".codex", "config.toml");
  const system = createSystem({ cwd: root, home: root, platform: "darwin" });
  await system.writeFileAtomic(
    configPath,
    [
      "[mcp_servers.shared-memory]",
      "url = \"http://127.0.0.1:9999/mcp\"",
      "",
      "[features]",
      "example = true",
      "",
    ].join("\n"),
  );

  const result = await inspectMcp(system, "codex", {
    name: "shared-memory",
    projectDir: root,
    scope: "project",
    url: "http://127.0.0.1:9050/mcp",
  });

  assert.equal(result.status, "conflict");
  assert.equal(result.url, "http://127.0.0.1:9999/mcp");
});

test("uses exact native user MCP command argument arrays", async () => {
  const calls = [];
  const configured = new Map();
  const system = createSystem({
    cwd: "/tmp/project",
    env: {},
    home: "/tmp/home",
    platform: "darwin",
    run: async (command, args) => {
      calls.push([command, args]);
      if (args[1] === "get") {
        if (!configured.has(command)) {
          return { code: 1, stderr: "not found", stdout: "" };
        }
        const url = configured.get(command);
        return command === "codex"
          ? { code: 0, stderr: "", stdout: JSON.stringify({ transport: { url } }) }
          : { code: 0, stderr: "", stdout: `URL: ${url}\n` };
      }
      if (args[1] === "add") {
        configured.set(command, "http://127.0.0.1:9050/mcp");
      }
      return { code: 0, stderr: "", stdout: "" };
    },
  });
  const options = {
    name: "shared-memory",
    projectDir: "/tmp/project",
    scope: "user",
    url: "http://127.0.0.1:9050/mcp",
  };

  await installMcp(system, "codex", options);
  await installMcp(system, "claude", options);

  assert.deepEqual(calls[1], [
    "codex",
    ["mcp", "add", "shared-memory", "--url", "http://127.0.0.1:9050/mcp"],
  ]);
  assert.deepEqual(calls[3], [
    "claude",
    [
      "mcp",
      "add",
      "--transport",
      "http",
      "--scope",
      "user",
      "shared-memory",
      "http://127.0.0.1:9050/mcp",
    ],
  ]);
});

test("treats a Claude MCP entry from another scope as absent", async () => {
  const calls = [];
  const system = createSystem({
    cwd: "/tmp/project",
    home: "/tmp/home",
    platform: "darwin",
    run: async (command, args, options) => {
      calls.push({ args, command, cwd: options.cwd });
      return {
        code: 0,
        stderr: "",
        stdout: "Scope: Project\nURL: http://127.0.0.1:9050/mcp\n",
      };
    },
  });

  const result = await inspectMcp(system, "claude", {
    name: "shared-memory",
    projectDir: "/tmp/project",
    scope: "user",
    url: "http://127.0.0.1:9050/mcp",
  });

  assert.equal(result.status, "absent");
  assert.equal(calls[0].cwd, "/tmp/home");
});
