import path from "node:path";

import { InstallerError } from "./errors.js";

const CODEX_BLOCK_START = "# >>> @shopapps/agent-memory shared-memory >>>";
const CODEX_BLOCK_END = "# <<< @shopapps/agent-memory shared-memory <<<";
const LEGACY_CODEX_BLOCK_START = "# >>> @umony/agent-memory shared-memory >>>";
const LEGACY_CODEX_BLOCK_END = "# <<< @umony/agent-memory shared-memory <<<";
const CODEX_MARKER_PAIRS = [
  { end: CODEX_BLOCK_END, legacy: false, start: CODEX_BLOCK_START },
  { end: LEGACY_CODEX_BLOCK_END, legacy: true, start: LEGACY_CODEX_BLOCK_START },
];

export async function detectAgents(system) {
  const detected = [];
  for (const agent of ["codex", "claude"]) {
    try {
      const result = await system.run(agent, ["--version"], {
        env: system.env,
      });
      if (result.code === 0) {
        detected.push(agent);
      }
    } catch (error) {
      if (error && error.code !== "ENOENT") {
        throw error;
      }
    }
  }
  return detected;
}

export function skillTargetPath(agent, scope, home, projectDir) {
  const root = scope === "project" ? projectDir : home;
  if (agent === "codex") {
    return path.join(root, ".agents", "skills", "shared-memory");
  }
  if (agent === "claude") {
    return path.join(root, ".claude", "skills", "shared-memory");
  }
  throw new InstallerError("E_BAD_AGENT", `Unsupported agent: ${agent}`);
}

export async function inspectSkill(system, target, canonical) {
  const stat = await system.lstatSafe(target);
  if (!stat) {
    return { status: "absent", target };
  }
  if (!stat.isSymbolicLink()) {
    return { status: "conflict", target };
  }

  const [actual, expected] = await Promise.all([
    system.realpath(target),
    system.realpath(canonical),
  ]);
  if (actual !== expected) {
    return { status: "conflict", target };
  }
  return { status: "matching", target };
}

export async function installSkill(system, target, canonical) {
  const inspection = await inspectSkill(system, target, canonical);
  if (inspection.status === "conflict") {
    throw new InstallerError(
      "E_SKILL_CONFLICT",
      `A different Skill already exists at ${target}.`,
      "Move or rename that Skill, then run the installer again.",
    );
  }
  if (inspection.status === "matching") {
    return { agentPath: target, created: false };
  }

  await system.mkdir(path.dirname(target));
  await system.symlink(canonical, target, "dir");
  return { agentPath: target, created: true };
}

export async function moveOwnedSkill(system, target, backupDir) {
  const stat = await system.lstatSafe(target);
  if (!stat) {
    return null;
  }
  await system.mkdir(backupDir);
  const backup = path.join(
    backupDir,
    `${path.basename(target)}-${system.now().toISOString().replaceAll(":", "-")}`,
  );
  await system.move(target, backup);
  return backup;
}

export async function inspectMcp(system, agent, options) {
  if (agent === "codex" && options.scope === "project") {
    return inspectCodexProject(system, options);
  }

  const command = agent;
  const args = agent === "codex"
    ? ["mcp", "get", options.name, "--json"]
    : ["mcp", "get", options.name];
  const result = await system.run(command, args, {
    cwd: options.scope === "user" ? system.home : options.projectDir,
    env: system.env,
  });

  if (result.code !== 0) {
    if (isMissingMcp(result.stderr + result.stdout)) {
      return { status: "absent" };
    }
    throw new InstallerError(
      "E_AGENT_CONFIG",
      `${agent} could not inspect its MCP configuration.`,
      bounded(result.stderr || result.stdout),
    );
  }

  const existingUrl = agent === "codex"
    ? findUrl(parseCodexMcp(result.stdout))
    : findUrlInText(result.stdout);
  const existingScope = agent === "claude" ? findScopeInText(result.stdout) : null;

  if (existingScope && existingScope !== options.scope) {
    return { status: "absent" };
  }

  if (existingUrl === options.url) {
    return { status: "matching", url: existingUrl };
  }
  return { status: "conflict", url: existingUrl };
}

export async function installMcp(system, agent, options) {
  const inspection = await inspectMcp(system, agent, options);
  if (inspection.status === "conflict") {
    throw new InstallerError(
      "E_MCP_CONFLICT",
      `${agent} already has an MCP server named ${options.name}.`,
      `Its URL is ${inspection.url || "not readable"}; expected ${options.url}.`,
    );
  }
  if (inspection.status === "matching") {
    if (agent === "codex" && options.scope === "project" && inspection.legacy) {
      await installCodexProject(system, options);
    }
    return { created: false, url: options.url };
  }

  if (agent === "codex" && options.scope === "project") {
    await installCodexProject(system, options);
    return { created: true, url: options.url };
  }

  const args = agent === "codex"
    ? ["mcp", "add", options.name, "--url", options.url]
    : [
        "mcp",
        "add",
        "--transport",
        "http",
        "--scope",
        options.scope,
        options.name,
        options.url,
      ];
  const result = await system.run(agent, args, {
    cwd: options.projectDir,
    env: system.env,
  });
  if (result.code !== 0) {
    throw new InstallerError(
      "E_AGENT_CONFIG",
      `${agent} could not register the MCP server.`,
      bounded(result.stderr || result.stdout),
    );
  }
  return { created: true, url: options.url };
}

