import path from "node:path";

import {
  detectAgents,
  inspectMcp,
  inspectSkill,
  installMcp,
  installSkill,
  moveOwnedSkill,
  removeOwnedMcp,
  skillTargetPath,
} from "./agents.js";
import { InstallerError } from "./errors.js";
import { configureWorkingMemory } from "./working-memory.js";
import {
  defaultProjectNamespace,
  inspectRulesFile,
  removeRulesFile,
  rollbackRulesFile,
  rulesTargetPaths,
  upsertRulesFile,
} from "./rules.js";

const CURRENT_PRODUCT = {
  composeProject: "shopapps-agent-memory",
  localImage: "shopapps/agent-memory-server:local",
  redisVolume: "shopapps-agent-memory-redis-data",
};
const LEGACY_PRODUCT = {
  composeProject: "umony-agent-memory",
  localImage: "umony/agent-memory-server:local",
  redisVolume: "umony-agent-memory-redis-data",
};
const LOCAL_SOURCE_IMAGES = new Set([
  CURRENT_PRODUCT.localImage,
  LEGACY_PRODUCT.localImage,
]);
const LOCAL_APP_SERVICES = ["api", "mcp", "worker"];

export class Installer {
  constructor({ system, packageRoot, ui }) {
    this.system = system;
    this.packageRoot = packageRoot;
    this.ui = ui;
    this.activePaths = null;
    this.pathsReady = null;
  }

  async run(command, options) {
    await this.prepareInstallRoot();
    switch (command) {
      case "install":
      case "update":
        return this.install(options, command);
      case "rules-install":
      case "rules-update":
        return this.installRulesOnly(options, command);
      case "rules-uninstall":
        return this.uninstallRulesOnly(options);
      case "working-memory-install":
      case "working-memory-update":
      case "working-memory-uninstall":
        return this.configureWorkingMemory(options, command.endsWith("uninstall"));
      case "status":
        return this.status();
      case "doctor":
        return this.doctor();
      case "start":
        return this.start();
      case "stop":
        return this.stop();
      case "logs":
        return this.logs(options);
      case "uninstall":
        return this.uninstall();
      case "docker:install":
        return this.installLocalDocker(options);
      case "docker:up":
        return this.startLocalDocker(options);
      case "docker:restart":
        return this.restartLocalDocker(options.dockerTarget, options);
      case "docker:reset":
        return this.resetLocalDocker(options);
      default:
        throw new InstallerError("E_BAD_COMMAND", `Unsupported command: ${command}`);
    }
  }

  async hasSavedInstall() {
    await this.prepareInstallRoot();
    const state = await this.readState(this.paths());
    return Boolean(state && state.phase !== "uninstalled");
  }

  async configureWorkingMemory(options, uninstall = false) {
    const result = await configureWorkingMemory({ system: this.system, packageRoot: this.packageRoot,
      paths: this.paths(), ui: this.ui, options,
      state: await this.readState(this.paths()), uninstall });
    if (result.changed && !uninstall) {
      await this.syncWorkingMemoryUserId();
      this.ui.info("To load the saved user ID in an existing Docker app, run ./ams docker:restart app.");
    }
    return result;
  }

  async syncWorkingMemoryUserId() {
    const paths = this.paths();
    const identityPath = path.join(paths.root, "working-memory-user.json");
    if (!(await this.system.lstatSafe(identityPath)) || !(await this.system.lstatSafe(paths.runtimeEnv))) return;
    const identity = JSON.parse(await this.system.readFile(identityPath, "utf8"));
    if (typeof identity.userId !== "string" || !identity.userId.trim()) return;
    const existing = await this.system.readFile(paths.runtimeEnv, "utf8");
    const updated = mergeEnv(existing, { WORKING_MEMORY_LOCAL_USER_ID: identity.userId });
    if (updated !== existing) await this.system.writeFileAtomic(paths.runtimeEnv, updated, 0o600);
  }

  async hasSavedRules() {
    await this.prepareInstallRoot();
    const registry = await this.readRulesRegistry(this.paths());
    return registry.installations.length > 0;
  }

  async install(options, command = "install") {
    const manifest = await this.loadManifest();
    const paths = this.paths();
    const rulesRegistry = await this.readRulesRegistry(paths);
    const savedState = await this.readState(paths);
    const existingState = savedState?.phase === "uninstalled" ? null : savedState;
    const identity = this.runtimeIdentity(savedState, manifest);
    const scope = options.scope ?? existingState?.scope ?? "user";
    let projectDir = path.resolve(
      options.projectDir ?? existingState?.projectDir ?? this.system.cwd,
    );

    if (existingState) {
      if (options.scope && options.scope !== existingState.scope) {
        throw new InstallerError(
          "E_RECONFIGURE",
          "The install scope cannot be changed during a repair or update.",
          "Run uninstall first, then install again with the new scope.",
        );
      }
    }

    projectDir = await this.canonicalRulesProjectDir(scope, projectDir);
    if (existingState && options.projectDir) {
      const existingProjectDir = await this.canonicalRulesProjectDir(
        existingState.scope,
        existingState.projectDir,
      );
      if (projectDir !== existingProjectDir) {
        throw new InstallerError(
          "E_RECONFIGURE",
          "The project directory cannot be changed during a repair or update.",
          "Run uninstall first, then install again from the new project.",
        );
      }
    }

    const detected = await detectAgents(this.system);
    const agents = await this.resolveAgents(options.agents, existingState, detected);
    const savedRules = this.findRulesInstallation(
      rulesRegistry,
      scope,
      projectDir,
    );
    const namespace = this.resolveRulesNamespace(
      scope,
      projectDir,
      options.namespace,
      savedRules,
    );
    this.assertRulesNamespaceSelection(savedRules, namespace, agents);
    const rulesPlan = await this.buildRulesPlan(
      agents,
      scope,
      projectDir,
      namespace,
      savedRules,
    );
    await this.preflightDocker();
    if (savedState) {
      await this.assertMemoryVolume(identity.redisVolume);
    }
    const apiPort = options.apiPort ?? existingState?.apiPort ?? 8000;
    const mcpPort = options.mcpPort ?? existingState?.mcpPort ?? 9050;
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

    if (!existingState) {
      await this.assertPorts(apiPort, mcpPort);
    }

    const clientOptions = {
      name: manifest.mcpName,
      projectDir,
      scope,
      url: mcpUrl,
    };
    await this.assertNoClientConflicts(agents, clientOptions, paths, existingState);

    const plan = {
      agents,
      apiUrl: `http://127.0.0.1:${apiPort}`,
      command,
      dockerProject: identity.composeProject,
      mcpUrl,
      namespace,
      ruleFiles: rulesPlan.files.map((file) => file.target),
      scope,
      serverVersion: manifest.serverVersion,
    };

    this.ui.info(`${command === "update" ? "Update" : "Install"} plan`);
    this.ui.info(`  Agents: ${agents.join(", ")}`);
    this.ui.info(`  Scope: ${scope}`);
    this.ui.info(`  API: ${plan.apiUrl}`);
    this.ui.info(`  MCP: ${mcpUrl}`);
    this.ui.info(`  Rules: ${rulesPlan.files.map((file) => file.target).join(", ")}`);
    if (namespace) {
      this.ui.info(`  Memory name: ${namespace}`);
    }

    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }

    if (!(await this.ui.confirm("Continue with this plan?", true))) {
      return { cancelled: true, changed: false, ok: true, plan };
    }

