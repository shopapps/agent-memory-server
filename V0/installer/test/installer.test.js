import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rename, stat, symlink } from "node:fs/promises";
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

test("new installs use the Shopapps support folder", async () => {
  const fixture = await createFixture();

  assert.equal(
    fixture.installer.paths().root,
    path.join(
      fixture.home,
      "Library",
      "Application Support",
      "Shopapps",
      "Agent Memory",
    ),
  );
});

test("legacy installs keep their existing support folder", async () => {
  const fixture = await createFixture();
  const legacyRoot = path.join(
    fixture.home,
    "Library",
    "Application Support",
    "Umony",
    "Agent Memory",
  );
  await fixture.system.writeFileAtomic(
    path.join(legacyRoot, "install.json"),
    `${JSON.stringify({ phase: "ready" })}\n`,
    0o600,
  );

  assert.equal(await fixture.installer.hasSavedInstall(), true);
  assert.equal(fixture.installer.paths().root, legacyRoot);
});

test("legacy Docker files without install state keep the legacy identity", async () => {
  const fixture = await createFixture({
    env: { AMS_REDIS_VOLUME: "wrong-volume" },
  });
  const legacyRoot = path.join(
    fixture.home,
    "Library",
    "Application Support",
    "Umony",
    "Agent Memory",
  );
  await fixture.system.writeFileAtomic(
    path.join(legacyRoot, "runtime.env"),
    "OPENAI_API_KEY=\"test-secret\"\n",
    0o600,
  );

  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });

  const state = JSON.parse(
    await readFile(path.join(legacyRoot, "install.json"), "utf8"),
  );
  assert.equal(state.composeProject, "umony-agent-memory");
  assert.equal(state.redisVolume, "umony-agent-memory-redis-data");
  const up = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("up"),
  );
  assert.equal(
    up.args[up.args.indexOf("--project-name") + 1],
    "umony-agent-memory",
  );
  assert.equal(
    up.options.env.AMS_REDIS_VOLUME,
    "umony-agent-memory-redis-data",
  );
});

test("two owned install roots stop before either is changed", async () => {
  const fixture = await createFixture();
  const currentRoot = path.join(
    fixture.home,
    "Library",
    "Application Support",
    "Shopapps",
    "Agent Memory",
  );
  const legacyRoot = path.join(
    fixture.home,
    "Library",
    "Application Support",
    "Umony",
    "Agent Memory",
  );
  for (const root of [currentRoot, legacyRoot]) {
    await fixture.system.writeFileAtomic(
      path.join(root, "install.json"),
      `${JSON.stringify({ phase: "ready" })}\n`,
      0o600,
    );
  }

  await assert.rejects(fixture.installer.hasSavedInstall(), {
    code: "E_INSTALL_PATH_CONFLICT",
  });
  assert.equal(
    JSON.parse(await readFile(path.join(currentRoot, "install.json"), "utf8")).phase,
    "ready",
  );
  assert.equal(
    JSON.parse(await readFile(path.join(legacyRoot, "install.json"), "utf8")).phase,
    "ready",
  );
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
  assert.equal(saved.composeProject, "shopapps-agent-memory");
  assert.equal(saved.redisVolume, "shopapps-agent-memory-redis-data");
  assert.deepEqual(Object.keys(saved.agents), ["codex", "claude"]);
  assert.equal((await stat(paths.runtimeEnv)).mode & 0o777, 0o600);
  assert.equal((await lstat(path.join(fixture.home, ".agents", "skills", "shared-memory"))).isSymbolicLink(), true);
  assert.equal((await lstat(path.join(fixture.home, ".claude", "skills", "shared-memory"))).isSymbolicLink(), true);
  assert.match(
    await readFile(path.join(fixture.home, ".codex", "AGENTS.md"), "utf8"),
    /@shopapps\/agent-memory shared-memory rules/,
  );
  assert.match(
    await readFile(path.join(fixture.home, ".claude", "CLAUDE.md"), "utf8"),
    /@shopapps\/agent-memory shared-memory rules/,
  );
  const rulesState = JSON.parse(await readFile(paths.rulesState, "utf8"));
  assert.equal(rulesState.installations[0].files.length, 2);
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
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.home, ".codex", "AGENTS.md")),
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
  const rulesPath = path.join(fixture.home, ".codex", "AGENTS.md");
  await fixture.system.writeFileAtomic(rulesPath, "# My own rules\n");
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
  assert.equal(await readFile(rulesPath, "utf8"), "# My own rules\n");
});

