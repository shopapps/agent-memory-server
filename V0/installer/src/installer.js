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

export class Installer {
  constructor({ system, packageRoot, ui }) {
    this.system = system;
    this.packageRoot = packageRoot;
    this.ui = ui;
  }

  async run(command, options) {
    switch (command) {
      case "install":
      case "update":
        return this.install(options, command);
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
      default:
        throw new InstallerError("E_BAD_COMMAND", `Unsupported command: ${command}`);
    }
  }

  async hasSavedInstall() {
    const state = await this.readState(this.paths());
    return Boolean(state && state.phase !== "uninstalled");
  }

  async install(options, command = "install") {
    const manifest = await this.loadManifest();
    const paths = this.paths();
    const savedState = await this.readState(paths);
    const existingState = savedState?.phase === "uninstalled" ? null : savedState;
    const scope = options.scope ?? existingState?.scope ?? "user";
    const projectDir = path.resolve(options.projectDir ?? existingState?.projectDir ?? this.system.cwd);

    if (existingState) {
      if (options.scope && options.scope !== existingState.scope) {
        throw new InstallerError(
          "E_RECONFIGURE",
          "The install scope cannot be changed during a repair or update.",
          "Run uninstall first, then install again with the new scope.",
        );
      }
      if (
        options.projectDir
        && path.resolve(options.projectDir) !== path.resolve(existingState.projectDir)
      ) {
        throw new InstallerError(
          "E_RECONFIGURE",
          "The project directory cannot be changed during a repair or update.",
          "Run uninstall first, then install again from the new project.",
        );
      }
    }

    const detected = await this.preflightDocker();
    const agents = await this.resolveAgents(options.agents, existingState, detected);
    const apiPort = options.apiPort ?? existingState?.apiPort ?? 8000;
    const mcpPort = options.mcpPort ?? existingState?.mcpPort ?? 9050;
    const mcpUrl = `http://127.0.0.1:${mcpPort}/mcp`;

    if (scope === "project" && !(await this.system.lstatSafe(projectDir))) {
      throw new InstallerError(
        "E_PROJECT_MISSING",
        `Project directory does not exist: ${projectDir}`,
      );
    }

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
      dockerProject: manifest.composeProject,
      mcpUrl,
      scope,
      serverVersion: manifest.serverVersion,
    };

    this.ui.info(`${command === "update" ? "Update" : "Install"} plan`);
    this.ui.info(`  Agents: ${agents.join(", ")}`);
    this.ui.info(`  Scope: ${scope}`);
    this.ui.info(`  API: ${plan.apiUrl}`);
    this.ui.info(`  MCP: ${mcpUrl}`);

    if (options.dryRun) {
      return { changed: false, dryRun: true, ok: true, plan };
    }

    if (!(await this.ui.confirm("Continue with this plan?", true))) {
      return { cancelled: true, changed: false, ok: true, plan };
    }