export async function removeOwnedMcp(system, agent, options) {
  if (agent === "codex" && options.scope === "project") {
    return removeCodexProject(system, options);
  }

  const args = agent === "codex"
    ? ["mcp", "remove", options.name]
    : ["mcp", "remove", "--scope", options.scope, options.name];
  const result = await system.run(agent, args, {
    cwd: options.projectDir,
    env: system.env,
  });
  if (result.code !== 0 && !isMissingMcp(result.stderr + result.stdout)) {
    throw new InstallerError(
      "E_AGENT_CONFIG",
      `${agent} could not remove the installer-owned MCP server.`,
      bounded(result.stderr || result.stdout),
    );
  }
  return result.code === 0;
}

async function inspectCodexProject(system, options) {
  const configPath = path.join(options.projectDir, ".codex", "config.toml");
  const stat = await system.lstatSafe(configPath);
  if (!stat) {
    return { configPath, status: "absent" };
  }
  const content = await system.readFile(configPath, "utf8");
  const managed = managedCodexBlock(content);
  if (managed) {
    const url = findUrlInToml(managed.content);
    return {
      configPath,
      legacy: managed.legacy,
      status: url === options.url ? "matching" : "conflict",
      url,
    };
  }

  const section = findTomlSection(content, `mcp_servers.${options.name}`);
  if (!section) {
    return { configPath, status: "absent" };
  }
  const url = findUrlInToml(section);
  return {
    configPath,
    status: url === options.url ? "matching" : "conflict",
    url,
  };
}

async function installCodexProject(system, options) {
  const configPath = path.join(options.projectDir, ".codex", "config.toml");
  const existingStat = await system.lstatSafe(configPath);
  const existing = existingStat ? await system.readFile(configPath, "utf8") : "";
  const block = [
    CODEX_BLOCK_START,
    `[mcp_servers.${options.name}]`,
    `url = ${JSON.stringify(options.url)}`,
    CODEX_BLOCK_END,
    "",
  ].join("\n");
  const managed = managedCodexBlock(existing);
  const separator = existing && !existing.endsWith("\n") ? "\n" : "";
  const updated = managed
    ? existing.slice(0, managed.start) + block + existing.slice(managed.end)
    : existing + separator + block;
  await system.writeFileAtomic(
    configPath,
    updated,
    existingStat ? existingStat.mode & 0o777 : 0o644,
  );
}

async function removeCodexProject(system, options) {
  const configPath = path.join(options.projectDir, ".codex", "config.toml");
  const existingStat = await system.lstatSafe(configPath);
  if (!existingStat) {
    return false;
  }
  const existing = await system.readFile(configPath, "utf8");
  const managed = managedCodexBlock(existing);
  if (!managed) {
    return false;
  }
  const updated = (
    existing.slice(0, managed.start) + existing.slice(managed.end)
  ).replace(/\n{3,}/g, "\n\n");
  await system.writeFileAtomic(configPath, updated, existingStat.mode & 0o777);
  return true;
}

function managedCodexBlock(content) {
  const found = [];
  for (const pair of CODEX_MARKER_PAIRS) {
    const starts = countOccurrences(content, pair.start);
    const ends = countOccurrences(content, pair.end);
    if (starts === 0 && ends === 0) {
      continue;
    }
    const start = content.indexOf(pair.start);
    const endMarkerStart = content.indexOf(pair.end);
    if (starts !== 1 || ends !== 1 || start < 0 || endMarkerStart < start) {
      throw new InstallerError(
        "E_MCP_CONFLICT",
        "The installer-owned Codex MCP markers are missing, repeated, or out of order.",
      );
    }
    let end = endMarkerStart + pair.end.length;
    if (content[end] === "\r" && content[end + 1] === "\n") {
      end += 2;
    } else if (content[end] === "\n") {
      end += 1;
    }
    found.push({
      content: content.slice(start, end),
      end,
      legacy: pair.legacy,
      start,
    });
  }
  if (found.length === 0) {
    return null;
  }
  if (found.length !== 1) {
    throw new InstallerError(
      "E_MCP_CONFLICT",
      "More than one installer-owned Codex MCP block was found.",
    );
  }
  return found[0];
}

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

function findUrl(value) {
  if (!value || typeof value !== "object") {
    return null;
  }
  if (typeof value.url === "string") {
    return value.url;
  }
  for (const nested of Object.values(value)) {
    const found = findUrl(nested);
    if (found) {
      return found;
    }
  }
  return null;
}

function parseCodexMcp(value) {
  try {
    return JSON.parse(value);
  } catch {
    throw new InstallerError(
      "E_AGENT_CONFIG",
      "Codex returned unreadable MCP configuration.",
      bounded(value),
    );
  }
}

function findTomlSection(content, sectionName) {
  const header = `[${sectionName}]`;
  const start = content.indexOf(header);
  if (start < 0) {
    return null;
  }
  const afterHeader = start + header.length;
  const rest = content.slice(afterHeader);
  const nextHeader = rest.search(/^\[/m);
  const end = nextHeader < 0 ? content.length : afterHeader + nextHeader;
  return content.slice(start, end);
}

function findUrlInText(value) {
  return value.match(/https?:\/\/[^\s"']+/)?.[0]?.replace(/[),.;]+$/, "") ?? null;
}

function findScopeInText(value) {
  return value.match(/^\s*scope\s*:\s*(user|project|local)\b/im)?.[1]?.toLowerCase() ?? null;
}

function findUrlInToml(value) {
  const match = value.match(/^url\s*=\s*["']([^"']+)["']/m);
  return match?.[1] ?? null;
}

function isMissingMcp(value) {
  return /not found|does not exist|no mcp server|not configured|unknown server/i.test(value);
}

function bounded(value) {
  const text = value.trim();
  return text.length > 500 ? `${text.slice(0, 500)}…` : text;
}
