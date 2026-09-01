import assert from "node:assert/strict";
import { chmod, mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  inspectRulesFile,
  removeRulesFile,
  renderRulesBlock,
  rollbackRulesFile,
  rulesTargetPaths,
  upsertRulesFile,
} from "../src/rules.js";
import { createSystem } from "../src/system.js";

const RULES_BODY = [
  "## Shared memory",
  "",
  "Before project work, use the `shared-memory` skill.",
  "{{PROJECT_SCOPE}}",
  "",
].join("\n");

test("chooses active global and project instruction files", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-paths-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const codexHome = path.join(root, "codex-home");
  const claudeHome = path.join(root, "claude-home");
  const system = createSystem({
    cwd: project,
    env: { CLAUDE_CONFIG_DIR: claudeHome, CODEX_HOME: codexHome },
    home,
  });
  await system.mkdir(project);
  await system.writeFileAtomic(path.join(codexHome, "AGENTS.override.md"), "# Override\n");
  await system.writeFileAtomic(path.join(project, ".claude", "CLAUDE.md"), "# Claude\n");

  assert.deepEqual(
    await rulesTargetPaths(system, "codex", "user", project),
    [path.join(codexHome, "AGENTS.override.md")],
  );
  assert.deepEqual(
    await rulesTargetPaths(system, "claude", "user", project),
    [path.join(claudeHome, "CLAUDE.md")],
  );
  assert.deepEqual(
    await rulesTargetPaths(system, "codex", "project", project),
    [path.join(project, "AGENTS.md")],
  );
  assert.deepEqual(
    await rulesTargetPaths(system, "claude", "project", project),
    [path.join(project, ".claude", "CLAUDE.md")],
  );
});

test("appends and updates only the managed block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-update-"));
  const target = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  const prefix = "\ufeff# My rules\r\n\r\nKeep this text.\r\n";
  await system.writeFileAtomic(target, prefix, 0o640);
  await chmod(target, 0o640);

  const first = await upsertRulesFile(system, target, RULES_BODY, {
    namespace: "umony/acr",
    scope: "project",
  });
  const installed = await readFile(target, "utf8");
  assert.equal(first.changed, true);
  assert.equal(installed.startsWith(prefix), true);
  assert.match(installed, /Use `umony\/acr` as the project ID/);
  assert.equal((await stat(target)).mode & 0o777, 0o640);

  const before = "\ufeff# My rules\r\n\r\nKeep this text.\r\n\r\n";
  const oldBlock = renderRulesBlock(RULES_BODY, {
    newline: "\r\n",
    namespace: "old/project",
    scope: "project",
  });
  const suffix = "\r\n\r\n## Tail\r\nLeave this too.";
  await system.writeFileAtomic(target, before + oldBlock + suffix, 0o640);

  await upsertRulesFile(system, target, RULES_BODY, {
    namespace: "umony/console",
    scope: "project",
  });
  const updated = await readFile(target, "utf8");
  assert.equal(updated.startsWith(before), true);
  assert.equal(updated.endsWith(suffix), true);
  assert.match(updated, /Use `umony\/console` as the project ID/);
  assert.doesNotMatch(updated, /old\/project/);

  const repeated = await upsertRulesFile(system, target, RULES_BODY, {
    namespace: "umony/console",
    scope: "project",
  });
  assert.equal(repeated.changed, false);
  assert.equal(await readFile(target, "utf8"), updated);
});

test("updates one legacy rules block to Shopapps markers", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-brand-"));
  const target = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  const legacy = [
    "# Keep this",
    "",
    "<!-- >>> @umony/agent-memory shared-memory rules >>> -->",
    "## Shared memory",
    "",
    "Old rule text.",
    "<!-- <<< @umony/agent-memory shared-memory rules <<< -->",
    "",
  ].join("\n");
  await system.writeFileAtomic(target, legacy);

  const result = await upsertRulesFile(system, target, RULES_BODY, {
    namespace: "shopapps/acr",
    scope: "project",
  });
  const updated = await readFile(target, "utf8");

  assert.equal(result.changed, true);
  assert.match(updated, /# Keep this/);
  assert.match(updated, /@shopapps\/agent-memory shared-memory rules/);
  assert.doesNotMatch(updated, /@umony\/agent-memory shared-memory rules/);
  assert.equal((updated.match(/shared-memory rules >>>/g) ?? []).length, 1);
});

