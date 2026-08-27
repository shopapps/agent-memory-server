import path from "node:path";

import { InstallerError } from "./errors.js";

export const RULES_BLOCK_START = "<!-- >>> @umony/agent-memory shared-memory rules >>> -->";
export const RULES_BLOCK_END = "<!-- <<< @umony/agent-memory shared-memory rules <<< -->";

export async function rulesTargetPaths(system, agent, scope, projectDir) {
  if (!["codex", "claude"].includes(agent)) {
    throw new InstallerError("E_BAD_AGENT", `Unsupported agent: ${agent}`);
  }
  if (!["user", "project"].includes(scope)) {
    throw new InstallerError("E_BAD_SCOPE", `Unsupported scope: ${scope}`);
  }

  if (agent === "codex") {
    const root = scope === "project"
      ? projectDir
      : path.resolve(system.env.CODEX_HOME || path.join(system.home, ".codex"));
    const override = path.join(root, "AGENTS.override.md");
    if (await isNonEmptyFile(system, override)) {
      return [override];
    }
    return [path.join(root, "AGENTS.md")];
  }

  if (scope === "user") {
    const root = path.resolve(
      system.env.CLAUDE_CONFIG_DIR || path.join(system.home, ".claude"),
    );
    return [path.join(root, "CLAUDE.md")];
  }

  const rootTarget = path.join(projectDir, "CLAUDE.md");
  if (await system.lstatSafe(rootTarget)) {
    return [rootTarget];
  }
  const nestedTarget = path.join(projectDir, ".claude", "CLAUDE.md");
  if (await system.lstatSafe(nestedTarget)) {
    return [nestedTarget];
  }
  return [rootTarget];
}

export function renderRulesBlock(body, options = {}) {
  const newline = options.newline ?? "\n";
  const scopeLine = options.scope === "project"
    ? projectScopeLine(options.namespace)
    : globalScopeLine();
  const normalizedBody = body.replaceAll("\r\n", "\n").replace(/\n$/, "");
  const placeholders = normalizedBody.match(/\{\{PROJECT_SCOPE\}\}/g) ?? [];
  if (placeholders.length !== 1) {
    throw new InstallerError(
      "E_RULES_TEMPLATE",
      "The shared-memory rules template is invalid.",
    );
  }
  const renderedBody = normalizedBody.replace("{{PROJECT_SCOPE}}", scopeLine);
  return [RULES_BLOCK_START, renderedBody, RULES_BLOCK_END]
    .join("\n")
    .replaceAll("\n", newline);
}

export async function inspectRulesFile(system, target, body, options = {}) {
  const file = await readRulesFile(system, target, options);
  if (!file.exists) {
    return {
      actualPath: file.actualPath,
      fileHash: null,
      status: "absent",
      target,
    };
  }
  const managed = managedRulesRange(file.content, target);
  if (!managed) {
    return {
      actualPath: file.actualPath,
      fileHash: system.hash(file.content),
      status: "absent",
      target,
    };
  }
  const expected = renderRulesBlock(body, {
    ...options,
    newline: newlineFor(file.content),
  });
  const current = file.content.slice(managed.start, managed.end);
  return {
    actualPath: file.actualPath,
    blockHash: system.hash(current),
    fileHash: system.hash(file.content),
    status: current === expected ? "matching" : "outdated",
    target,
  };
}

export async function upsertRulesFile(system, target, body, options = {}) {
  const file = await readRulesFile(system, target, options);
  if (
    options.expectedActualPath
    && path.resolve(file.actualPath) !== path.resolve(options.expectedActualPath)
  ) {
    throw new InstallerError(
      "E_RULES_CHANGED",
      `The rules file link changed while it was being updated: ${target}`,
      "Check the file link, then run the command again.",
    );
  }
  if (Object.hasOwn(options, "expectedFileHash")) {
    const actualHash = file.exists ? system.hash(file.content) : null;
    if (actualHash !== options.expectedFileHash) {
      throw new InstallerError(
        "E_RULES_CHANGED",
        `The rules file changed while it was being updated: ${target}`,
        "Run the command again after the other edit is finished.",
      );
    }
  }
  const newline = newlineFor(file.content);
  const block = renderRulesBlock(body, { ...options, newline });
  const managed = managedRulesRange(file.content, target);
  let content;
  let placement = options.placement ?? { prefix: "", suffix: "" };

  if (managed) {
    if (file.content.slice(managed.start, managed.end) === block) {
      return {
        actualPath: file.actualPath,
        changed: false,
        created: false,
        hash: system.hash(block),
        placement,
        target,
      };
    }
    content = file.content.slice(0, managed.start) + block + file.content.slice(managed.end);
  } else {
    const appended = appendBlock(file.content, block, newline);
    content = appended.content;
    placement = appended.placement;
  }

  if (file.exists) {
    const latest = await readUtf8(system, file.actualPath, target);
    if (latest !== file.content) {
      throw new InstallerError(
        "E_RULES_CHANGED",
        `The rules file changed while it was being updated: ${target}`,
        "Run the command again after the other edit is finished.",
      );
    }
  } else if (await system.lstatSafe(file.actualPath)) {
    throw new InstallerError(
      "E_RULES_CHANGED",
      `The rules file appeared while it was being updated: ${target}`,
      "Run the command again so the new file can be checked.",
    );
  }
  await system.writeFileAtomic(file.actualPath, content, file.mode);
  const writtenActualPath = await system.realpath(file.actualPath);
  return {
    actualPath: writtenActualPath,
    changed: true,
    created: !file.exists,
    hash: system.hash(block),
    placement,
    target,
    undo: {
      actualPath: writtenActualPath,
      previousContent: file.content,
      previousExisted: file.exists,
      previousMode: file.mode,
      target,
      writtenHash: system.hash(content),
    },
  };
}

