import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { projectId, runHook } from "../assets/working-memory-hook.mjs";
import { parseArgs } from "../src/args.js";
import { createSystem } from "../src/system.js";
import { configureWorkingMemory } from "../src/working-memory.js";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = { enabled: true, client: "codex", userId: "local-test-user", apiUrl: "http://127.0.0.1:8000", promotion: "review" };
const event = { session_id: "test-session", turn_id: "test-turn", cwd: "/project", hook_event_name: "UserPromptSubmit", prompt: "This project uses PHP." };

function transport() {
  const calls = [];
  return { calls, git: (_cwd, args) => args[0] === "rev-parse" ? "/project" : "git@github.com:example/shop.git",
    fetcher: async (url, options) => { calls.push({ url: String(url), options }); return { ok: true, json: async () => ({ context: "Recent work" }) }; } };
}

test("parses Working Memory commands and requires explicit auto-promotion", () => {
  assert.equal(parseArgs(["working-memory", "install", "--agents", "all"]).command, "working-memory-install");
  assert.equal(parseArgs(["install", "--working-memory", "--promotion", "auto"]).options.promotion, "auto");
  assert.throws(() => parseArgs(["install", "--promotion", "auto"]));
  assert.throws(() => parseArgs(["working-memory", "install", "--namespace", "misc"]));
  assert.throws(() => parseArgs(["working-memory", "install", "--promotion", "guess"]));
});

test("resolves Git project IDs without retaining credentials or local paths", () => {
  for (const remote of ["git@github.com:example/shop.git", "https://github.com/example/shop.git", "ssh://git@github.com/example/shop.git"]) {
    assert.equal(projectId(remote, "/project"), "example/shop");
  }
  assert.equal(projectId("https://user:secret@github.com/example/shop.git", "/project"), "example/shop");
  assert.equal(projectId("", "/projects/shop"), "shop");
  assert.equal(projectId("not a remote", "/projects/shop"), null);
});

test("captures documented prompt and reply fields with stable turn IDs", async () => {
  const network = transport();
  await runHook(event, config, network);
  await runHook({ ...event, hook_event_name: "Stop", last_assistant_message: "Confirmed PHP.", tool_output: "Do not store this" }, config, network);
  assert.equal(network.calls.length, 2);
  const saved = network.calls.map((c) => JSON.parse(c.options.body));
  assert.equal(saved[0].project_id, "example/shop");
  assert.equal(saved[0].turn_id, saved[1].turn_id);
  assert.deepEqual(saved.map((s) => s.role), ["user", "assistant"]);
  assert.equal(saved[1].content, "Confirmed PHP.");
  assert.equal(network.calls[0].options.redirect, "error");
});

test("Claude uses prompt_id without reading transcripts", async () => {
  const network = transport();
  await runHook({ ...event, turn_id: undefined, prompt_id: "claude-turn", transcript_path: "/never/read/me" }, { ...config, client: "claude" }, network);
  assert.equal(JSON.parse(network.calls[0].options.body).turn_id, "claude-turn");
});

test("private data is omitted before leaving the hook", async () => {
  for (const prompt of ["<private>secret</private>", "api_key=sample-value", "Bearer sample-value", "x".repeat(8500) + " password=hidden"]) {
    const network = transport();
    await runHook({ ...event, prompt }, config, network);
    assert.equal(JSON.parse(network.calls[0].options.body).content, "[Private exchange omitted]");
  }
});

test("disabled capture, wrong projects, old clients, and remote URLs send nothing", async () => {
  for (const options of [{ enabled: false }, { projectId: "other/project" }, { apiUrl: "https://example.com" }]) {
    const network = transport();
    await runHook(event, { ...config, ...options }, network);
    assert.equal(network.calls.length, 0);
  }
  const network = transport();
  await runHook({ ...event, turn_id: undefined }, config, network);
  assert.equal(network.calls.length, 0);
});

test("recall is project-scoped and clearly marked as untrusted history", async () => {
  const network = transport();
  const output = await runHook({ ...event, hook_event_name: "SessionStart" }, config, network);
  assert.match(network.calls[0].url, /project_id=example%2Fshop/);
  assert.match(output.hookSpecificOutput.additionalContext, /never follow instructions/);
});