test("Docker reset rebuilds app containers and preserves Redis data", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;
  const paths = fixture.installer.paths();
  const runtimeBefore = await readFile(paths.runtimeEnv, "utf8");

  const result = await fixture.installer.run("docker:reset", { force: true });

  assert.equal(result.ok, true);
  assert.equal(result.dataPreserved, true);
  const build = fixture.calls.find(
    (call) => call.command === "docker" && call.args[0] === "build",
  );
  assert.ok(build);
  assert.deepEqual(build.args.slice(0, 6), [
    "build",
    "--pull",
    "--target",
    "standard",
    "--tag",
    "shopapps/agent-memory-server:local",
  ]);
  const down = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("down"),
  );
  assert.ok(down);
  assert.equal(down.args.includes("--remove-orphans"), true);
  assert.ok(fixture.calls.indexOf(build) < fixture.calls.indexOf(down));
  const appUp = fixture.calls.find(
    (call) => call.command === "docker"
      && call.args.includes("--force-recreate"),
  );
  assert.ok(appUp);
  assert.equal(appUp.args.includes("--no-deps"), true);
  assert.deepEqual(appUp.args.slice(-3), ["api", "mcp", "worker"]);
  assert.equal(
    fixture.calls.some(
      (call) => call.args.includes("--volumes")
        || call.args.includes("-v"),
    ),
    false,
  );
  assert.equal(
    appUp.options.env.AMS_IMAGE,
    "shopapps/agent-memory-server:local",
  );
  assert.equal(await readFile(paths.runtimeEnv, "utf8"), runtimeBefore);
  const state = JSON.parse(await readFile(paths.state, "utf8"));
  assert.equal(state.localSourceImage, "shopapps/agent-memory-server:local");
});

test("Docker install refreshes app containers without taking Redis down", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  await fixture.installer.run("docker:install", {});

  assert.equal(
    fixture.calls.some((call) => call.args.includes("down")),
    false,
  );
  assert.ok(fixture.calls.find((call) => call.args[0] === "build"));
  assert.ok(fixture.calls.find((call) => call.args.includes("migrate-memories")));
  const appUp = fixture.calls.find((call) => call.args.includes("--force-recreate"));
  assert.deepEqual(appUp.args.slice(-3), ["api", "mcp", "worker"]);
  assert.equal(appUp.args.includes("redis"), false);
});

test("Docker install performs first setup and ends on the local source image", async () => {
  const fixture = await createFixture();

  const result = await fixture.installer.run("docker:install", {
    agents: ["codex"],
    apiPort: 8000,
    dryRun: false,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });

  assert.equal(result.ok, true);
  assert.ok(fixture.calls.find((call) => call.args[0] === "build"));
  const state = JSON.parse(
    await readFile(fixture.installer.paths().state, "utf8"),
  );
  assert.equal(state.phase, "ready");
  assert.equal(state.localSourceImage, "shopapps/agent-memory-server:local");
});

test("Docker install applies supplied settings to an existing setup", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  await fixture.installer.run("docker:install", {
    agents: ["codex"],
    agentsSpecified: true,
    apiPort: 8010,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
    yes: true,
  });

  assert.ok(fixture.calls.find((call) => call.args.includes("pull")));
  const state = JSON.parse(
    await readFile(fixture.installer.paths().state, "utf8"),
  );
  assert.equal(state.apiPort, 8010);
  assert.equal(state.localSourceImage, "shopapps/agent-memory-server:local");
});

test("Docker up requires the local source image", async () => {
  const fixture = await createFixture({ missingLocalImage: true });
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  await assert.rejects(
    fixture.installer.run("docker:up", {}),
    { code: "E_LOCAL_IMAGE_MISSING" },
  );
  assert.equal(
    fixture.calls.some((call) => call.args.includes("up")),
    false,
  );
});

test("Docker reset asks before replacing app containers", async () => {
  const fixture = await createFixture({ confirmResponses: [true, false] });
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  const result = await fixture.installer.run("docker:reset", { force: false });

  assert.equal(result.cancelled, true);
  assert.equal(
    fixture.calls.some(
      (call) => call.command === "docker" && call.args[0] === "build",
    ),
    false,
  );
});

