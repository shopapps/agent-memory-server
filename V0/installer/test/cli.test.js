import assert from "node:assert/strict";
import test from "node:test";

import { resolveGuidedOptions } from "../src/cli.js";

test("rules update keeps saved scope and agents when flags are omitted", async () => {
  const options = {
    agents: null,
    nonInteractive: false,
    projectDir: null,
    scope: null,
  };
  const system = {
    input: { isTTY: true },
    output: { isTTY: true },
  };
  const prompter = {
    confirm() {
      throw new Error("should not prompt");
    },
    select() {
      throw new Error("should not prompt");
    },
  };

  await resolveGuidedOptions(
    "rules-update",
    options,
    system,
    prompter,
    true,
    true,
  );

  assert.equal(options.scope, null);
  assert.equal(options.agents, null);
});

test("rules uninstall never prompts for or detects agents", async () => {
  const options = {
    agents: null,
    nonInteractive: false,
    projectDir: null,
    scope: null,
  };
  const system = {
    env: {},
    input: { isTTY: true },
    output: { isTTY: true },
    run() {
      throw new Error("should not detect agents");
    },
  };
  const prompter = {
    confirm() {
      throw new Error("should not prompt");
    },
    select() {
      throw new Error("should not prompt");
    },
  };

  await resolveGuidedOptions(
    "rules-uninstall",
    options,
    system,
    prompter,
    false,
    false,
  );

  assert.equal(options.agents, null);
  assert.equal(options.scope, null);
});

for (const command of [
  "docker:install",
  "install",
  "rules-install",
  "rules-uninstall",
  "rules-update",
]) {
  test(`${command} treats --project-dir as project scope`, async () => {
    const options = {
      agents: ["codex"],
      nonInteractive: true,
      projectDir: "/tmp/wanted-project",
      scope: null,
    };
    const system = {
      env: {},
      input: { isTTY: false },
      output: { isTTY: false },
    };

    await resolveGuidedOptions(
      command,
      options,
      system,
      { confirm() {}, select() {} },
      false,
      command === "rules-update",
    );

    assert.equal(options.scope, "project");
  });
}
