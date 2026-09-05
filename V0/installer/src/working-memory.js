import { randomUUID } from "node:crypto";
import path from "node:path";

import { projectId } from "../assets/working-memory-hook.mjs";
import { InstallerError } from "./errors.js";

const OWNER = "@shopapps/agent-memory/working-memory";
const EVENTS = ["SessionStart", "UserPromptSubmit", "Stop"];
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;

export async function configureWorkingMemory({ system, packageRoot, paths, ui, options, state, uninstall = false }) {
  const scope = options.scope ?? (options.projectDir ? "project" : state?.scope) ?? "user";
  const projectDir = path.resolve(options.projectDir ?? state?.projectDir ?? system.cwd);
  const agents = options.agents ?? Object.keys(state?.agents ?? {});
  if (!agents.length) throw new InstallerError("E_BAD_AGENT", "Choose --agents codex, claude, or all.");
  let root = scope === "user" ? system.home : projectDir;
  let project = null;
  if (scope === "project") {
    const gitRoot = await system.run("git", ["-C", projectDir, "rev-parse", "--show-toplevel"]);
    if (gitRoot.code !== 0) throw new InstallerError("E_BAD_SCOPE", "Working Memory project scope needs a Git repository.");
    root = gitRoot.stdout.trim();
    const remote = await system.run("git", ["-C", projectDir, "remote", "get-url", "origin"]);
    project = projectId(remote.code === 0 ? remote.stdout : "", gitRoot.stdout.trim());
    if (!project) throw new InstallerError("E_BAD_SCOPE", "Could not resolve this repository's project name.");
  }
  const runner = path.join(paths.root, "working-memory-hook.mjs");
  const identityPath = path.join(paths.root, "working-memory-user.json");
  const identity = await readJson(system, identityPath) ?? { userId: randomUUID() };
  const plans = [];
  for (const client of agents) {
    const override = scope === "user" ? system.env[client === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"] : null;
    const directory = override ? path.resolve(override) : path.join(root, client === "codex" ? ".codex" : ".claude");
    const configPath = path.join(directory, "ams-working-memory.json");
    const hookPath = path.join(directory, client === "codex" ? "hooks.json" : "settings.json");
    const saved = await readJson(system, configPath);
    if (saved && saved.owner !== OWNER) throw new InstallerError("E_HOOK_CONFLICT", `A different config exists at ${configPath}.`);
    if (uninstall && !saved) continue;
    const document = await readJson(system, hookPath) ?? {};
    if (document.hooks && (typeof document.hooks !== "object" || Array.isArray(document.hooks))) {
      throw new InstallerError("E_HOOK_CONFLICT", `Invalid hooks in ${hookPath}.`);
    }
    const command = `${quote(process.execPath)} ${quote(runner)} ${quote(configPath)}`;
    const config = { owner: OWNER, enabled: !uninstall, client, projectId: project,
      userId: saved?.userId ?? identity.userId,
      apiUrl: options.apiPort !== null && options.apiPort !== undefined
        ? `http://127.0.0.1:${options.apiPort}` : saved?.apiUrl ?? `http://127.0.0.1:${state?.apiPort ?? 8000}`,
      promotion: options.promotion ?? saved?.promotion ?? "review",
      longTermRecall: saved?.longTermRecall ?? true, command };
    for (const event of EVENTS) {
      const entries = document.hooks?.[event] ?? [];
      if (!Array.isArray(entries) || entries.some((entry) => !Array.isArray(entry.hooks))) {
        throw new InstallerError("E_HOOK_CONFLICT", `Invalid ${event} hooks in ${hookPath}.`);
      }
      const kept = entries.map((entry) => ({ ...entry,
        hooks: entry.hooks.filter((hook) => !saved || hook.command !== saved.command),
      })).filter((entry) => entry.hooks.length);
      if (!uninstall) kept.push({ hooks: [{ type: "command", command, timeout: 5 }] });
      document.hooks ??= {};
      document.hooks[event] = kept;
    }
    plans.push({ config, configPath, document, hookPath });
  }
  if (!plans.length) return { ok: true, changed: false, status: "No Working Memory hooks were installed" };
  ui.info(`Working Memory: ${uninstall ? "remove capture hooks" : "30 exchanges, 7-day expiry"}`);
  if (!uninstall) ui.info(`Filtering: ${plans[0].config.promotion}. Review/auto use the server's AI provider; auto shares selected facts with the project.`);
  if (!uninstall) ui.info("Recall: recent chat plus up to six saved project facts. Saved-fact lookups use local keyword search, not paid AI calls.");
  for (const plan of plans) ui.info(`  ${plan.hookPath}`);
  if (options.dryRun) return { ok: true, dryRun: true, changed: false };
  if (!(await ui.confirm(uninstall ? "Remove these Working Memory hooks? Stored data will expire normally." : "Enable these Working Memory hooks? Recent project chat will be stored locally.", false))) {
    return { ok: true, cancelled: true, changed: false };
  }
  // Validate every target before any write. Keep backups and roll back partial installs.
  const written = [];
  try {
    if (!uninstall) {
      await system.writeFileAtomic(identityPath, JSON.stringify(identity), 0o600);
      const source = await system.readFile(path.join(packageRoot, "assets", "working-memory-hook.mjs"), "utf8");
      await system.writeFileAtomic(runner, source, 0o600);
    }
    for (const plan of plans) {
      for (const [target, value] of [[plan.configPath, plan.config], [plan.hookPath, plan.document]]) {
        const previous = await system.lstatSafe(target) ? await system.readFile(target, "utf8") : null;
        if (previous !== null) {
          await system.writeFileAtomic(path.join(paths.backups, `working-memory-${randomUUID()}.json`), previous, 0o600);
        }
        written.push({ target, previous });
        await system.writeFileAtomic(target, `${JSON.stringify(value, null, 2)}\n`, 0o600);
      }
    }
  } catch (error) {
    for (const { target, previous } of written.reverse()) {
      if (previous !== null) await system.writeFileAtomic(target, previous, 0o600);
      else if (await system.lstatSafe(target)) {
        await system.mkdir(paths.backups);
        await system.move(target, path.join(paths.backups, `working-memory-rollback-${randomUUID()}.json`));
      }
    }
    throw error;
  }
  return { ok: true, changed: true, status: uninstall ? "Working Memory hooks removed; data kept" : "Working Memory hooks ready",
    workingMemoryUrl: `${plans[0].config.apiUrl}/admin/working-memory?user_id=${encodeURIComponent(plans[0].config.userId)}`,
    hookFiles: plans.map((plan) => plan.hookPath) };
}

async function readJson(system, target) {
  const stat = await system.lstatSafe(target);
  if (!stat) return null;
  if (stat.isSymbolicLink()) throw new InstallerError("E_HOOK_CONFLICT", `Refusing to replace linked config ${target}.`);
  try {
    const value = JSON.parse(await system.readFile(target, "utf8"));
    if (!value || Array.isArray(value) || typeof value !== "object") throw new Error("Not an object");
    return value;
  } catch {
    throw new InstallerError("E_HOOK_CONFLICT", `Invalid JSON in ${target}. Fix it before installing hooks.`);
  }
}