test("Docker restart app does not restart Redis", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  const result = await fixture.installer.run("docker:restart", {
    dockerTarget: "app",
  });

  assert.equal(result.ok, true);
  const restart = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("restart"),
  );
  assert.ok(restart);
  assert.deepEqual(restart.args.slice(-3), ["api", "mcp", "worker"]);
  assert.equal(restart.args.includes("redis"), false);
  const wait = fixture.calls.find(
    (call) => call.command === "docker"
      && call.args.includes("up")
      && call.args.includes("--wait")
      && !call.args.includes("--force-recreate"),
  );
  assert.ok(wait);
  assert.deepEqual(wait.args.slice(-3), ["api", "mcp", "worker"]);
});

test("Docker restart does not stop a running app when the local image is missing", async () => {
  const fixture = await createFixture({ missingLocalImage: true });
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  await assert.rejects(
    fixture.installer.run("docker:restart", { dockerTarget: "app" }),
    { code: "E_LOCAL_IMAGE_MISSING" },
  );
  assert.equal(
    fixture.calls.some((call) => call.args.includes("restart")),
    false,
  );
});

test("all local Docker dry runs leave Docker unchanged", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });

  for (const [command, options] of [
    ["docker:install", { dryRun: true }],
    ["docker:reset", { dryRun: true, force: false }],
    ["docker:up", { dryRun: true }],
    ["docker:restart", { dockerTarget: "app", dryRun: true }],
  ]) {
    fixture.calls.length = 0;
    fixture.infoMessages.length = 0;
    const result = await fixture.installer.run(command, options);
    assert.equal(result.dryRun, true);
    assert.ok(
      fixture.infoMessages.some((message) => message.includes("Keep Redis memory volume")),
    );
    assert.equal(
      fixture.calls.some(
        (call) => ["build", "down", "restart", "run", "up"].some(
          (action) => call.args.includes(action),
        ),
      ),
      false,
    );
  }
});

test("a failed local image build leaves running containers untouched", async () => {
  const fixture = await createFixture({ failLocalBuild: true });
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;

  await assert.rejects(
    fixture.installer.run("docker:reset", { force: true }),
    { code: "E_IMAGE_BUILD" },
  );
  assert.equal(
    fixture.calls.some((call) => call.args.includes("down")),
    false,
  );
});

test("normal start keeps using the saved local source image", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  await fixture.installer.run("docker:install", {});
  fixture.calls.length = 0;

  await fixture.installer.run("start", {});

  const up = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("up"),
  );
  assert.equal(up.options.env.AMS_IMAGE, "shopapps/agent-memory-server:local");
});

test("an older install keeps its Docker project, volume, and local image", async () => {
  const fixture = await createFixture({
    env: { AMS_REDIS_VOLUME: "wrong-volume" },
  });
  const legacyRoot = path.join(
    fixture.home,
    "Library",
    "Application Support",
    "Umony",
    "Agent Memory",
  );
  await fixture.system.writeFileAtomic(
    path.join(legacyRoot, "install.json"),
    `${JSON.stringify({
      apiPort: 8000,
      composeProject: "umony-agent-memory",
      localSourceImage: "umony/agent-memory-server:local",
      phase: "ready",
    })}\n`,
    0o600,
  );

  await fixture.installer.run("start", {});

  const volumeCheck = fixture.calls.find(
    (call) => call.command === "docker" && call.args[0] === "volume",
  );
  assert.deepEqual(volumeCheck.args, [
    "volume",
    "inspect",
    "umony-agent-memory-redis-data",
  ]);
  const up = fixture.calls.find(
    (call) => call.command === "docker" && call.args.includes("up"),
  );
  assert.equal(
    up.args[up.args.indexOf("--project-name") + 1],
    "umony-agent-memory",
  );
  assert.equal(up.options.env.AMS_IMAGE, "umony/agent-memory-server:local");
  assert.equal(
    up.options.env.AMS_REDIS_VOLUME,
    "umony-agent-memory-redis-data",
  );
});

test("a missing saved memory volume stops before Docker is changed", async () => {
  const controls = {};
  const fixture = await createFixture(controls);
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  fixture.calls.length = 0;
  controls.missingMemoryVolume = true;

  await assert.rejects(fixture.installer.run("start", {}), {
    code: "E_MEMORY_VOLUME_MISSING",
  });
  assert.equal(
    fixture.calls.some((call) => call.args.includes("up")),
    false,
  );
});