    const compose = this.composeCommand(paths, identity.composeProject);
    const composeEnv = this.composeEnvironment(identity);
    try {
      await this.stageManagedFiles(paths, manifest, {
        apiPort,
        composeProject: identity.composeProject,
        mcpPort,
        openaiApiKey: options.openaiApiKey,
        redisVolume: identity.redisVolume,
      });
      await this.runChecked(
        "docker",
        [...compose, "pull"],
        "E_IMAGE_PULL",
        "Docker image pull failed.",
        undefined,
        { env: composeEnv },
      );
      await this.runChecked(
        "docker",
        [...compose, "up", "--detach", "--wait", "--wait-timeout", "120", "redis"],
        "E_REDIS_START",
        "Redis 8 did not become healthy.",
        undefined,
        { env: composeEnv },
      );
      await this.runChecked(
        "docker",
        [...compose, "run", "--rm", "--no-deps", "api", "agent-memory", "migrate-memories"],
        "E_MIGRATION",
        "Memory migration failed.",
        undefined,
        { env: composeEnv },
      );
      await this.runChecked(
        "docker",
        [...compose, "up", "--detach", "--wait", "--wait-timeout", "180"],
        "E_STARTUP_TIMEOUT",
        "The Agent Memory containers did not become healthy.",
        undefined,
        { env: composeEnv },
      );
      await this.checkApi(apiPort);
    } catch (error) {
      if (!existingState) {
        try {
          const cleanup = await this.system.run("docker", [...compose, "down"], {
            env: composeEnv,
          });
          if (cleanup.code !== 0) {
            this.ui.warn("First-install cleanup failed. Redis data was still preserved.");
          }
        } catch {
          this.ui.warn("First-install cleanup failed. Redis data was still preserved.");
        }
      }
      throw error;
    }

    const savedAgents = structuredClone(existingState?.agents ?? {});
    for (const agent of agents) {
      savedAgents[agent] ??= {
        mcpCreated: false,
        skillCreated: false,
        skillPath: skillTargetPath(agent, scope, this.system.home, projectDir),
      };
    }
    const state = {
      agents: structuredClone(savedAgents),
      apiPort,
      composeProject: identity.composeProject,
      installedAt: existingState?.installedAt ?? this.system.now().toISOString(),
      installerVersion: manifest.installerVersion,
      mcpPort,
      mcpUrl,
      phase: "registering-clients",
      projectDir,
      redisVolume: identity.redisVolume,
      redisImage: manifest.redisImage,
      schemaVersion: 1,
      scope,
      serverImage: manifest.serverImage,
      serverVersion: manifest.serverVersion,
      updatedAt: this.system.now().toISOString(),
    };
    await this.writeState(paths, state);

    const created = [];
    let rulesResult = { files: [], operations: [] };
    try {
      for (const agent of agents) {
        const previousOwnership = existingState?.agents?.[agent];
        const target = skillTargetPath(agent, scope, this.system.home, projectDir);
        const skill = await installSkill(this.system, target, paths.canonicalSkill);
        if (skill.created) {
          created.push({ agent, kind: "skill", target });
        }
        const mcp = await installMcp(this.system, agent, clientOptions);
        if (mcp.created) {
          created.push({ agent, kind: "mcp" });
        }
        state.agents[agent] = {
          mcpCreated: Boolean(mcp.created || previousOwnership?.mcpCreated),
          skillCreated: Boolean(skill.created || previousOwnership?.skillCreated),
          skillPath: target,
        };
        await this.writeState(paths, state);
      }

      rulesResult = await this.applyRulesPlan(rulesPlan, paths.backups);
      const installation = {
        agents: [...new Set(rulesResult.files.flatMap((file) => file.agents))].sort(),
        files: rulesResult.files,
        key: this.rulesInstallationKey(scope, projectDir),
        namespace,
        projectDir,
        scope,
        updatedAt: this.system.now().toISOString(),
      };
      await this.writeRulesRegistry(
        paths,
        this.replaceRulesInstallation(rulesRegistry, installation),
      );
      await this.writeState(paths, state);
    } catch (error) {
      await this.rollbackRulesOperations(rulesResult.operations, paths.backups);
      try {
        await this.writeRulesRegistry(paths, rulesRegistry);
      } catch (registryError) {
        this.ui.warn(`Rules state rollback warning: ${registryError.message}`);
      }
      await this.rollbackClientChanges(created, clientOptions, paths);
      state.agents = savedAgents;
      state.phase = "client-registration-failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      await this.writeState(paths, state);
      if (!existingState) {
        await this.system.run("docker", [...compose, "stop"], { env: composeEnv });
      }
      throw error;
    }

    state.phase = "ready";
    state.updatedAt = this.system.now().toISOString();
    delete state.lastError;
    await this.writeState(paths, state);

    const providerConfigured = await this.hasOpenAiKey(paths);
    const workingMemory = options.workingMemory
      ? await this.configureWorkingMemory({ ...options, agents, scope, projectDir }) : null;
    if (!providerConfigured) {
      this.ui.warn("No OpenAI API key is configured. The runtime is ready, but model-backed memory features will fail until a key is added.");
    }