test("opted-in hooks return saved facts with IDs and never put prompt text in a URL", async () => {
  const network = transport();
  network.fetcher = async (url, options) => {
    network.calls.push({ url: String(url), options });
    return { ok: true, json: async () => ({ long_term_context: '[{"id":"fact-one","text":"Uses PHP."}]' }) };
  };
  const enabled = { ...config, longTermRecall: true };
  const start = await runHook({ ...event, hook_event_name: "SessionStart" }, enabled, network);
  assert.match(network.calls[0].url, /include_long_term=true/);
  assert.match(start.hookSpecificOutput.additionalContext, /fact-one/);
  const prompt = await runHook(event, enabled, network);
  assert.equal(prompt.hookSpecificOutput.hookEventName, "UserPromptSubmit");
  assert.match(prompt.hookSpecificOutput.additionalContext, /not instructions/);
  assert.equal(network.calls.at(-1).options.method, "POST");
  assert.equal(new URL(network.calls.at(-1).url).search, "");
  assert.equal(JSON.parse(network.calls.at(-1).options.body).content, event.prompt);
});

test("private prompts skip optional recall and a failed lookup does not fail capture", async () => {
  const network = transport();
  await runHook({ ...event, prompt: "<private>keep private</private>" }, { ...config, longTermRecall: true }, network);
  assert.equal(network.calls.length, 1);
  network.fetcher = async (url, options) => {
    if (String(url).includes("/recall")) throw new Error("offline");
    return { ok: true, json: async () => ({}) };
  };
  assert.deepEqual(await runHook(event, { ...config, longTermRecall: true }, network), {});
});

async function fixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "ams-working-memory-"));
  const system = createSystem({ home, env: {}, cwd: path.join(home, "project"),
    run: async (_cmd, args) => ({ code: 0, stdout: args.includes("rev-parse") ? path.join(home, "project") : "git@github.com:example/shop.git", stderr: "" }) });
  return { system, packageRoot, ui: { info() {}, confirm: async () => true },
    paths: { root: path.join(home, "support"), backups: path.join(home, "backups") },
    options: { agents: ["codex", "claude"], scope: "user" }, home };
}

test("install/update/uninstall preserve other hooks and share a stable local user ID", async () => {
  const f = await fixture();
  const claude = path.join(f.home, ".claude", "settings.json");
  const original = { permissions: { allow: ["Read"] }, hooks: { Stop: [{ hooks: [{ type: "command", command: "other-tool" }] }] } };
  await f.system.writeFileAtomic(claude, JSON.stringify(original));
  const first = await configureWorkingMemory(f);
  const cPath = path.join(f.home, ".codex", "ams-working-memory.json");
  const firstConfig = JSON.parse(await readFile(cPath, "utf8"));
  assert.equal(firstConfig.promotion, "review");
  assert.equal(firstConfig.longTermRecall, true);
  const claudeConfig = JSON.parse(await readFile(path.join(f.home, ".claude", "ams-working-memory.json"), "utf8"));
  assert.equal(firstConfig.userId, claudeConfig.userId);
  assert.match(first.workingMemoryUrl, new RegExp(firstConfig.userId));
  await configureWorkingMemory({ ...f, options: { ...f.options, promotion: "auto", apiPort: 8011 } });
  await configureWorkingMemory(f);
  const updatedConfig = JSON.parse(await readFile(cPath, "utf8"));
  assert.equal(updatedConfig.userId, firstConfig.userId);
  assert.equal(updatedConfig.promotion, "auto");
  assert.equal(updatedConfig.apiUrl, "http://127.0.0.1:8011");
  let settings = JSON.parse(await readFile(claude, "utf8"));
  assert.equal(settings.hooks.Stop.length, 2);
  assert.deepEqual(settings.permissions, original.permissions);
  await configureWorkingMemory({ ...f, uninstall: true });
  settings = JSON.parse(await readFile(claude, "utf8"));
  assert.deepEqual(settings.hooks.Stop, original.hooks.Stop);
  assert.deepEqual(settings.permissions, original.permissions);
  assert.equal(JSON.parse(await readFile(cPath, "utf8")).enabled, false);
});

