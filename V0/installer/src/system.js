import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmod,
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  symlink,
} from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

export function createSystem(overrides = {}) {
  const system = {
    cwd: process.cwd(),
    env: process.env,
    fetch: globalThis.fetch,
    home: os.homedir(),
    input: process.stdin,
    now: () => new Date(),
    output: process.stdout,
    platform: process.platform,
    run: runProcess,
    ...overrides,
  };

  return {
    ...system,
    chmod,
    copyDirectory: (source, target) => cp(source, target, { recursive: true }),
    hash: (value) => createHash("sha256").update(value).digest("hex"),
    isPortAvailable: overrides.isPortAvailable ?? isPortAvailable,
    lstatSafe,
    mkdir: (target, options = {}) => mkdir(target, { recursive: true, ...options }),
    move: rename,
    readFile,
    realpath,
    symlink,
    writeFileAtomic,
  };
}

export async function runProcess(command, args = [], options = {}) {
  const stdio = options.stdio ?? "pipe";
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env,
    shell: false,
    stdio: stdio === "inherit" ? "inherit" : ["ignore", "pipe", "pipe"],
  });

  if (stdio === "inherit") {
    return new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code) => resolve({ code: code ?? 1, stderr: "", stdout: "" }));
    });
  }

  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });

  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code) => resolve({ code: code ?? 1, stderr, stdout }));
  });
}

async function writeFileAtomic(target, content, mode = 0o644) {
  await mkdir(path.dirname(target), { recursive: true });
  const temporary = path.join(
    path.dirname(target),
    `.${path.basename(target)}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const handle = await open(temporary, "wx", mode);
  try {
    await handle.writeFile(content, "utf8");
  } finally {
    await handle.close();
  }
  await rename(temporary, target);
  await chmod(target, mode);
}

async function lstatSafe(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host: "127.0.0.1", port }, () => {
      server.close(() => resolve(true));
    });
  });
}