test("stops on broken or duplicate markers without changing the file", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-conflict-"));
  const target = path.join(root, "CLAUDE.md");
  const system = createSystem({ cwd: root, home: root });
  const broken = [
    "# User text",
    "<!-- >>> @umony/agent-memory shared-memory rules >>> -->",
    "broken block",
    "<!-- >>> @umony/agent-memory shared-memory rules >>> -->",
    "",
  ].join("\n");
  await system.writeFileAtomic(target, broken);

  await assert.rejects(
    upsertRulesFile(system, target, RULES_BODY, { scope: "user" }),
    { code: "E_RULES_CONFLICT" },
  );
  assert.equal(await readFile(target, "utf8"), broken);
});

test("stops when marker text is indented or has trailing spaces", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-spaced-"));
  const target = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  const malformed = [
    "  <!-- >>> @umony/agent-memory shared-memory rules >>> -->",
    "old block",
    "<!-- <<< @umony/agent-memory shared-memory rules <<< -->  ",
    "",
  ].join("\n");
  await system.writeFileAtomic(target, malformed);

  await assert.rejects(
    upsertRulesFile(system, target, RULES_BODY, { scope: "user" }),
    { code: "E_RULES_CONFLICT" },
  );
  assert.equal(await readFile(target, "utf8"), malformed);
});

test("updates a symlink target without replacing the link", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-link-"));
  const realTarget = path.join(root, "shared.md");
  const linkedTarget = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  await system.writeFileAtomic(realTarget, "# Shared rules\n");
  await symlink(realTarget, linkedTarget);

  await upsertRulesFile(system, linkedTarget, RULES_BODY, { scope: "user" });

  assert.equal((await system.lstatSafe(linkedTarget)).isSymbolicLink(), true);
  assert.match(await readFile(realTarget, "utf8"), /shared-memory/);
});

test("allows a Claude file to link elsewhere inside the project", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-project-link-"));
  const nested = path.join(root, ".claude", "CLAUDE.md");
  const shared = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  await system.writeFileAtomic(shared, "# Shared project rules\n");
  await system.mkdir(path.dirname(nested));
  await symlink("../AGENTS.md", nested);

  await upsertRulesFile(system, nested, RULES_BODY, {
    allowedRoot: root,
    namespace: "project",
    scope: "project",
  });

  assert.equal((await system.lstatSafe(nested)).isSymbolicLink(), true);
  assert.match(await readFile(shared, "utf8"), /shared-memory/);
});

test("rollback safely stops when the file disappeared", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-rollback-"));
  const target = path.join(root, "AGENTS.md");
  const moved = path.join(root, "AGENTS.moved.md");
  const system = createSystem({ cwd: root, home: root });
  const result = await upsertRulesFile(system, target, RULES_BODY, {
    namespace: "project",
    scope: "project",
  });
  await system.move(target, moved);

  assert.equal(await rollbackRulesFile(system, result, path.join(root, "backups")), false);
  assert.match(await readFile(moved, "utf8"), /shared-memory/);
});

test("removes only the managed block", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-remove-"));
  const target = path.join(root, "AGENTS.md");
  const system = createSystem({ cwd: root, home: root });
  const before = "# Before\n\n";
  const after = "\n\n# After\n";
  const block = renderRulesBlock(RULES_BODY, {
    namespace: "umony/acr",
    scope: "project",
  });
  await system.writeFileAtomic(target, before + block + after);

  assert.equal((await inspectRulesFile(system, target, RULES_BODY, {
    namespace: "umony/acr",
    scope: "project",
  })).status, "matching");
  assert.equal((await removeRulesFile(system, target)).changed, true);
  assert.equal(await readFile(target, "utf8"), before + after);
});

test("owned placement restores every original trailing-newline form", async () => {
  for (const original of ["# Rules", "# Rules\n", "# Rules\n\n"]) {
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-memory-rule-restore-"));
    const target = path.join(root, "AGENTS.md");
    const system = createSystem({ cwd: root, home: root });
    await system.writeFileAtomic(target, original);
    const installed = await upsertRulesFile(system, target, RULES_BODY, {
      namespace: "umony/acr",
      scope: "project",
    });

    await removeRulesFile(system, target, {
      expectedActualPath: installed.actualPath,
      expectedBlockHash: installed.hash,
      placement: installed.placement,
    });

    assert.equal(await readFile(target, "utf8"), original);
  }
});
