import path from "node:path";
import { fileURLToPath } from "node:url";

import { detectAgents } from "./agents.js";
import { helpText, parseArgs } from "./args.js";
import { asInstallerError, InstallerError } from "./errors.js";
import { Installer } from "./installer.js";
import { createPrompter } from "./prompts.js";
import { createSystem } from "./system.js";

export const CLI_VERSION = "0.1.0";

export async function main(argv, dependencies = {}) {
  const system = dependencies.system ?? createSystem();
  const packageRoot = dependencies.packageRoot
    ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  let parsed;

  try {
    parsed = parseArgs(argv);
    if (parsed.options.help) {
      system.output.write(helpText());
      return 0;
    }
    if (parsed.options.version) {
      system.output.write(`${CLI_VERSION}\n`);
      return 0;
    }

    assertNodeVersion();
    const prompter = dependencies.prompter ?? createPrompter(system.input, system.output);
    const ui = createUi(system, prompter, parsed.options);
    const installer = new Installer({ packageRoot, system, ui });
    const hasSavedInstall = await installer.hasSavedInstall();
    await resolveGuidedOptions(
      parsed.command,
      parsed.options,
      system,
      prompter,
      hasSavedInstall,
    );
    const result = await installer.run(parsed.command, parsed.options);
    printResult(system, parsed.command, parsed.options, result);
    return exitCodeForResult(parsed.command, result);
  } catch (cause) {
    const error = asInstallerError(cause);
    if (parsed?.options?.json) {
      system.output.write(`${JSON.stringify({
        code: error.code,
        hint: error.hint,
        message: error.message,
        ok: false,
      })}\n`);
    } else {
      system.output.write(`\nError: ${error.message}\n`);
      if (error.hint) {
        system.output.write(`Next: ${error.hint}\n`);
      }
      system.output.write(`Code: ${error.code}\n`);
    }
    return exitCodeForError(error.code);
  }
}

async function resolveGuidedOptions(command, options, system, prompter, hasSavedInstall) {
  if (command !== "install" || hasSavedInstall) {
    return;
  }

  const interactive = !options.nonInteractive && system.input.isTTY && system.output.isTTY;
  if (!options.scope) {
    options.scope = interactive
      ? await prompter.select(
          "Where should the Skill and MCP setup be installed?",
          [
            { label: "All projects for this user", value: "user" },
            { label: "Only the current project", value: "project" },
          ],
        )
      : "user";
  }

  if (!options.agents) {
    const detected = await detectAgents(system);
    if (interactive && detected.length === 2) {
      options.agents = await prompter.select(
        "Which agents should use shared memory?",
        [
          { label: "Codex and Claude", value: ["codex", "claude"] },
          { label: "Codex only", value: ["codex"] },
          { label: "Claude only", value: ["claude"] },
        ],
      );
    } else if (detected.length > 0) {
      options.agents = detected;
    }
  }

  if (!system.env.OPENAI_API_KEY && interactive) {
    const wantsKey = await prompter.confirm(
      "Add an OpenAI API key now for the default model and embeddings?",
      false,
    );
    if (wantsKey) {
      options.openaiApiKey = await prompter.secret("OpenAI API key");
    }
  }
}

function createUi(system, prompter, options) {
  const quiet = options.json;
  return {
    confirm(message, defaultYes) {
      if (options.yes) {
        return true;
      }
      if (options.nonInteractive || !system.input.isTTY || !system.output.isTTY) {
        throw new InstallerError(
          "E_CONFIRM_REQUIRED",
          "The install plan needs confirmation.",
          "Run again with --yes, or use an interactive terminal.",
        );
      }
      return prompter.confirm(message, defaultYes);
    },
    info(message) {
      if (!quiet) {
        system.output.write(`${message}\n`);
      }
    },
    warn(message) {
      if (!quiet) {
        system.output.write(`Warning: ${message}\n`);
      }
    },
  };
}

function printResult(system, command, options, result) {
  if (options.json) {
    system.output.write(`${JSON.stringify(result)}\n`);
    return;
  }

  if (result.cancelled) {
    system.output.write("No changes made.\n");
    return;
  }
  if (result.dryRun) {
    system.output.write("Dry run finished. No changes made.\n");
    return;
  }
  if (command === "doctor") {
    system.output.write("\nDoctor checks\n");
    for (const check of result.checks) {
      system.output.write(`${check.ok ? "OK" : "FAIL"}  ${check.name}${check.detail ? ` — ${check.detail}` : ""}\n`);
    }
    return;
  }
  if (command === "status") {
    if (!result.installed) {
      system.output.write("Agent Memory is not installed.\n");
      return;
    }
    system.output.write(`Agent Memory phase: ${result.phase}\n`);
    system.output.write(`REST health: ${result.apiHealthy ? "healthy" : "not healthy"}\n`);
    return;
  }
  if (["install", "update"].includes(command)) {
    system.output.write("\nAgent Memory is ready.\n");
    system.output.write(`REST: ${result.apiUrl}\n`);
    system.output.write(`MCP:  ${result.mcpUrl}\n`);
    if (!result.providerConfigured) {
      system.output.write("Add OPENAI_API_KEY before using model-backed memory features.\n");
    }
    return;
  }
  if (command === "uninstall") {
    system.output.write("Installer-owned setup removed. Redis memory data and secrets were kept.\n");
    for (const warning of result.warnings ?? []) {
      system.output.write(`Warning: ${warning}\n`);
    }
    return;
  }
  if (result.status) {
    system.output.write(`Agent Memory ${result.status}.\n`);
  }
}

function assertNodeVersion() {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 20) {
    throw new InstallerError(
      "E_NODE_VERSION",
      `Node.js ${process.versions.node} is too old.`,
      "Install Node.js 20 or newer.",
    );
  }
}

function exitCodeForResult(command, result) {
  if (command === "doctor" && !result.ok) {
    return 10;
  }
  if (command === "status" && !result.installed) {
    return 11;
  }
  return result.ok ? 0 : 6;
}

function exitCodeForError(code) {
  if (["E_BAD_AGENT", "E_BAD_COMMAND", "E_BAD_OPTION", "E_BAD_PORT", "E_BAD_SCOPE"].includes(code)) {
    return 2;
  }
  if (["E_COMPOSE_MISSING", "E_DOCKER_MISSING", "E_DOCKER_STOPPED", "E_NO_CLIENT", "E_NODE_VERSION"].includes(code)) {
    return 3;
  }
  if (["E_MCP_CONFLICT", "E_RECONFIGURE", "E_SKILL_CONFLICT"].includes(code)) {
    return 4;
  }
  if (code === "E_RELEASE_UNTRUSTED") {
    return 5;
  }
  if (code === "E_NOT_INSTALLED") {
    return 11;
  }
  return 6;
}
