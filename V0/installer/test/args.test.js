import assert from "node:assert/strict";
import test from "node:test";

import { parseArgs } from "../src/args.js";

test("defaults to the guided install command", () => {
  const parsed = parseArgs([], "/tmp/project");
  assert.equal(parsed.command, "install");
  assert.equal(parsed.options.projectDir, null);
  assert.equal(parsed.options.apiPort, null);
  assert.equal(parsed.options.mcpPort, null);
});

test("parses agent, scope, lifecycle, and automation options", () => {
  const parsed = parseArgs([
    "update",
    "--agents",
    "codex,claude",
    "--scope",
    "project",
    "--project-dir",
    "/tmp/my project",
    "--api-port",
    "8010",
    "--mcp-port",
    "9060",
    "--non-interactive",
    "--yes",
    "--json",
  ]);

  assert.equal(parsed.command, "update");
  assert.deepEqual(parsed.options.agents, ["codex", "claude"]);
  assert.equal(parsed.options.scope, "project");
  assert.equal(parsed.options.projectDir, "/tmp/my project");
  assert.equal(parsed.options.apiPort, 8010);
  assert.equal(parsed.options.mcpPort, 9060);
  assert.equal(parsed.options.nonInteractive, true);
  assert.equal(parsed.options.yes, true);
  assert.equal(parsed.options.json, true);
});

test("rejects unknown agents and invalid ports", () => {
  assert.throws(() => parseArgs(["--agents", "cursor"]), { code: "E_BAD_AGENT" });
  assert.throws(() => parseArgs(["--api-port", "0"]), { code: "E_BAD_PORT" });
});

test("parses rules-only install, update, and uninstall commands", () => {
  const install = parseArgs([
    "rules",
    "install",
    "--agents",
    "all",
    "--scope",
    "project",
    "--project-dir",
    "/tmp/project",
    "--namespace",
    "umony/acr",
    "--yes",
  ]);
  const update = parseArgs(["rules", "update", "--agents", "codex"]);
  const uninstall = parseArgs(["rules", "uninstall"]);
  const uninstallAuto = parseArgs(["rules", "uninstall", "--agents", "auto"]);

  assert.equal(install.command, "rules-install");
  assert.deepEqual(install.options.agents, ["codex", "claude"]);
  assert.equal(install.options.namespace, "umony/acr");
  assert.equal(update.command, "rules-update");
  assert.equal(uninstall.command, "rules-uninstall");
  assert.equal(uninstallAuto.options.agents, null);
  assert.equal(uninstallAuto.options.agentsSpecified, true);
});

test("rejects a missing or unknown rules action", () => {
  assert.throws(() => parseArgs(["rules"]), { code: "E_BAD_COMMAND" });
  assert.throws(() => parseArgs(["rules", "remove"]), { code: "E_BAD_COMMAND" });
});

test("allows help for the rules command group", () => {
  const parsed = parseArgs(["rules", "--help"]);
  assert.equal(parsed.options.help, true);
});

test("parses the local Docker helper commands", () => {
  assert.equal(parseArgs(["docker:install"]).command, "docker:install");
  assert.equal(parseArgs(["docker:up"]).command, "docker:up");

  const restart = parseArgs(["docker:restart", "app"]);
  assert.equal(restart.command, "docker:restart");
  assert.equal(restart.options.dockerTarget, "app");

  const reset = parseArgs(["docker:reset", "--force"]);
  assert.equal(reset.command, "docker:reset");
  assert.equal(reset.options.force, true);
});

test("rejects a missing or unsupported Docker restart target", () => {
  assert.throws(() => parseArgs(["docker:restart"]), { code: "E_BAD_OPTION" });
  assert.throws(() => parseArgs(["docker:restart", "database"]), {
    code: "E_BAD_OPTION",
  });
});

test("allows Docker restart help without a target", () => {
  const parsed = parseArgs(["docker:restart", "--help"]);

  assert.equal(parsed.command, "docker:restart");
  assert.equal(parsed.options.dockerTarget, null);
  assert.equal(parsed.options.help, true);
});

test("reset uses --force rather than the install --yes flag", () => {
  assert.throws(() => parseArgs(["docker:reset", "--yes"]), {
    code: "E_BAD_OPTION",
  });
});

test("Docker lifecycle commands reject install-only flags", () => {
  assert.throws(() => parseArgs(["docker:up", "--api-port", "8010"]), {
    code: "E_BAD_OPTION",
  });
  assert.throws(
    () => parseArgs(["docker:restart", "app", "--agents", "codex"]),
    { code: "E_BAD_OPTION" },
  );
});