test("rules-only install updates instruction files without touching Docker, MCP, or Skills", async () => {
  const fixture = await createFixture();
  const result = await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    dryRun: false,
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal(result.ok, true);
  assert.equal(fixture.calls.length, 0);
  assert.match(
    await readFile(path.join(fixture.project, "AGENTS.md"), "utf8"),
    /Use `umony\/acr` as the project ID/,
  );
  assert.match(
    await readFile(path.join(fixture.project, "CLAUDE.md"), "utf8"),
    /Use `umony\/acr` as the project ID/,
  );
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.project, ".agents", "skills", "shared-memory")),
    null,
  );
  const rulesState = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(rulesState.installations.length, 1);
  assert.equal(rulesState.installations[0].namespace, "umony/acr");
});

test("rules-only dry run changes no files or saved rules state", async () => {
  const fixture = await createFixture();
  const result = await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    dryRun: true,
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal(result.dryRun, true);
  assert.equal(fixture.calls.length, 0);
  assert.equal(await fixture.system.lstatSafe(path.join(fixture.project, "AGENTS.md")), null);
  assert.equal(await fixture.system.lstatSafe(path.join(fixture.project, "CLAUDE.md")), null);
  assert.equal(await fixture.system.lstatSafe(fixture.installer.paths().rulesState), null);
});

test("rules-only uninstall restores the original files without touching Docker", async () => {
  const fixture = await createFixture();
  const target = path.join(fixture.project, "AGENTS.md");
  await fixture.system.writeFileAtomic(target, "# My project rules\n");
  await fixture.installer.run("rules-install", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  const result = await fixture.installer.run("rules-uninstall", {
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(target, "utf8"), "# My project rules\n");
  assert.equal(fixture.calls.length, 0);
  const registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(registry.installations.length, 0);
});

test("rules-only uninstall removes a rules file the installer created", async () => {
  const fixture = await createFixture();
  const target = path.join(fixture.project, "AGENTS.md");
  await fixture.installer.run("rules-install", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  await fixture.installer.run("rules-uninstall", {
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal(await fixture.system.lstatSafe(target), null);
});

test("rules-only uninstall keeps a user-owned empty rules file", async () => {
  const fixture = await createFixture();
  const target = path.join(fixture.project, "AGENTS.md");
  await fixture.system.writeFileAtomic(target, "");
  await fixture.installer.run("rules-install", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  await fixture.installer.run("rules-uninstall", {
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal((await fixture.system.lstatSafe(target)).isFile(), true);
  assert.equal(await readFile(target, "utf8"), "");
});

test("rules-only uninstall rejects an agent filter", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  await assert.rejects(
    fixture.installer.run("rules-uninstall", {
      agents: ["codex"],
      projectDir: fixture.project,
      scope: "project",
    }),
    { code: "E_BAD_OPTION" },
  );

  assert.match(
    await readFile(path.join(fixture.project, "AGENTS.md"), "utf8"),
    /shared-memory rules/,
  );
  assert.match(
    await readFile(path.join(fixture.project, "CLAUDE.md"), "utf8"),
    /shared-memory rules/,
  );

  await assert.rejects(
    fixture.installer.run("rules-uninstall", {
      agents: null,
      agentsSpecified: true,
      projectDir: fixture.project,
      scope: "project",
    }),
    { code: "E_BAD_OPTION" },
  );
});

test("a linked and real project path share one rules setup", async () => {
  const fixture = await createFixture();
  const realProject = path.join(path.dirname(fixture.project), "real-lifecycle-project");
  const linkedProject = path.join(path.dirname(fixture.project), "linked-lifecycle-project");
  const target = path.join(realProject, "AGENTS.md");
  await fixture.system.mkdir(realProject);
  await fixture.system.writeFileAtomic(target, "# My rules\n");
  await symlink(realProject, linkedProject, "dir");

  await fixture.installer.run("rules-install", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: linkedProject,
    scope: "project",
  });
  await fixture.installer.run("rules-update", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: realProject,
    scope: "project",
  });

  let registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(registry.installations.length, 1);
  assert.equal(
    registry.installations[0].projectDir,
    await fixture.system.realpath(realProject),
  );

  await fixture.installer.run("rules-uninstall", {
    projectDir: realProject,
    scope: "project",
  });

  assert.equal(await readFile(target, "utf8"), "# My rules\n");
  registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(registry.installations.length, 0);
});

test("rules update for another project derives a new namespace", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });
  const consoleProject = path.join(path.dirname(fixture.project), "umony-console");
  await fixture.system.mkdir(consoleProject);

  await fixture.installer.run("rules-update", {
    agents: ["codex"],
    projectDir: consoleProject,
    scope: "project",
  });

  const content = await readFile(path.join(consoleProject, "AGENTS.md"), "utf8");
  assert.match(content, /Use `umony-console` as the project ID/);
  assert.doesNotMatch(content, /umony\/acr/);
});

test("updating one agent keeps the other agent rules tracked for uninstall", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex", "claude"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  await fixture.installer.run("rules-update", {
    agents: ["codex"],
    projectDir: fixture.project,
    scope: "user",
  });

  const registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.deepEqual(registry.installations[0].agents, ["claude", "codex"]);
  assert.equal(registry.installations[0].files.length, 2);

  await fixture.installer.run("uninstall", {});
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.home, ".codex", "AGENTS.md")),
    null,
  );
  assert.equal(
    await fixture.system.lstatSafe(path.join(fixture.home, ".claude", "CLAUDE.md")),
    null,
  );
});