export async function rollbackRulesFile(system, result, backupDir) {
  if (!result.undo) {
    return true;
  }
  const undo = result.undo;
  if (undo.backupPath) {
    if (await system.lstatSafe(undo.actualPath)) {
      return false;
    }
    const backupStat = await system.lstatSafe(undo.backupPath);
    if (!backupStat?.isFile()) {
      return false;
    }
    await system.move(undo.backupPath, undo.actualPath);
    return true;
  }
  const stat = await system.lstatSafe(undo.actualPath);
  if (!stat?.isFile()) {
    return false;
  }
  const current = await readUtf8(system, undo.actualPath, undo.target);
  if (system.hash(current) !== undo.writtenHash) {
    return false;
  }
  if (undo.previousExisted) {
    await system.writeFileAtomic(
      undo.actualPath,
      undo.previousContent,
      undo.previousMode,
    );
    return true;
  }

  await system.mkdir(backupDir);
  const backup = path.join(
    backupDir,
    `${path.basename(undo.actualPath)}-${system.now().toISOString().replaceAll(":", "-")}`,
  );
  await system.move(undo.actualPath, backup);
  return true;
}

export async function removeRulesFile(system, target, options = {}) {
  const file = await readRulesFile(system, target, options);
  if (!file.exists) {
    if (options.expectedActualPath || options.expectedBlockHash) {
      throw rulesChanged(target, "The saved rules file no longer exists.");
    }
    return false;
  }
  if (
    options.expectedActualPath
    && path.resolve(file.actualPath) !== path.resolve(options.expectedActualPath)
  ) {
    throw rulesChanged(target, "Its link now points to a different file.");
  }
  const managed = managedRulesRange(file.content, target);
  if (!managed) {
    if (options.expectedBlockHash) {
      throw rulesChanged(target, "The installer-owned block is missing.");
    }
    return { changed: false, target };
  }
  const currentBlock = file.content.slice(managed.start, managed.end);
  if (
    options.expectedBlockHash
    && system.hash(currentBlock) !== options.expectedBlockHash
  ) {
    throw rulesChanged(target, "The installer-owned block was edited after install.");
  }
  const latest = await readUtf8(system, file.actualPath, target);
  if (latest !== file.content) {
    throw new InstallerError(
      "E_RULES_CHANGED",
      `The rules file changed while it was being updated: ${target}`,
    );
  }
  const placement = options.placement ?? { prefix: "", suffix: "" };
  const start = managed.start - placement.prefix.length;
  const end = managed.end + placement.suffix.length;
  if (
    start < 0
    || file.content.slice(start, managed.start) !== placement.prefix
    || file.content.slice(managed.end, end) !== placement.suffix
  ) {
    throw rulesChanged(target, "Text beside the installer-owned block changed after install.");
  }
  const content = file.content.slice(0, start) + file.content.slice(end);
  if (options.created && content === "") {
    if (!options.backupDir) {
      throw new InstallerError(
        "E_RULES_BACKUP",
        "The installer needs a backup folder before removing its rules file.",
      );
    }
    await system.mkdir(options.backupDir);
    const backupPath = path.join(
      options.backupDir,
      `${path.basename(file.actualPath)}-${system.now().toISOString().replaceAll(":", "-")}`,
    );
    await system.move(file.actualPath, backupPath);
    return {
      actualPath: file.actualPath,
      changed: true,
      target,
      undo: {
        actualPath: file.actualPath,
        backupPath,
        target,
      },
    };
  }
  await system.writeFileAtomic(file.actualPath, content, file.mode);
  return {
    actualPath: file.actualPath,
    changed: true,
    target,
    undo: {
      actualPath: file.actualPath,
      previousContent: file.content,
      previousExisted: true,
      previousMode: file.mode,
      target,
      writtenHash: system.hash(content),
    },
  };
}