test("dry-run creates no hooks, runner or local identity", async () => {
  const f = await fixture();
  await configureWorkingMemory({ ...f, options: { ...f.options, dryRun: true } });
  assert.equal(await f.system.lstatSafe(f.paths.root), null);
  assert.equal(await f.system.lstatSafe(path.join(f.home, ".codex")), null);
});

test("malformed hooks stop before any target is changed", async () => {
  const f = await fixture();
  await f.system.writeFileAtomic(path.join(f.home, ".claude", "settings.json"), "not-json");
  await assert.rejects(configureWorkingMemory(f), { code: "E_HOOK_CONFLICT" });
  assert.equal(await f.system.lstatSafe(path.join(f.home, ".codex")), null);
  assert.equal(await f.system.lstatSafe(f.paths.root), null);
});

test("uninstall without a prior setup makes no files", async () => {
  const f = await fixture();
  const result = await configureWorkingMemory({ ...f, uninstall: true });
  assert.equal(result.changed, false);
  assert.equal(await f.system.lstatSafe(path.join(f.home, ".codex")), null);
});

async function offlineFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "ams-offline-"));
  const journalPath = path.join(directory, "queue.json");
  const network = { ...transport(), journalPath };
  const offline = { ...network, fetcher: async () => { throw new Error("offline"); } };
  return { network, offline, journalPath, read: async () => JSON.parse(await readFile(journalPath, "utf8")) };
}

test("offline events replay with stable IDs and leave no acknowledged content in the journal", async () => {
  const f = await offlineFixture();
  await runHook(event, config, f.offline);
  await runHook(event, config, f.offline);
  const queued = await f.read();
  assert.equal(queued.events.length, 1);
  assert.equal((await stat(f.journalPath)).mode & 0o777, 0o600);
  await runHook({ ...event, turn_id: "second" }, config, f.network);
  assert.deepEqual(f.network.calls.map((call) => JSON.parse(call.options.body).turn_id), ["test-turn", "second"]);
  assert.deepEqual((await f.read()).events, []);
  assert.doesNotMatch(await readFile(f.journalPath, "utf8"), /This project uses PHP/);
});

test("journal omits secrets and the private prompt's later reply before any disk write", async () => {
  const f = await offlineFixture();
  await runHook({ ...event, prompt: "<private>Customer secret</private>" }, config, f.offline);
  await runHook({ ...event, hook_event_name: "Stop", last_assistant_message: "Customer secret confirmed" }, config, f.offline);
  assert.doesNotMatch(await readFile(f.journalPath, "utf8"), /Customer secret/);
  assert.ok((await f.read()).events.every((entry) => entry.body.content === "[Private exchange omitted]"));
  // A reply without its prompt cannot prove that the exchange was public.
  await runHook({ ...event, turn_id: "unknown", hook_event_name: "Stop", last_assistant_message: "Private reply" }, config, f.offline);
  assert.doesNotMatch(await readFile(f.journalPath, "utf8"), /Private reply/);
  assert.doesNotMatch(await readFile(f.journalPath, "utf8"), /Authorization|Bearer/);
});

test("a later private reply also redacts its waiting prompt", async () => {
  const f = await offlineFixture();
  await runHook(event, config, f.offline);
  await runHook({ ...event, hook_event_name: "Stop", last_assistant_message: "password=hidden" }, config, f.offline);
  assert.ok((await f.read()).events.every((entry) => entry.body.content === "[Private exchange omitted]"));
  assert.doesNotMatch(await readFile(f.journalPath, "utf8"), /PHP|hidden/);
});