    const compose = this.composeCommand(paths, manifest);
    try {
      await this.stageManagedFiles(paths, manifest, {
        apiPort,
        mcpPort,
        openaiApiKey: options.openaiApiKey,
      });
      await this.runChecked("docker", [...compose, "pull"], "E_IMAGE_PULL", "Docker image pull failed.");
      await this.runChecked(
        "docker",
        [...compose, "up", "--detach", "--wait", "--wait-timeout", "120", "redis"],
        "E_REDIS_START",
        "Redis 8 did not become healthy.",
      );
      await this.runChecked(
        "docker",
        [...compose, "run", "--rm", "--no-deps", "api", "agent-memory", "migrate-memories"],
        "E_MIGRATION",
        "Memory migration failed.",
      );
      await this.runChecked(
        "docker",
        [...compose, "up", "--detach", "--wait", "--wait-timeout", "180"],
        "E_STARTUP_TIMEOUT",
        "The Agent Memory containers did not become healthy.",
      );
      await this.checkApi(apiPort);
    } catch (error) {
      if (!existingState) {
        try {
          const cleanup = await this.system.run("docker", [...compose, "down"], {
            env: this.system.env,
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
      composeProject: manifest.composeProject,
      installedAt: existingState?.installedAt ?? this.system.now().toISOString(),
      installerVersion: manifest.installerVersion,
      mcpPort,
      mcpUrl,
      phase: "registering-clients",
      projectDir,
      redisImage: manifest.redisImage,
      schemaVersion: 1,
      scope,
      serverImage: manifest.serverImage,
      serverVersion: manifest.serverVersion,
      updatedAt: this.system.now().toISOString(),
    };
    await this.writeState(paths, state);

    const created = [];
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
    } catch (error) {
      await this.rollbackClientChanges(created, clientOptions, paths);
      state.agents = savedAgents;
      state.phase = "client-registration-failed";
      state.lastError = error instanceof Error ? error.message : String(error);
      await this.writeState(paths, state);
      if (!existingState) {
        await this.system.run("docker", [...compose, "stop"], { env: this.system.env });
      }
      throw error;
    }

    state.phase = "ready";
    state.updatedAt = this.system.now().toISOString();
    delete state.lastError;
    await this.writeState(paths, state);

    const providerConfigured = await this.hasOpenAiKey(paths);
    if (!providerConfigured) {
      this.ui.warn("No OpenAI API key is configured. The runtime is ready, but model-backed memory features will fail until a key is added.");
    }

    return {
      agents,
      apiUrl: plan.apiUrl,
      changed: true,
      mcpUrl,
      ok: true,
      providerConfigured,
      scope,
      serverVersion: manifest.serverVersion,
    };
  }

  async status() {
    const paths = this.paths();
    const state = await this.readState(paths);
    if (!state || state.phase === "uninstalled") {
      return { changed: false, installed: false, ok: true };
    }

    const manifest = await this.loadManifest();
    const compose = this.composeCommand(paths, manifest);
    const ps = await this.system.run("docker", [...compose, "ps", "--format", "json"], {
      env: this.system.env,
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

    return {
      changed: false,
      checks,
      ok: checks.every((check) => check.ok),
    };
  }

  async start() {
    const { manifest, paths, state } = await this.requireInstall();
    await this.preflightDocker();
    const compose = this.composeCommand(paths, manifest);
    await this.runChecked(
      "docker",
      [...compose, "up", "--detach", "--wait", "--wait-timeout", "180"],
      "E_STARTUP_TIMEOUT",
      "The Agent Memory containers did not become healthy.",
    );
    await this.checkApi(state.apiPort);
    return { changed: true, ok: true, status: "started" };
  }

  async stop() {
    const { manifest, paths } = await this.requireInstall();
    await this.preflightDocker();
    const compose = this.composeCommand(paths, manifest);
    await this.runChecked("docker", [...compose, "stop"], "E_DOCKER", "Docker could not stop the runtime.");
    return { changed: true, dataPreserved: true, ok: true, status: "stopped" };
  }

  async logs(options) {
    const { manifest, paths } = await this.requireInstall();
    await this.preflightDocker();
    const compose = this.composeCommand(paths, manifest);
    const args = [...compose, "logs", "--tail", "200"];
    if (options.follow) {
      args.push("--follow");
    }
    const result = await this.system.run("docker", args, {
      env: this.system.env,
      stdio: "inherit",
    });
    if (result.code !== 0) {
      throw new InstallerError("E_DOCKER", "Docker could not read the runtime logs.");
    }
    return { changed: false, ok: true };
  }

  async uninstall() {
    const { manifest, paths, state } = await this.requireInstall();
    const warnings = [];
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

    const compose = this.composeCommand(paths, manifest);
    const down = await this.system.run("docker", [...compose, "down"], { env: this.system.env });
    if (down.code !== 0) {
      warnings.push("Docker could not remove the stopped containers. The Redis data volume was not touched.");
    }

    state.phase = "uninstalled";
    state.uninstalledAt = this.system.now().toISOString();
    await this.writeState(paths, state);
    return { changed: true, dataPreserved: true, ok: true, warnings };
  }

  paths() {
    const root = this.system.platform === "darwin"
      ? path.join(this.system.home, "Library", "Application Support", "Umony", "Agent Memory")
      : path.join(this.system.home, ".config", "umony-agent-memory");
    return {
      backups: path.join(root, "backups"),
      canonicalSkill: path.join(root, "skill", "shared-memory"),
      compose: path.join(root, "compose.yaml"),
      root,
      runtimeEnv: path.join(root, "runtime.env"),
      state: path.join(root, "install.json"),
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
    return detectAgents(this.system);
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
      AMS_COMPOSE_PROJECT: manifest.composeProject,
      AMS_ENV_FILE: paths.runtimeEnv,
      AMS_IMAGE: manifest.serverImage,
      AMS_MCP_PORT: String(options.mcpPort),
      AMS_REDIS_IMAGE: manifest.redisImage,
    };
    if (options.openaiApiKey) {
      updates.OPENAI_API_KEY = options.openaiApiKey;
    } else if (this.system.env.OPENAI_API_KEY) {
      updates.OPENAI_API_KEY = this.system.env.OPENAI_API_KEY;
    }
    const content = mergeEnv(existing, updates);
    await this.system.writeFileAtomic(paths.runtimeEnv, content, 0o600);
  }

  composeCommand(paths, manifest) {
    return [
      "compose",
      "--project-name",
      manifest.composeProject,
      "--env-file",
      paths.runtimeEnv,
      "--file",
      paths.compose,
    ];
  }

  async runChecked(command, args, code, message, hint = undefined) {
    let result;
    try {
      result = await this.system.run(command, args, { env: this.system.env });
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