test("a new namespace must update every saved agent", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    namespace: "old/name",
    projectDir: fixture.project,
    scope: "project",
  });
  const codexPath = path.join(fixture.project, "AGENTS.md");
  const claudePath = path.join(fixture.project, "CLAUDE.md");
  const beforeCodex = await readFile(codexPath, "utf8");
  const beforeClaude = await readFile(claudePath, "utf8");

  await assert.rejects(
    fixture.installer.run("rules-update", {
      agents: ["codex"],
      namespace: "new/name",
      projectDir: fixture.project,
      scope: "project",
    }),
    { code: "E_RECONFIGURE" },
  );

  assert.equal(await readFile(codexPath, "utf8"), beforeCodex);
  assert.equal(await readFile(claudePath, "utf8"), beforeClaude);
  const registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(registry.installations[0].namespace, "old/name");
});

test("shared rule files are deduplicated through a linked project path", async () => {
  const fixture = await createFixture();
  const realProject = path.join(path.dirname(fixture.project), "real-project");
  const linkedProject = path.join(path.dirname(fixture.project), "linked-project");
  await fixture.system.mkdir(realProject);
  await fixture.system.writeFileAtomic(path.join(realProject, "AGENTS.md"), "# Shared\n");
  await symlink("AGENTS.md", path.join(realProject, "CLAUDE.md"));
  await symlink(realProject, linkedProject, "dir");

  await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    namespace: "shared/project",
    projectDir: linkedProject,
    scope: "project",
  });

  const registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(registry.installations[0].files.length, 1);
  assert.deepEqual(registry.installations[0].files[0].agents, ["claude", "codex"]);
  const content = await readFile(path.join(realProject, "AGENTS.md"), "utf8");
  assert.equal(
    (content.match(/shared-memory rules/g) ?? []).length,
    2,
  );
});

test("doctor spots one agent leaving a shared rule file", async () => {
  const fixture = await createFixture();
  const agentsPath = path.join(fixture.project, "AGENTS.md");
  const claudePath = path.join(fixture.project, "CLAUDE.md");
  await fixture.system.writeFileAtomic(agentsPath, "# Shared\n");
  await symlink("AGENTS.md", claudePath);
  await fixture.installer.run("rules-install", {
    agents: ["codex", "claude"],
    namespace: "shared/project",
    projectDir: fixture.project,
    scope: "project",
  });
  await rename(claudePath, path.join(fixture.project, "CLAUDE.old-link.md"));
  await fixture.system.writeFileAtomic(claudePath, "# Claude now uses this file\n");

  const result = await fixture.installer.run("doctor", {});
  const claudeCheck = result.checks.find((check) => check.name.startsWith("claude rules"));

  assert.equal(claudeCheck.ok, false);
  assert.match(claudeCheck.detail, /Another instruction file is now active/);
});

test("uninstall preserves a managed block that was edited by hand", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  const target = path.join(fixture.home, ".codex", "AGENTS.md");
  const edited = (await readFile(target, "utf8")).replace(
    "Before project work",
    "Before every project task",
  );
  await fixture.system.writeFileAtomic(target, edited);

  const result = await fixture.installer.run("uninstall", {});

  assert.equal(result.warnings.some((warning) => warning.includes("were preserved")), true);
  assert.equal(await readFile(target, "utf8"), edited);
});

