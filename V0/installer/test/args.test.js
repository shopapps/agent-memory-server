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