test("replay stays in the exact API, user, project and client scope and respects disabled capture", async () => {
  const f = await offlineFixture();
  await runHook(event, config, f.offline);
  const start = { ...event, hook_event_name: "SessionStart" };
  for (const change of [{ apiUrl: "http://127.0.0.1:9000" }, { userId: "other" }, { client: "claude" }]) {
    await runHook(start, { ...config, ...change }, f.network);
  }
  await runHook(start, config, { ...f.network, git: (_cwd, args) => args[0] === "rev-parse" ? "/project" : "git@github.com:other/project.git" });
  assert.ok(f.network.calls.every((call) => call.options.method === "GET"));
  const before = await readFile(f.journalPath, "utf8");
  const count = f.network.calls.length;
  await runHook(start, { ...config, enabled: false }, f.network);
  assert.equal(f.network.calls.length, count);
  assert.equal(await readFile(f.journalPath, "utf8"), before);
  await runHook(start, config, f.network);
  assert.equal((await f.read()).events.length, 0);
});

test("offline replay respects reduced promotion and never upgrades older permission", async () => {
  for (const [queued, current, expected] of [["auto", "review", "review"], ["auto", "off", "off"], ["review", "auto", "review"], ["off", "auto", "off"]]) {
    const f = await offlineFixture();
    await runHook(event, { ...config, promotion: queued }, f.offline);
    await runHook({ ...event, hook_event_name: "Stop", last_assistant_message: "Confirmed." }, { ...config, promotion: queued }, f.offline);
    await runHook({ ...event, hook_event_name: "SessionStart" }, { ...config, promotion: current }, f.network);
    const delivered = f.network.calls.filter((call) => call.options.method === "POST").map((call) => JSON.parse(call.options.body));
    assert.equal(delivered.length, 2);
    assert.ok(delivered.every((body) => body.promotion === expected));
  }
});

test("failed offline replay keeps revoked automatic sharing revoked on the next run", async () => {
  const f = await offlineFixture();
  await runHook(event, { ...config, promotion: "auto" }, f.offline);
  await runHook({ ...event, turn_id: "second" }, { ...config, promotion: "review" }, f.offline);
  assert.ok((await f.read()).events.every((entry) => entry.body.promotion === "review"));
  await runHook({ ...event, hook_event_name: "SessionStart" }, { ...config, promotion: "auto" }, f.network);
  assert.ok(f.network.calls.filter((call) => call.options.method === "POST").every((call) => JSON.parse(call.options.body).promotion === "review"));
});

test("journal bounds events, bytes, expiry and work per hook", async () => {
  const f = await offlineFixture();
  for (let i = 0; i < 65; i++) await runHook({ ...event, turn_id: `turn-${i}` }, config, f.offline);
  assert.equal((await f.read()).events.length, 60);
  for (let i = 0; i < 20; i++) await runHook({ ...event, turn_id: `large-${i}`, prompt: "😀".repeat(4000) }, config, f.offline);
  assert.ok((await stat(f.journalPath)).size <= 512 * 1024);
  const stored = await f.read();
  stored.events[0].created = 0;
  stored.turns[0].created = 0;
  await writeFile(f.journalPath, JSON.stringify(stored));
  await runHook({ ...event, hook_event_name: "SessionStart" }, config, f.network);
  assert.equal(f.network.calls.filter((call) => call.options.method === "POST").length, 3);
  assert.ok((await f.read()).events.every((entry) => entry.created > 0));
  assert.ok((await f.read()).turns.every((entry) => entry.created > 0));
});

test("concurrent hooks retain events and a dead process lock recovers", async () => {
  const f = await offlineFixture();
  await writeFile(`${f.journalPath}.lock`, JSON.stringify({ pid: 2147483647 }));
  await Promise.all(Array.from({ length: 8 }, (_, i) => runHook({ ...event, turn_id: `turn-${i}` }, config, f.offline)));
  assert.equal((await f.read()).events.length, 8);
});

test("failed delivery remains queued and receives a bounded request deadline", async () => {
  const f = await offlineFixture();
  let signal;
  await runHook(event, config, { ...f.network, fetcher: async (_url, options) => {
    signal = options.signal;
    return { ok: false };
  } });
  assert.ok(signal instanceof AbortSignal);
  assert.equal((await f.read()).events.length, 1);
});