test("rules update moves the managed block to a new active Codex override", async () => {
  const fixture = await createFixture();
  await fixture.installer.run("rules-install", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });
  const base = path.join(fixture.project, "AGENTS.md");
  const override = path.join(fixture.project, "AGENTS.override.md");
  await fixture.system.writeFileAtomic(override, "# Temporary override\n");

  await fixture.installer.run("rules-update", {
    agents: ["codex"],
    namespace: "umony/acr",
    projectDir: fixture.project,
    scope: "project",
  });

  assert.equal(await fixture.system.lstatSafe(base), null);
  assert.match(await readFile(override, "utf8"), /shared-memory rules/);
  const registry = JSON.parse(
    await readFile(fixture.installer.paths().rulesState, "utf8"),
  );
  assert.equal(
    registry.installations[0].files[0].target,
    await fixture.system.realpath(override),
  );
});

test("uninstall preserves rules when an instruction symlink was retargeted", async () => {
  const fixture = await createFixture();
  const codexDir = path.join(fixture.home, ".codex");
  const target = path.join(codexDir, "AGENTS.md");
  const first = path.join(codexDir, "first.md");
  const second = path.join(codexDir, "second.md");
  await fixture.system.writeFileAtomic(first, "# First\n");
  await fixture.system.writeFileAtomic(second, "# Second\n");
  await symlink("first.md", target);
  await fixture.installer.run("install", {
    agents: ["codex"],
    apiPort: 8000,
    mcpPort: 9050,
    projectDir: fixture.project,
    scope: "user",
  });
  await rename(target, path.join(codexDir, "AGENTS.old-link"));
  await symlink("second.md", target);

  const result = await fixture.installer.run("uninstall", {});

  assert.equal(result.warnings.some((warning) => warning.includes("were preserved")), true);
  assert.match(await readFile(first, "utf8"), /shared-memory rules/);
  assert.equal(await readFile(second, "utf8"), "# Second\n");
});

test("a rules conflict stops a full install before Docker changes", async () => {
  const fixture = await createFixture();
  const rulesPath = path.join(fixture.home, ".codex", "AGENTS.md");
  const broken = "<!-- >>> @umony/agent-memory shared-memory rules >>> -->\n";
  await fixture.system.writeFileAtomic(rulesPath, broken);

  await assert.rejects(
    fixture.installer.run("install", {
      agents: ["codex"],
      apiPort: 8000,
      mcpPort: 9050,
      projectDir: fixture.project,
      scope: "user",
    }),
    { code: "E_RULES_CONFLICT" },
  );

  assert.equal(
    fixture.calls.some((call) => call.command === "docker"),
    false,
  );
  assert.equal(await readFile(rulesPath, "utf8"), broken);
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
    env: { OPENAI_API_KEY: "test-secret", ...(options.env ?? {}) },
    fetch: async () => ({ ok: true }),
    home,
    input: { isTTY: true },
    isPortAvailable: async () => true,
    now: () => new Date("2026-08-27T08:00:00.000Z"),
    output: { isTTY: true, write() {} },
    platform: "darwin",
    run: async (command, args, runOptions = {}) => {
      calls.push({ args, command, options: runOptions });
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
        && options.missingMemoryVolume
        && args[0] === "volume"
        && args[1] === "inspect"
      ) {
        return { code: 1, stderr: "missing", stdout: "" };
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
      if (
        command === "docker"
        && options.failLocalBuild
        && args[0] === "build"
      ) {
        return { code: 1, stderr: "build failed", stdout: "" };
      }
      if (
        command === "docker"
        && options.missingLocalImage
        && args[0] === "image"
        && args[1] === "inspect"
      ) {
        return { code: 1, stderr: "missing", stdout: "" };
      }
      return success();
    },
  });
  await system.mkdir(home);
  await system.mkdir(project);
  const confirmResponses = [...(options.confirmResponses ?? [])];
  const infoMessages = [];
  const ui = {
    confirm: async () => confirmResponses.shift() ?? true,
    info(message) {
      infoMessages.push(message);
    },
    warn() {},
  };
  const installer = new Installer({ packageRoot: PACKAGE_ROOT, system, ui });
  return { calls, home, infoMessages, installer, project, system };
}

function success(stdout = "") {
  return { code: 0, stderr: "", stdout };
}
