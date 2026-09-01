import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const PACKAGE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const REPOSITORY_ROOT = path.resolve(PACKAGE_ROOT, "../..");
const AMS = path.join(REPOSITORY_ROOT, "ams");

test("the root ams launcher is executable and works outside the repository", async () => {
  const workingDirectory = await mkdtemp(path.join(os.tmpdir(), "ams-launcher-"));
  const file = await stat(AMS);

  assert.notEqual(file.mode & 0o111, 0);
  const result = await execFileAsync(AMS, ["--version"], {
    cwd: workingDirectory,
  });
  assert.equal(result.stdout.trim(), "0.1.0");
});

test("the root ams launcher shows the Docker helper commands", async () => {
  const result = await execFileAsync(AMS, ["--help"]);

  assert.match(result.stdout, /Usage:\n  \.\/ams/);
  assert.match(result.stdout, /docker:install/);
  assert.match(result.stdout, /docker:up/);
  assert.match(result.stdout, /docker:restart app/);
  assert.match(result.stdout, /docker:reset \[--force\]/);
});

test("Docker restart help does not require the app target", async () => {
  const result = await execFileAsync(AMS, ["docker:restart", "--help"]);

  assert.match(result.stdout, /docker:restart app/);
});