    return {
      agents,
      apiUrl: plan.apiUrl,
      changed: true,
      mcpUrl,
      namespace,
      ok: true,
      providerConfigured,
      scope,
      ruleFiles: rulesResult.files.map((file) => file.target),
      serverVersion: manifest.serverVersion,
      workingMemory,
    };
  }

  async installRulesOnly(options, command) {
    const paths = this.paths();
    const registry = await this.readRulesRegistry(paths);
    const savedState = await this.readState(paths);
    const existingState = savedState?.phase === "uninstalled" ? null : savedState;
    let scope;
    let projectDir;
    let savedRules = null;

    if (options.scope || options.projectDir) {
      scope = options.scope ?? "project";
      projectDir = path.resolve(options.projectDir ?? this.system.cwd);
    } else if (command === "rules-update" && existingState) {
      scope = existingState.scope;
      projectDir = path.resolve(existingState.projectDir);
    } else if (command === "rules-update" && registry.installations.length === 1) {
      [savedRules] = registry.installations;
      scope = savedRules.scope;
      projectDir = path.resolve(savedRules.projectDir);
    } else if (command === "rules-update" && registry.installations.length > 1) {
      throw new InstallerError(
        "E_RULES_SELECTION",
        "More than one shared-memory rules setup exists.",
        "Choose one with --scope and, for project scope, --project-dir.",
      );
    } else {
      scope = "user";
      projectDir = path.resolve(this.system.cwd);
      savedRules = this.findRulesInstallation(registry, scope, projectDir);
    }

    projectDir = await this.canonicalRulesProjectDir(scope, projectDir);
    savedRules ??= this.findRulesInstallation(registry, scope, projectDir);

    const runtimeProjectDir = existingState
      ? await this.canonicalRulesProjectDir(
          existingState.scope,
          existingState.projectDir,
        )
      : null;
    const runtimeMatches = existingState
      && existingState.scope === scope
      && runtimeProjectDir === projectDir;
    let agents = options.agents
      ?? savedRules?.agents
      ?? (runtimeMatches ? Object.keys(existingState.agents ?? {}) : []);
    if (agents.length === 0) {
      agents = await detectAgents(this.system);
    }
    if (agents.length === 0) {
      throw new InstallerError(
        "E_NO_CLIENT",
        "No supported agent was selected.",
        "Use --agents codex, --agents claude, or --agents all.",
      );
    }

    const namespace = this.resolveRulesNamespace(
      scope,
      projectDir,
      options.namespace,
      savedRules,
    );
    this.assertRulesNamespaceSelection(savedRules, namespace, agents);
    const rulesPlan = await this.buildRulesPlan(
      agents,
      scope,
      projectDir,
      namespace,
      savedRules,
    );
    const plan = {
      agents,
      command,
      namespace,
      projectDir,
      ruleFiles: rulesPlan.files.map((file) => file.target),
      scope,
    };

    this.ui.info(`${command === "rules-update" ? "Rules update" : "Rules install"} plan`);
    this.ui.info(`  Agents: ${agents.join(", ")}`);
    this.ui.info(`  Scope: ${scope}`);
    this.ui.info(`  Files: ${plan.ruleFiles.join(", ")}`);
    if (namespace) {
      this.ui.info(`  Memory name: ${namespace}`);
    }

    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    if (!(await this.ui.confirm("Continue with this plan?", true))) {
      return { cancelled: true, changed: false, ok: true, plan };
    }

    const result = await this.applyRulesPlan(rulesPlan, paths.backups);
    try {
      const installation = {
        agents: [...new Set(result.files.flatMap((file) => file.agents))].sort(),
        files: result.files,
        key: this.rulesInstallationKey(scope, projectDir),
        namespace,
        projectDir,
        scope,
        updatedAt: this.system.now().toISOString(),
      };
      await this.writeRulesRegistry(
        paths,
        this.replaceRulesInstallation(registry, installation),
      );
    } catch (error) {
      await this.rollbackRulesOperations(result.operations, paths.backups);
      throw error;
    }

    return {
      agents,
      changed: result.changed,
      namespace,
      ok: true,
      projectDir,
      ruleFiles: result.files.map((file) => file.target),
      scope,
    };
  }

  async status() {
    const paths = this.paths();
    const state = await this.readState(paths);
    if (!state || state.phase === "uninstalled") {
      return { changed: false, installed: false, ok: true };
    }

    const manifest = await this.loadManifest();
    const identity = this.runtimeIdentity(state, manifest);
    const compose = this.composeCommand(paths, identity.composeProject);
    const ps = await this.system.run("docker", [...compose, "ps", "--format", "json"], {
      env: this.composeEnvironment(identity),
    });
    const apiHealthy = await this.isApiHealthy(state.apiPort);
    return {
      apiHealthy,
      changed: false,
      containersAvailable: ps.code === 0,
      installed: true,
      ok: ps.code === 0 && apiHealthy && state.phase === "ready",
      phase: state.phase,
      state,
    };
  }

  async uninstallRulesOnly(options) {
    if (options.agentsSpecified || options.agents?.length > 0) {
      throw new InstallerError(
        "E_BAD_OPTION",
        "--agents cannot be used with rules uninstall.",
        "Choose the saved setup with --scope and --project-dir.",
      );
    }
    const paths = this.paths();
    const registry = await this.readRulesRegistry(paths);
    let installation;

    if (options.scope || options.projectDir) {
      const scope = options.scope ?? "project";
      const projectDir = await this.canonicalRulesProjectDir(
        scope,
        options.projectDir ?? this.system.cwd,
      );
      installation = this.findRulesInstallation(registry, scope, projectDir);
    } else if (registry.installations.length === 1) {
      [installation] = registry.installations;
    } else if (registry.installations.length > 1) {
      throw new InstallerError(
        "E_RULES_SELECTION",
        "More than one shared-memory rules setup exists.",
        "Choose one with --scope and, for project scope, --project-dir.",
      );
    }

    if (!installation) {
      throw new InstallerError(
        "E_RULES_NOT_INSTALLED",
        "No matching shared-memory rules setup was found.",
      );
    }

    const plan = {
      projectDir: installation.projectDir,
      ruleFiles: installation.files.map((file) => file.target),
      scope: installation.scope,
    };
    this.ui.info("Rules uninstall plan");
    this.ui.info(`  Scope: ${installation.scope}`);
    this.ui.info(`  Files: ${plan.ruleFiles.join(", ")}`);

    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    if (!(await this.ui.confirm("Continue with this plan?", true))) {
      return { cancelled: true, changed: false, ok: true, plan };
    }

    const operations = [];
    try {
      for (const file of installation.files) {
        const removed = await removeRulesFile(this.system, file.target, {
          allowedRoot: installation.scope === "project"
            ? installation.projectDir
            : path.dirname(file.target),
          backupDir: paths.backups,
          created: file.created,
          expectedActualPath: file.actualPath,
          expectedBlockHash: file.hash,
          placement: file.placement,
        });
        if (removed.changed) {
          operations.push(removed);
        }
      }
      await this.writeRulesRegistry(paths, {
        installations: registry.installations.filter(
          (item) => item.key !== installation.key,
        ),
        schemaVersion: 1,
      });
    } catch (error) {
      await this.rollbackRulesOperations(operations, paths.backups);
      throw error;
    }

    return {
      changed: operations.length > 0,
      ok: true,
      projectDir: installation.projectDir,
      ruleFiles: plan.ruleFiles,
      scope: installation.scope,
    };
  }

  async doctor() {
    const paths = this.paths();
    const checks = [];
    checks.push({ name: "macOS", ok: this.system.platform === "darwin" });
    checks.push(await this.commandCheck("Docker CLI", "docker", ["--version"]));
    checks.push(await this.commandCheck("Docker Compose", "docker", ["compose", "version"]));
    checks.push(await this.commandCheck("Docker engine", "docker", ["info"]));

    const detected = await detectAgents(this.system);
    checks.push({ detail: detected.join(", ") || "none", name: "Agent clients", ok: detected.length > 0 });

    const state = await this.readState(paths);
    checks.push({ name: "Install state", ok: Boolean(state && state.phase === "ready") });
    if (state) {
      checks.push({ name: "REST health", ok: await this.isApiHealthy(state.apiPort) });
      for (const [agent, owned] of Object.entries(state.agents ?? {})) {
        try {
          const skill = await inspectSkill(this.system, owned.skillPath, paths.canonicalSkill);
          checks.push({ name: `${agent} Skill`, ok: skill.status === "matching" });
        } catch (error) {
          checks.push({ detail: error.message, name: `${agent} Skill`, ok: false });
        }
        try {
          const mcp = await inspectMcp(this.system, agent, {
            name: "shared-memory",
            projectDir: state.projectDir,
            scope: state.scope,
            url: state.mcpUrl,
          });
          checks.push({ name: `${agent} MCP`, ok: mcp.status === "matching" });
        } catch (error) {
          checks.push({ detail: error.message, name: `${agent} MCP`, ok: false });
        }
      }
    }

    const rulesRegistry = await this.readRulesRegistry(paths);
    const body = await this.loadRulesBody();
    for (const installation of rulesRegistry.installations) {
      for (const file of installation.files) {
        for (const agent of file.agents ?? []) {
          try {
            const activeTargets = await rulesTargetPaths(
              this.system,
              agent,
              installation.scope,
              installation.projectDir,
            );
            let activeRules = null;
            for (const target of activeTargets) {
              const allowedRoot = installation.scope === "project"
                ? installation.projectDir
                : path.dirname(target);
              const rules = await inspectRulesFile(this.system, target, body, {
                allowedRoot,
                namespace: installation.namespace,
                scope: installation.scope,
              });
              if (
                path.resolve(rules.actualPath)
                === path.resolve(file.actualPath)
              ) {
                activeRules = { rules, target };
                break;
              }
            }
            if (!activeRules) {
              checks.push({
                detail: "Another instruction file is now active. Run rules update.",
                name: `${agent} rules ${file.target}`,
                ok: false,
              });
              continue;
            }
            const unchangedBlock = activeRules.rules.blockHash === file.hash;
            checks.push({
              detail: !unchangedBlock
                ? "managed block changed"
                : activeRules.rules.status,
              name: `${agent} rules ${activeRules.target}`,
              ok: unchangedBlock && activeRules.rules.status === "matching",
            });
          } catch (error) {
            checks.push({
              detail: error.message,
              name: `${agent} rules ${file.target}`,
              ok: false,
            });
          }
        }
      }
    }

    // Capture is optional and may have been installed without the full runtime.
    const projectRoots = new Set([this.system.cwd, state?.projectDir].filter(Boolean));
    try {
      const root = await this.system.run("git", ["-C", this.system.cwd, "rev-parse", "--show-toplevel"]);
      if (root.code === 0 && path.isAbsolute(root.stdout.trim())) projectRoots.add(root.stdout.trim());
    } catch { /* The current folder need not be a Git repository. */ }
    let captureFound = false;
    let captureEnabled = false;
    for (const client of ["codex", "claude"]) {
      const folder = client === "codex" ? ".codex" : ".claude";
      const override = this.system.env[client === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
      const directories = new Map([[path.resolve(override || path.join(this.system.home, folder)), "user"]]);
      for (const root of projectRoots) directories.set(path.join(root, folder), "project");
      for (const [directory, scope] of directories) {
        const configPath = path.join(directory, "ams-working-memory.json");
        if (!(await this.system.lstatSafe(configPath))) continue;
        captureFound = true;
        const name = `${client} Working Memory (${scope})`;
        let config;
        try {
          config = JSON.parse(await this.system.readFile(configPath, "utf8"));
          if (config?.owner !== "@shopapps/agent-memory/working-memory" || config.client !== client) throw new Error();
          if (!config.enabled || this.system.env.AMS_WORKING_MEMORY_DISABLED === "1") {
            checks.push({ name, ok: true, detail: "Capture is off. Existing memories are kept." });
            continue;
          }
          captureEnabled = true;
          const hooksPath = path.join(directory, client === "codex" ? "hooks.json" : "settings.json");
          const hooks = JSON.parse(await this.system.readFile(hooksPath, "utf8")).hooks;
          const installed = typeof config.command === "string" && config.command.length > 0
            && ["SessionStart", "UserPromptSubmit", "Stop"].every((event) =>
              Array.isArray(hooks?.[event]) && hooks[event].some((entry) =>
                Array.isArray(entry.hooks) && entry.hooks.some((hook) => hook.command === config.command)));
          checks.push({ name: `${name} hooks`, ok: installed,
            detail: installed ? "All three capture hooks are registered." : "Hooks are missing. Run working-memory update for this client and scope." });
          const base = new URL(config.apiUrl);
          if (base.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(base.hostname)
            || base.username || base.password || base.search || base.hash
            || typeof config.userId !== "string" || !config.userId.trim()
            || (config.projectId !== null && config.projectId !== undefined && typeof config.projectId !== "string")) throw new Error();
        } catch {
          checks.push({ name, ok: false, detail: "Capture settings or hooks could not be read safely. Run working-memory update." });
          continue;
        }
        try {
          const url = new URL("/v1/working-memory-capture/sessions", config.apiUrl);
          url.searchParams.set("user_id", config.userId);
          if (config.projectId) url.searchParams.set("project_id", config.projectId);
          const headers = this.system.env.AMS_API_TOKEN ? { Authorization: `Bearer ${this.system.env.AMS_API_TOKEN}` } : {};
          const response = await this.system.fetch(url, { headers, redirect: "error", signal: AbortSignal.timeout(3000) });
          if (!response.ok) throw new Error();
          const data = await response.json();
          if (!Array.isArray(data.sessions)) throw new Error();
          const sessions = data.sessions.filter((session) => session.user_id === config.userId && session.client === client
            && (!config.projectId || session.project_id === config.projectId));
          if (!sessions.length) {
            checks.push({ name: `${name} activity`, ok: false, detail: "Hooks installed, but no recent events were received. Start a new agent session in a Git project and send one prompt." });
            continue;
          }
          if (sessions.some((session) => !session.counts)) {
            checks.push({ name: `${name} activity`, ok: false, detail: "Events exist, but this server does not report processing counts. Update the app to check saving." });
            continue;
          }
          const counts = Object.fromEntries(["captured", "checked", "awaiting_review", "pending_saves", "saved"].map((key) => [key,
            sessions.reduce((sum, session) => sum + (Number.isSafeInteger(session.counts[key]) && session.counts[key] >= 0 ? session.counts[key] : 0), 0)]));
          const failed = sessions.some((session) => typeof session.status === "string" && session.status.includes("failed"));
          const usageUnknown = sessions.some((session) => session.status?.startsWith("filter paused; usage unknown"));
          const allowanceReached = sessions.some((session) => session.status?.startsWith("filter paused; daily allowance reached"));
          const outcome = failed ? "Processing failed. Check the provider and use Filter now / retry."
            : usageUnknown ? "Filtering is paused because provider token usage is unknown. Check the provider before changing the allowance; already-checked facts may still save."
              : allowanceReached ? "Filtering is paused at the configured daily token allowance. After the next UTC day, use Filter now / retry, or adjust the allowance; already-checked facts may still save."
                : counts.pending_saves ? "Facts are waiting to save. Check that the worker is running."
                  : counts.awaiting_review ? "Facts need approval on the Working Memory page."
                    : counts.saved ? "Facts were saved. A fresh-session search still needs checking."
                      : "Events received; no lasting facts saved yet. Filtering may still be running or nothing qualified.";
          const times = ["last_received_at", "last_filtered_at", "last_saved_at"].map((key) => {
            const dates = sessions.map((session) => session[key]).filter((value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T/.test(value) && Number.isFinite(Date.parse(value)));
            const latest = dates.length ? new Date(Math.max(...dates.map(Date.parse))).toISOString() : "not yet";
            return `${key.replaceAll("_", " ")}: ${latest}`;
          });
          checks.push({ name: `${name} activity`, ok: !failed && !usageUnknown,
            detail: `${outcome} Recent sessions: captured ${counts.captured}, checked ${counts.checked}, saved ${counts.saved}, review ${counts.awaiting_review}, waiting ${counts.pending_saves}. ${times.join("; ")}.` });
        } catch {
          checks.push({ name: `${name} activity`, ok: false,
            detail: "The local capture API could not be reached or refused access. Start the app; check AMS_API_TOKEN if API authentication is enabled." });
        }
      }
    }
    if (!captureFound) checks.push({ name: "Working Memory", ok: true, detail: "Optional capture is not installed in the user or current project settings." });
    if (captureEnabled) this.ui.info('To check recall: in a NEW agent session in the same project, ask "Search long-term shared memory for a fact I saved. Give the matching memory ID. Do not answer from recent chat alone." This doctor check does not create a test memory.');

    return {
      changed: false,
      checks,
      ok: checks.every((check) => check.ok),
    };
  }

  async start() {
    const { manifest, paths, state } = await this.requireInstall();
    await this.preflightDocker();
    const identity = this.runtimeIdentity(state, manifest);
    await this.assertMemoryVolume(identity.redisVolume);
    const compose = this.composeCommand(paths, identity.composeProject);
    const localImage = this.savedLocalImage(state);
    await this.runChecked(
      "docker",
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "180"],
      "E_STARTUP_TIMEOUT",
      "The Agent Memory containers did not become healthy.",
      undefined,
      {
        env: localImage
          ? this.composeEnvironment(identity, { AMS_IMAGE: localImage })
          : this.composeEnvironment(identity),
      },
    );
    await this.checkApi(state.apiPort);
    return { changed: true, ok: true, status: "started" };
  }

  async stop() {
    const { manifest, paths, state } = await this.requireInstall();
    await this.preflightDocker();
    const identity = this.runtimeIdentity(state, manifest);
    const compose = this.composeCommand(paths, identity.composeProject);
    await this.runChecked(
      "docker",
      [...compose, "stop"],
      "E_DOCKER",
      "Docker could not stop the runtime.",
      undefined,
      { env: this.composeEnvironment(identity) },
    );
    return { changed: true, dataPreserved: true, ok: true, status: "stopped" };
  }

  async logs(options) {
    const { manifest, paths, state } = await this.requireInstall();
    await this.preflightDocker();
    const identity = this.runtimeIdentity(state, manifest);
    const compose = this.composeCommand(paths, identity.composeProject);
    const args = [...compose, "logs", "--tail", "200"];
    if (options.follow) {
      args.push("--follow");
    }
    const result = await this.system.run("docker", args, {
      env: this.composeEnvironment(identity),
      stdio: "inherit",
    });
    if (result.code !== 0) {
      throw new InstallerError("E_DOCKER", "Docker could not read the runtime logs.");
    }
    return { changed: false, ok: true };
  }

  async installLocalDocker(options) {
    const hasSavedInstall = await this.hasSavedInstall();
    const hasInstallSettings = Boolean(
      options.agentsSpecified
      || options.apiPort !== null && options.apiPort !== undefined
      || options.mcpPort !== null && options.mcpPort !== undefined
      || options.namespace
      || options.projectDir
      || options.scope
      || options.workingMemory,
    );
    if (!hasSavedInstall || hasInstallSettings) {
      const installed = await this.install({ ...options, workingMemory: false }, "install");
      if (installed.cancelled || installed.dryRun) {
        return installed;
      }
    }
    const context = await this.localDockerContext({ useCurrentImage: true });
    const plan = this.localDockerPlan("install", context);
    this.printLocalDockerPlan(plan);
    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    const workingMemory = options.workingMemory ? await this.configureWorkingMemory(options) : null;
    await this.buildLocalImage(context);
    await this.startLocalRedis(context);
    await this.migrateLocalMemories(context);
    await this.recreateLocalApp(context);
    await this.checkApi(context.state.apiPort);
    await this.markLocalSourceImage(context);
    return {
      changed: true,
      dataPreserved: true,
      localImage: context.image,
      ok: true,
      status: "Docker source install complete",
      workingMemory,
    };
  }

  async startLocalDocker(options) {
    const context = await this.localDockerContext();
    const plan = this.localDockerPlan("up", context);
    this.printLocalDockerPlan(plan);
    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    await this.assertLocalImage(context);
    await this.runChecked(
      "docker",
      [
        ...context.compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
      ],
      "E_STARTUP_TIMEOUT",
      "The local Agent Memory containers did not become healthy.",
      undefined,
      { env: context.env },
    );
    await this.checkApi(context.state.apiPort);
    await this.markLocalSourceImage(context);
    return {
      changed: true,
      dataPreserved: true,
      ok: true,
      status: "Docker runtime started",
    };
  }

  async restartLocalDocker(target, options) {
    if (target !== "app") {
      throw new InstallerError(
        "E_BAD_OPTION",
        `Unsupported Docker restart target: ${target ?? "missing"}`,
        "Use ./ams docker:restart app.",
      );
    }
    const context = await this.localDockerContext();
    const plan = this.localDockerPlan("restart", context);
    this.printLocalDockerPlan(plan);
    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    await this.assertLocalImage(context);
    await this.runChecked(
      "docker",
      [...context.compose, "restart", ...LOCAL_APP_SERVICES],
      "E_DOCKER",
      "The Agent Memory app containers could not be restarted.",
      undefined,
      { env: context.env },
    );
    await this.runChecked(
      "docker",
      [
        ...context.compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-deps",
        ...LOCAL_APP_SERVICES,
      ],
      "E_STARTUP_TIMEOUT",
      "The restarted Agent Memory app did not become healthy.",
      undefined,
      { env: context.env },
    );
    await this.checkApi(context.state.apiPort);
    await this.markLocalSourceImage(context);
    return {
      changed: true,
      dataPreserved: true,
      ok: true,
      status: "Docker app restarted",
    };
  }

  async resetLocalDocker(options) {
    const context = await this.localDockerContext({ useCurrentImage: true });
    const plan = {
      appServices: LOCAL_APP_SERVICES,
      dataPreserved: true,
      image: context.image,
      redisVolume: context.identity.redisVolume,
    };
    this.ui.info("Docker reset plan");
    this.ui.info("  Rebuild the current V0 source");
    this.ui.info("  Replace the managed containers and Docker network");
    this.ui.info(`  Keep Redis memory volume: ${plan.redisVolume}`);

    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }
    if (!options.force) {
      let confirmed;
      try {
        confirmed = await this.ui.confirm(
          "Continue? Your saved memories will be kept.",
          false,
        );
      } catch (error) {
        if (error?.code === "E_CONFIRM_REQUIRED") {
          throw new InstallerError(
            "E_CONFIRM_REQUIRED",
            "Docker reset needs confirmation.",
            "Run again with --force to skip only this question.",
          );
        }
        throw error;
      }
      if (!confirmed) {
        return { cancelled: true, changed: false, ok: true, plan };
      }
    }

    await this.buildLocalImage(context);
    await this.runChecked(
      "docker",
      [...context.compose, "down", "--remove-orphans"],
      "E_DOCKER",
      "The old Agent Memory containers could not be stopped.",
      undefined,
      { env: context.env },
    );
    await this.startLocalRedis(context);
    await this.migrateLocalMemories(context);
    await this.recreateLocalApp(context);
    await this.checkApi(context.state.apiPort);
    await this.markLocalSourceImage(context);
    return {
      changed: true,
      dataPreserved: true,
      localImage: context.image,
      ok: true,
      status: "Docker reset complete",
    };
  }

  async localDockerContext(options = {}) {
    const { manifest, paths, state } = await this.requireInstall();
    await this.preflightDocker();
    const identity = this.runtimeIdentity(state, manifest);
    await this.assertMemoryVolume(identity.redisVolume);
    for (const required of [paths.compose, paths.runtimeEnv]) {
      if (!(await this.system.lstatSafe(required))) {
        throw new InstallerError(
          "E_NOT_INSTALLED",
          "The managed Docker files are missing.",
          "Run ./ams install first.",
        );
      }
    }
    const sourceRoot = path.resolve(this.packageRoot, "..");
    if (!(await this.system.lstatSafe(path.join(sourceRoot, "Dockerfile")))) {
      throw new InstallerError(
        "E_SOURCE_MISSING",
        "The V0 Docker source is missing.",
        "Run this command from an agent-memory-server repository checkout.",
      );
    }
    const image = options.useCurrentImage
      ? CURRENT_PRODUCT.localImage
      : this.savedLocalImage(state) ?? CURRENT_PRODUCT.localImage;
    return {
      compose: this.composeCommand(paths, identity.composeProject),
      env: {
        ...this.composeEnvironment(identity),
        AMS_IMAGE: image,
      },
      identity,
      image,
      paths,
      sourceRoot,
      state,
    };
  }

  localDockerPlan(action, context) {
    return {
      action,
      appServices: LOCAL_APP_SERVICES,
      dataPreserved: true,
      image: context.image,
      redisVolume: context.identity.redisVolume,
    };
  }

  printLocalDockerPlan(plan) {
    const actions = {
      install: "Build this checkout and replace the app containers",
      restart: "Restart the app containers",
      up: "Start the local Docker stack",
    };
    this.ui.info("Local Docker plan");
    this.ui.info(`  Action: ${actions[plan.action]}`);
    this.ui.info(`  Image: ${plan.image}`);
    this.ui.info(`  App containers: ${plan.appServices.join(", ")}`);
    this.ui.info(`  Keep Redis memory volume: ${plan.redisVolume}`);
  }

  async markLocalSourceImage(context) {
    await this.writeState(context.paths, {
      ...context.state,
      localSourceImage: context.image,
      updatedAt: this.system.now().toISOString(),
    });
  }

  async assertLocalImage(context) {
    const image = await this.system.run(
      "docker",
      ["image", "inspect", context.image],
      { env: context.env },
    );
    if (image.code !== 0) {
      throw new InstallerError(
        "E_LOCAL_IMAGE_MISSING",
        "The local Agent Memory image has not been built.",
        "Run ./ams docker:install first.",
      );
    }
  }

  async buildLocalImage(context) {
    await this.syncWorkingMemoryUserId();
    this.ui.info(`Building ${context.image} from the current V0 source.`);
    await this.runChecked(
      "docker",
      [
        "build",
        "--pull",
        "--target",
        "standard",
        "--tag",
        context.image,
        context.sourceRoot,
      ],
      "E_IMAGE_BUILD",
      "The local Agent Memory image could not be built.",
      undefined,
      { env: context.env, stdio: "inherit" },
    );
  }

  async startLocalRedis(context) {
    await this.runChecked(
      "docker",
      [
        ...context.compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "120",
        "redis",
      ],
      "E_REDIS_START",
      "Redis 8 did not become healthy.",
      undefined,
      { env: context.env },
    );
  }

  async migrateLocalMemories(context) {
    await this.runChecked(
      "docker",
      [
        ...context.compose,
        "run",
        "--rm",
        "--no-deps",
        "api",
        "agent-memory",
        "migrate-memories",
      ],
      "E_MIGRATION",
      "Memory migration failed.",
      undefined,
      { env: context.env },
    );
  }

  async recreateLocalApp(context) {
    await this.runChecked(
      "docker",
      [
        ...context.compose,
        "up",
        "--detach",
        "--wait",
        "--wait-timeout",
        "180",
        "--no-deps",
        "--force-recreate",
        "--remove-orphans",
        ...LOCAL_APP_SERVICES,
      ],
      "E_STARTUP_TIMEOUT",
      "The Agent Memory app containers did not become healthy.",
      undefined,
      { env: context.env },
    );
  }

  async uninstall() {
    const { manifest, paths, state } = await this.requireInstall();
    const warnings = [];
    const workingMemory = await this.configureWorkingMemory({}, true);
    if (workingMemory.cancelled) return workingMemory;
    for (const [agent, owned] of Object.entries(state.agents ?? {})) {
      const clientOptions = {
        name: manifest.mcpName,
        projectDir: state.projectDir,
        scope: state.scope,
        url: state.mcpUrl,
      };

      if (owned.mcpCreated) {
        const inspection = await inspectMcp(this.system, agent, clientOptions);
        if (inspection.status === "matching") {
          await removeOwnedMcp(this.system, agent, clientOptions);
        } else {
          warnings.push(`${agent} MCP changed after install and was preserved.`);
        }
      }

      if (owned.skillCreated) {
        const inspection = await inspectSkill(this.system, owned.skillPath, paths.canonicalSkill);
        if (inspection.status === "matching") {
          await moveOwnedSkill(this.system, owned.skillPath, paths.backups);
        } else {
          warnings.push(`${agent} Skill changed after install and was preserved.`);
        }
      }
    }

    const rulesRegistry = await this.readRulesRegistry(paths);
    const rulesProjectDir = await this.canonicalRulesProjectDir(
      state.scope,
      state.projectDir,
    );
    const rulesInstallation = this.findRulesInstallation(
      rulesRegistry,
      state.scope,
      rulesProjectDir,
    );
    let rulesRemoved = Boolean(rulesInstallation);
    const removedRuleFiles = [];
    for (const file of rulesInstallation?.files ?? []) {
      try {
        const removed = await removeRulesFile(this.system, file.target, {
          allowedRoot: rulesInstallation.scope === "project"
            ? rulesInstallation.projectDir
            : path.dirname(file.target),
          backupDir: paths.backups,
          created: file.created,
          expectedActualPath: file.actualPath,
          expectedBlockHash: file.hash,
          placement: file.placement,
        });
        if (removed.changed) {
          removedRuleFiles.push(removed);
        }
      } catch (error) {
        rulesRemoved = false;
        warnings.push(`Shared-memory rules in ${file.target} were preserved: ${error.message}`);
        await this.rollbackRulesOperations(removedRuleFiles, paths.backups);
        break;
      }
    }
    if (rulesRemoved) {
      try {
        await this.writeRulesRegistry(paths, {
          installations: rulesRegistry.installations.filter(
            (item) => item.key !== rulesInstallation.key,
          ),
          schemaVersion: 1,
        });
      } catch (error) {
        await this.rollbackRulesOperations(removedRuleFiles, paths.backups);
        throw error;
      }
    }

    const identity = this.runtimeIdentity(state, manifest);
    const compose = this.composeCommand(paths, identity.composeProject);
    const down = await this.system.run("docker", [...compose, "down"], {
      env: this.composeEnvironment(identity),
    });
    if (down.code !== 0) {
      warnings.push("Docker could not remove the stopped containers. The Redis data volume was not touched.");
    }

    state.phase = "uninstalled";
    state.uninstalledAt = this.system.now().toISOString();
    await this.writeState(paths, state);
    return { changed: true, dataPreserved: true, ok: true, warnings };
  }

  resolveRulesNamespace(scope, projectDir, requested, savedRules) {
    if (scope === "user") {
      if (requested) {
        throw new InstallerError(
          "E_BAD_NAMESPACE",
          "A fixed namespace cannot be used by global rules.",
          "Use project scope, or leave --namespace out so each repository gets its own memory name.",
        );
      }
      return null;
    }
    return requested ?? savedRules?.namespace ?? defaultProjectNamespace(projectDir);
  }

  assertRulesNamespaceSelection(savedRules, namespace, agents) {
    if (!savedRules || savedRules.namespace === namespace) {
      return;
    }
    const selected = new Set(agents);
    const missing = savedRules.agents.filter((agent) => !selected.has(agent));
    if (missing.length > 0) {
      throw new InstallerError(
        "E_RECONFIGURE",
        "The project memory name cannot change for only some saved agents.",
        "Run again with --agents all so every saved agent gets the same name.",
      );
    }
  }

  async buildRulesPlan(agents, scope, projectDir, namespace, savedRules = null) {
    const body = await this.loadRulesBody();
    const files = [];
    const byActualPath = new Map();
    const activeTargets = new Map();
    const selected = new Set(agents);
    const preservedFiles = [];

    for (const savedFile of savedRules?.files ?? []) {
      const remainingAgents = savedFile.agents.filter((agent) => !selected.has(agent));
      if (remainingAgents.length > 0) {
        preservedFiles.push({ ...savedFile, agents: remainingAgents });
      }
    }

    for (const agent of agents) {
      const targets = await rulesTargetPaths(
        this.system,
        agent,
        scope,
        projectDir,
      );
      activeTargets.set(agent, targets);
      for (const target of targets) {
        const allowedRoot = scope === "project" ? projectDir : path.dirname(target);
        const inspection = await inspectRulesFile(this.system, target, body, {
          allowedRoot,
          namespace,
          scope,
        });
        const existing = byActualPath.get(inspection.actualPath);
        if (existing) {
          existing.agents.push(agent);
          continue;
        }
        const savedFile = savedRules?.files?.find(
          (item) => path.resolve(item.actualPath) === path.resolve(inspection.actualPath),
        );
        const file = {
          actualPath: inspection.actualPath,
          agents: [agent],
          allowedRoot,
          created: savedFile?.created ?? false,
          expectedActualPath: inspection.actualPath,
          expectedFileHash: inspection.fileHash,
          placement: savedFile?.placement,
          status: inspection.status,
          target,
        };
        byActualPath.set(inspection.actualPath, file);
        files.push(file);
      }
    }

    const staleFiles = [];
    const newActualPaths = new Set(files.map((file) => path.resolve(file.actualPath)));
    for (const savedFile of savedRules?.files ?? []) {
      const selectedAgents = savedFile.agents.filter((agent) => selected.has(agent));
      const remainingAgents = savedFile.agents.filter((agent) => !selected.has(agent));
      if (
        selectedAgents.length === 0
        || remainingAgents.length > 0
        || newActualPaths.has(path.resolve(savedFile.actualPath))
      ) {
        continue;
      }
      const allowedRoot = scope === "project" ? projectDir : path.dirname(savedFile.target);
      const inspection = await inspectRulesFile(
        this.system,
        savedFile.target,
        body,
        { allowedRoot, namespace, scope },
      );
      if (
        path.resolve(inspection.actualPath) !== path.resolve(savedFile.actualPath)
        || inspection.blockHash !== savedFile.hash
      ) {
        throw new InstallerError(
          "E_RULES_CHANGED",
          `The saved rules changed at ${savedFile.target}.`,
          "Review that file before running rules update again.",
        );
      }
      staleFiles.push({ ...savedFile, allowedRoot });
    }

    return {
      activeTargets,
      body,
      files,
      namespace,
      preservedFiles,
      projectDir,
      scope,
      staleFiles,
    };
  }

  async applyRulesPlan(plan, backupDir) {
    const applied = [];
    const operations = [];
    try {
      for (const [agent, expectedTargets] of plan.activeTargets) {
        const currentTargets = await rulesTargetPaths(
          this.system,
          agent,
          plan.scope,
          plan.projectDir,
        );
        if (JSON.stringify(currentTargets) !== JSON.stringify(expectedTargets)) {
          throw new InstallerError(
            "E_RULES_CHANGED",
            `The active ${agent} instruction file changed during install.`,
            "Run the command again so the new active file can be checked.",
          );
        }
      }

      for (const file of plan.files) {
        const result = await upsertRulesFile(
          this.system,
          file.target,
          plan.body,
          {
            allowedRoot: file.allowedRoot,
            expectedActualPath: file.expectedActualPath,
            expectedFileHash: file.expectedFileHash,
            namespace: plan.namespace,
            placement: file.placement,
            scope: plan.scope,
          },
        );
        applied.push({
          ...result,
          agents: file.agents,
          created: Boolean(file.created || result.created),
        });
        if (result.changed) {
          operations.push(result);
        }
      }

      for (const staleFile of plan.staleFiles) {
        const removed = await removeRulesFile(this.system, staleFile.target, {
          allowedRoot: staleFile.allowedRoot,
          backupDir,
          created: staleFile.created,
          expectedActualPath: staleFile.actualPath,
          expectedBlockHash: staleFile.hash,
          placement: staleFile.placement,
        });
        if (removed.changed) {
          operations.push(removed);
        }
      }

      const storedFiles = mergeRuleFiles([
        ...plan.preservedFiles,
        ...applied.map(({
          actualPath,
          agents: fileAgents,
          created,
          hash,
          placement,
          target,
        }) => ({
          actualPath,
          agents: fileAgents,
          created,
          hash,
          placement,
          target,
        })),
      ]);
      return {
        changed: operations.length > 0,
        files: storedFiles,
        operations,
      };
    } catch (error) {
      await this.rollbackRulesOperations(operations, backupDir);
      throw error;
    }
  }

  async rollbackRulesOperations(operations, backupDir) {
    for (const result of [...operations].reverse()) {
      try {
        const rolledBack = await rollbackRulesFile(this.system, result, backupDir);
        if (!rolledBack) {
          this.ui.warn(`Rules rollback skipped because ${result.target} changed again.`);
        }
      } catch (rollbackError) {
        this.ui.warn(`Rules rollback warning: ${rollbackError.message}`);
      }
    }
  }

  async loadRulesBody() {
    return this.system.readFile(
      path.join(this.packageRoot, "assets", "rules", "shared-memory.md"),
      "utf8",
    );
  }

  async readRulesRegistry(paths) {
    if (!(await this.system.lstatSafe(paths.rulesState))) {
      return { installations: [], schemaVersion: 1 };
    }
    const registry = JSON.parse(
      await this.system.readFile(paths.rulesState, "utf8"),
    );
    const installations = [];
    const keys = new Set();
    for (const saved of Array.isArray(registry.installations)
      ? registry.installations
      : []) {
      let projectDir = path.resolve(saved.projectDir);
      if (saved.scope === "project" && await this.system.lstatSafe(projectDir)) {
        projectDir = await this.system.realpath(projectDir);
      }
      const key = this.rulesInstallationKey(saved.scope, projectDir);
      if (keys.has(key)) {
        throw new InstallerError(
          "E_RULES_CONFLICT",
          "Two saved rules setups point to the same project.",
          "Review the rules registry before changing those files.",
        );
      }
      keys.add(key);
      installations.push({ ...saved, key, projectDir });
    }
    return { installations, schemaVersion: 1 };
  }

  async canonicalRulesProjectDir(scope, projectDir) {
    const resolved = path.resolve(projectDir);
    if (scope !== "project") {
      return resolved;
    }
    const stat = await this.system.lstatSafe(resolved);
    if (!stat) {
      throw new InstallerError(
        "E_PROJECT_MISSING",
        `Project directory does not exist: ${resolved}`,
      );
    }
    const actual = await this.system.realpath(resolved);
    const actualStat = await this.system.lstatSafe(actual);
    if (!actualStat?.isDirectory()) {
      throw new InstallerError(
        "E_PROJECT_MISSING",
        `Project path is not a directory: ${resolved}`,
      );
    }
    return actual;
  }

  async writeRulesRegistry(paths, registry) {
    await this.system.writeFileAtomic(
      paths.rulesState,
      `${JSON.stringify(registry, null, 2)}\n`,
      0o600,
    );
  }

  rulesInstallationKey(scope, projectDir) {
    return scope === "user"
      ? "user"
      : `project:${path.resolve(projectDir)}`;
  }

  findRulesInstallation(registry, scope, projectDir) {
    const key = this.rulesInstallationKey(scope, projectDir);
    return registry.installations.find((item) => item.key === key) ?? null;
  }

  replaceRulesInstallation(registry, installation) {
    return {
      installations: [
        ...registry.installations.filter((item) => item.key !== installation.key),
        installation,
      ],
      schemaVersion: 1,
    };
  }

  paths() {
    return this.activePaths ?? this.productPaths("Shopapps");
  }

  productPaths(brand) {
    const slug = brand.toLowerCase();
    const root = this.system.platform === "darwin"
      ? path.join(this.system.home, "Library", "Application Support", brand, "Agent Memory")
      : path.join(this.system.home, ".config", `${slug}-agent-memory`);
    return {
      backups: path.join(root, "backups"),
      canonicalSkill: path.join(root, "skill", "shared-memory"),
      compose: path.join(root, "compose.yaml"),
      root,
      runtimeEnv: path.join(root, "runtime.env"),
      rulesState: path.join(root, "rules.json"),
      state: path.join(root, "install.json"),
    };
  }

  async prepareInstallRoot() {
    if (!this.pathsReady) {
      this.pathsReady = this.resolveInstallRoot();
    }
    try {
      this.activePaths = await this.pathsReady;
    } catch (error) {
      this.pathsReady = null;
      throw error;
    }
    return this.activePaths;
  }

  async resolveInstallRoot() {
    const current = this.productPaths("Shopapps");
    const legacy = this.productPaths("Umony");
    const [currentOwned, legacyOwned] = await Promise.all([
      this.hasOwnedInstallRoot(current),
      this.hasOwnedInstallRoot(legacy),
    ]);
    if (currentOwned && legacyOwned) {
      throw new InstallerError(
        "E_INSTALL_PATH_CONFLICT",
        "Both the Shopapps and older Agent Memory install folders contain managed files.",
        "Keep both folders unchanged until you have checked which install owns your saved memories.",
      );
    }
    return legacyOwned ? legacy : current;
  }

  async hasOwnedInstallRoot(paths) {
    for (const target of [
      paths.state,
      paths.rulesState,
      paths.runtimeEnv,
      paths.compose,
      paths.canonicalSkill,
    ]) {
      if (await this.system.lstatSafe(target)) {
        return true;
      }
    }
    return false;
  }

  runtimeIdentity(state, manifest) {
    const composeProject = state?.composeProject
      ?? (this.paths().root === this.productPaths("Umony").root
        ? LEGACY_PRODUCT.composeProject
        : null)
      ?? manifest.composeProject
      ?? CURRENT_PRODUCT.composeProject;
    const redisVolume = state?.redisVolume
      ?? (composeProject === LEGACY_PRODUCT.composeProject
        ? LEGACY_PRODUCT.redisVolume
        : manifest.redisVolume ?? CURRENT_PRODUCT.redisVolume);
    return { composeProject, redisVolume };
  }

  savedLocalImage(state) {
    return LOCAL_SOURCE_IMAGES.has(state?.localSourceImage)
      ? state.localSourceImage
      : null;
  }

  composeEnvironment(identity, overrides = {}) {
    return {
      ...this.system.env,
      AMS_REDIS_VOLUME: identity.redisVolume,
      ...overrides,
    };
  }

  async loadManifest() {
    const manifestPath = path.join(this.packageRoot, "assets", "release-manifest.json");
    const manifest = JSON.parse(await this.system.readFile(manifestPath, "utf8"));
    for (const field of ["serverImage", "redisImage"]) {
      if (!/@sha256:[a-f0-9]{64}$/.test(manifest[field] ?? "")) {
        throw new InstallerError(
          "E_RELEASE_UNTRUSTED",
          `Release manifest field ${field} is not pinned to an image digest.`,
        );
      }
    }
    return manifest;
  }

  async preflightDocker() {
    if (this.system.platform !== "darwin") {
      throw new InstallerError(
        "E_UNSUPPORTED_MAC",
        "This quickstart installer currently supports macOS only.",
        "Use the manual installation instructions on another platform.",
      );
    }
    await this.runChecked("docker", ["--version"], "E_DOCKER_MISSING", "Docker Desktop is not installed.");
    await this.runChecked(
      "docker",
      ["compose", "version"],
      "E_COMPOSE_MISSING",
      "Docker Compose is not available.",
    );
    await this.runChecked(
      "docker",
      ["info"],
      "E_DOCKER_STOPPED",
      "Docker Desktop is not running.",
      "Open Docker Desktop, wait until it is ready, then run this command again.",
    );
  }

  async resolveAgents(requested, state, detected) {
    const agents = requested ?? Object.keys(state?.agents ?? {});
    const selected = agents.length > 0 ? agents : detected;
    if (selected.length === 0) {
      throw new InstallerError(
        "E_NO_CLIENT",
        "No supported agent client was found.",
        "Install Codex or Claude Code, then run this command again.",
      );
    }
    const missing = selected.filter((agent) => !detected.includes(agent));
    if (missing.length > 0) {
      throw new InstallerError(
        "E_NO_CLIENT",
        `Requested agent client is not installed: ${missing.join(", ")}.`,
      );
    }
    return selected;
  }

  async assertPorts(apiPort, mcpPort) {
    for (const [label, port] of [["REST", apiPort], ["MCP", mcpPort]]) {
      if (!(await this.system.isPortAvailable(port))) {
        throw new InstallerError(
          "E_PORT_IN_USE",
          `${label} port ${port} is already in use.`,
          `Stop the other process or choose another port with --${label === "REST" ? "api" : "mcp"}-port.`,
        );
      }
    }
  }

  async assertNoClientConflicts(agents, clientOptions, paths, state) {
    const canonicalExists = Boolean(await this.system.lstatSafe(paths.canonicalSkill));
    for (const agent of agents) {
      const target = skillTargetPath(
        agent,
        clientOptions.scope,
        this.system.home,
        clientOptions.projectDir,
      );
      if (await this.system.lstatSafe(target)) {
        if (!canonicalExists) {
          throw new InstallerError(
            "E_SKILL_CONFLICT",
            `A Skill already exists at ${target}.`,
          );
        }
        const skill = await inspectSkill(this.system, target, paths.canonicalSkill);
        if (skill.status !== "matching") {
          throw new InstallerError(
            "E_SKILL_CONFLICT",
            `A different Skill already exists at ${target}.`,
          );
        }
      }

      const mcp = await inspectMcp(this.system, agent, clientOptions);
      if (mcp.status === "conflict") {
        throw new InstallerError(
          "E_MCP_CONFLICT",
          `${agent} already has a different MCP server named ${clientOptions.name}.`,
          `Expected ${clientOptions.url}; found ${mcp.url || "an unreadable URL"}.`,
        );
      }
    }
  }

  async stageManagedFiles(paths, manifest, options) {
    await this.system.mkdir(paths.root);
    const composeSource = path.join(this.packageRoot, "assets", "compose.yaml");
    await this.system.writeFileAtomic(paths.compose, await this.system.readFile(composeSource, "utf8"));

    const skillSource = path.join(this.packageRoot, "assets", "skill", "shared-memory");
    await this.system.mkdir(path.dirname(paths.canonicalSkill));
    await this.system.copyDirectory(skillSource, paths.canonicalSkill);

    const existing = (await this.system.lstatSafe(paths.runtimeEnv))
      ? await this.system.readFile(paths.runtimeEnv, "utf8")
      : "";
    const updates = {
      AMS_API_PORT: String(options.apiPort),
      AMS_COMPOSE_PROJECT: options.composeProject,
      AMS_ENV_FILE: paths.runtimeEnv,
      AMS_IMAGE: manifest.serverImage,
      AMS_MCP_PORT: String(options.mcpPort),
      AMS_REDIS_IMAGE: manifest.redisImage,
      AMS_REDIS_VOLUME: options.redisVolume,
    };
    if (options.openaiApiKey) {
      updates.OPENAI_API_KEY = options.openaiApiKey;
    } else if (this.system.env.OPENAI_API_KEY) {
      updates.OPENAI_API_KEY = this.system.env.OPENAI_API_KEY;
    }
    const content = mergeEnv(existing, updates);
    await this.system.writeFileAtomic(paths.runtimeEnv, content, 0o600);
  }

  composeCommand(paths, composeProject) {
    return [
      "compose",
      "--project-name",
      composeProject,
      "--env-file",
      paths.runtimeEnv,
      "--file",
      paths.compose,
    ];
  }

  async runChecked(
    command,
    args,
    code,
    message,
    hint = undefined,
    runOptions = {},
  ) {
    let result;
    try {
      result = await this.system.run(command, args, {
        env: this.system.env,
        ...runOptions,
      });
    } catch (error) {
      if (error && error.code === "ENOENT") {
        throw new InstallerError(code, message, hint);
      }
      throw error;
    }
    if (result.code !== 0) {
      throw new InstallerError(code, message, hint ?? bounded(result.stderr || result.stdout));
    }
    return result;
  }

  async assertMemoryVolume(redisVolume) {
    const result = await this.system.run(
      "docker",
      ["volume", "inspect", redisVolume],
      { env: this.system.env },
    );
    if (result.code !== 0) {
      throw new InstallerError(
        "E_MEMORY_VOLUME_MISSING",
        `The saved memory volume is missing: ${redisVolume}.`,
        "The installer stopped before changing Docker. Check Docker Desktop and the saved install settings.",
      );
    }
  }

  async checkApi(port) {
    if (!(await this.isApiHealthy(port))) {
      throw new InstallerError(
        "E_HEALTH_FAILED",
        `The REST health check failed on port ${port}.`,
        "Run the logs command to see bounded container logs.",
      );
    }
  }

  async isApiHealthy(port) {
    try {
      const response = await this.system.fetch(`http://127.0.0.1:${port}/v1/health`, {
        signal: AbortSignal.timeout(5000),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async rollbackClientChanges(created, clientOptions, paths) {
    for (const item of [...created].reverse()) {
      try {
        if (item.kind === "mcp") {
          await removeOwnedMcp(this.system, item.agent, clientOptions);
        } else {
          await moveOwnedSkill(this.system, item.target, paths.backups);
        }
      } catch (error) {
        this.ui.warn(`Rollback warning: ${error.message}`);
      }
    }
  }

  async requireInstall() {
    const paths = this.paths();
    const state = await this.readState(paths);
    if (!state || state.phase === "uninstalled") {
      throw new InstallerError(
        "E_NOT_INSTALLED",
        "Agent Memory is not installed.",
        "Run the installer command first.",
      );
    }
    return { manifest: await this.loadManifest(), paths, state };
  }

  async readState(paths) {
    if (!(await this.system.lstatSafe(paths.state))) {
      return null;
    }
    return JSON.parse(await this.system.readFile(paths.state, "utf8"));
  }

  async writeState(paths, state) {
    await this.system.writeFileAtomic(paths.state, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  }

  async hasOpenAiKey(paths) {
    if (!(await this.system.lstatSafe(paths.runtimeEnv))) {
      return false;
    }
    return /^OPENAI_API_KEY=/m.test(await this.system.readFile(paths.runtimeEnv, "utf8"));
  }

  async commandCheck(name, command, args) {
    try {
      const result = await this.system.run(command, args, { env: this.system.env });
      return { detail: bounded(result.stderr || result.stdout), name, ok: result.code === 0 };
    } catch (error) {
      return { detail: error.message, name, ok: false };
    }
  }
}

function mergeRuleFiles(files) {
  const merged = new Map();
  for (const file of files) {
    const key = path.resolve(file.actualPath);
    const existing = merged.get(key);
    if (!existing) {
      merged.set(key, {
        ...file,
        agents: [...new Set(file.agents)].sort(),
      });
      continue;
    }
    merged.set(key, {
      ...existing,
      ...file,
      agents: [...new Set([...existing.agents, ...file.agents])].sort(),
    });
  }
  return [...merged.values()];
}

export function mergeEnv(existing, updates) {
  const remaining = new Map(Object.entries(updates));
  const lines = existing ? existing.replace(/\n$/, "").split("\n") : [];
  const merged = lines.map((line) => {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=/);
    if (!match || !remaining.has(match[1])) {
      return line;
    }
    const value = remaining.get(match[1]);
    remaining.delete(match[1]);
    return `${match[1]}=${envValue(value)}`;
  });
  for (const [key, value] of remaining) {
    merged.push(`${key}=${envValue(value)}`);
  }
  return `${merged.filter((line, index) => line || index < merged.length - 1).join("\n")}\n`;
}

function envValue(value) {
  const text = String(value);
  if (/\r|\n/.test(text)) {
    throw new InstallerError("E_BAD_SECRET", "Environment values cannot contain new lines.");
  }
  return JSON.stringify(text);
}

function bounded(value) {
  const text = String(value ?? "").trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