export function defaultProjectNamespace(projectDir) {
  const name = path.basename(path.resolve(projectDir));
  const namespace = name
    .normalize("NFKD")
    .replace(/[^A-Za-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return namespace || "project";
}

function projectScopeLine(namespace) {
  const value = validateNamespace(namespace);
  return `Use \`${value}\` as the project ID. If the memory tool has no project ID field, use \`${value}\` as the namespace.`;
}

function globalScopeLine() {
  return "For each Git repository, use its remote `owner/name` as the project ID. If there is no remote, use the repository folder name. If the memory tool has no project ID field, use the same value as the namespace.";
}

function validateNamespace(value) {
  if (
    typeof value !== "string"
    || value.length > 200
    || !/^[A-Za-z0-9][A-Za-z0-9._/-]*[A-Za-z0-9]$|^[A-Za-z0-9]$/.test(value)
    || value.includes("//")
    || value.split("/").some((part) => part === "." || part === "..")
  ) {
    throw new InstallerError(
      "E_BAD_NAMESPACE",
      "The namespace must use letters, numbers, dots, dashes, underscores, or single slashes.",
    );
  }
  return value;
}

async function isNonEmptyFile(system, target) {
  const stat = await system.lstatSafe(target);
  if (!stat) {
    return false;
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw rulesConflict(target, "It is not a normal Markdown file.");
  }
  return (await readUtf8(system, target, target)).trim().length > 0;
}

async function readRulesFile(system, target, options = {}) {
  const stat = await system.lstatSafe(target);
  if (!stat) {
    return {
      actualPath: target,
      content: "",
      exists: false,
      mode: 0o644,
    };
  }
  if (!stat.isFile() && !stat.isSymbolicLink()) {
    throw rulesConflict(target, "It is not a normal Markdown file.");
  }

  let actualPath = await system.realpath(target);
  let actualStat = stat;
  if (stat.isSymbolicLink()) {
    const allowedRoot = await system.realpath(
      path.resolve(options.allowedRoot ?? path.dirname(target)),
    );
    if (!isInside(allowedRoot, actualPath)) {
      throw rulesConflict(target, "Its link points outside the selected rules folder.");
    }
    actualStat = await system.lstatSafe(actualPath);
    if (!actualStat?.isFile()) {
      throw rulesConflict(target, "Its link does not point to a normal file.");
    }
  } else {
    const allowedRoot = await system.realpath(
      path.resolve(options.allowedRoot ?? path.dirname(target)),
    );
    if (!isInside(allowedRoot, actualPath)) {
      throw rulesConflict(target, "It is outside the selected rules folder.");
    }
  }

  return {
    actualPath,
    content: await readUtf8(system, actualPath, target),
    exists: true,
    mode: actualStat.mode & 0o777,
  };
}

async function readUtf8(system, actualPath, shownPath) {
  const bytes = await system.readFile(actualPath);
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw rulesConflict(shownPath, "It is not valid UTF-8 text.");
  }
}

function managedRulesRange(content, target) {
  const starts = markerMatches(content, RULES_BLOCK_START);
  const ends = markerMatches(content, RULES_BLOCK_END);
  const rawStarts = countOccurrences(content, RULES_BLOCK_START);
  const rawEnds = countOccurrences(content, RULES_BLOCK_END);
  if (starts.length === 0 && ends.length === 0) {
    if (rawStarts > 0 || rawEnds > 0) {
      throw rulesConflict(target, "Its managed markers must be on exact lines without extra spaces.");
    }
    return null;
  }
  if (
    starts.length !== 1
    || ends.length !== 1
    || rawStarts !== 1
    || rawEnds !== 1
    || starts[0] >= ends[0]
  ) {
    throw rulesConflict(target, "Its managed markers are missing, repeated, or out of order.");
  }
  return { start: starts[0], end: ends[0] + RULES_BLOCK_END.length };
}

function markerMatches(content, marker) {
  const escaped = marker.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return [...content.matchAll(new RegExp(`^${escaped}\\r?$`, "gm"))]
    .map((match) => match.index);
}

function appendBlock(content, block, newline) {
  if (!content) {
    return {
      content: block + newline,
      placement: { prefix: "", suffix: newline },
    };
  }
  const separator = content.endsWith(newline + newline)
    ? ""
    : content.endsWith(newline) ? newline : newline + newline;
  return {
    content: content + separator + block + newline,
    placement: { prefix: separator, suffix: newline },
  };
}

function countOccurrences(content, value) {
  return content.split(value).length - 1;
}

function newlineFor(content) {
  return content.includes("\r\n") ? "\r\n" : "\n";
}

function isInside(root, target) {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rulesConflict(target, detail) {
  return new InstallerError(
    "E_RULES_CONFLICT",
    `The installer cannot safely update ${target}.`,
    detail,
  );
}

function rulesChanged(target, detail) {
  return new InstallerError(
    "E_RULES_CHANGED",
    `The installer-owned rules changed at ${target}.`,
    detail,
  );
}
