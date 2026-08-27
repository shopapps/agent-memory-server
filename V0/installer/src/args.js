import { InstallerError } from "./errors.js";

const COMMANDS = new Set([
  "doctor",
  "install",
  "logs",
  "start",
  "status",
  "stop",
  "uninstall",
  "update",
]);

const VALUE_FLAGS = new Map([
  ["--agents", "agents"],
  ["--target", "agents"],
  ["--scope", "scope"],
  ["--project-dir", "projectDir"],
  ["--api-port", "apiPort"],
  ["--mcp-port", "mcpPort"],
]);

export function parseArgs(argv) {
  const args = [...argv];
  let command = "install";

  if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
    if (!COMMANDS.has(command)) {
      throw new InstallerError(
        "E_BAD_COMMAND",
        `Unknown command: ${command}`,
        "Run with --help to see the available commands.",
      );
    }
  }

  const options = {
    agents: null,
    apiPort: null,
    dryRun: false,
    follow: false,
    help: false,
    json: false,
    mcpPort: null,
    nonInteractive: false,
    projectDir: null,
    scope: null,
    version: false,
    yes: false,
  };

  while (args.length > 0) {
    const flag = args.shift();

    if (VALUE_FLAGS.has(flag)) {
      const value = args.shift();
      if (!value || value.startsWith("--")) {
        throw new InstallerError("E_BAD_OPTION", `${flag} needs a value.`);
      }
      options[VALUE_FLAGS.get(flag)] = value;
      continue;
    }

    switch (flag) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--follow":
        options.follow = true;
        break;
      case "--help":
      case "-h":
        options.help = true;
        break;
      case "--json":
        options.json = true;
        break;
      case "--non-interactive":
        options.nonInteractive = true;
        break;
      case "--version":
      case "-v":
        options.version = true;
        break;
      case "--yes":
      case "-y":
        options.yes = true;
        break;
      default:
        throw new InstallerError(
          "E_BAD_OPTION",
          `Unknown option: ${flag}`,
          "Run with --help to see the available options.",
        );
    }
  }

  options.apiPort = options.apiPort === null
    ? null
    : parsePort(options.apiPort, "--api-port");
  options.mcpPort = options.mcpPort === null
    ? null
    : parsePort(options.mcpPort, "--mcp-port");
  options.agents = parseAgents(options.agents);
  if (options.scope && !["project", "user"].includes(options.scope)) {
    throw new InstallerError(
      "E_BAD_SCOPE",
      `Unsupported scope: ${options.scope}`,
      "Use user or project.",
    );
  }

  return { command, options };
}

function parsePort(value, flag) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new InstallerError("E_BAD_PORT", `${flag} must be between 1 and 65535.`);
  }
  return port;
}

function parseAgents(value) {
  if (!value || value === "auto") {
    return null;
  }
  if (value === "all") {
    return ["codex", "claude"];
  }

  const agents = [...new Set(value.split(",").map((item) => item.trim()))];
  const invalid = agents.filter((agent) => !["codex", "claude"].includes(agent));
  if (invalid.length > 0 || agents.length === 0) {
    throw new InstallerError(
      "E_BAD_AGENT",
      `Unsupported agent selection: ${value}`,
      "Use codex, claude, all, or a comma-separated list.",
    );
  }
  return agents;
}

export function helpText() {
  return `Agent Memory local installer

Usage:
  agent-memory [command] [options]

Commands:
  install      Install or repair the runtime, Skill, and MCP setup (default)
  status       Show the saved install and container state without changing it
  doctor       Run deeper read-only checks
  update       Pull and apply the release bundled with this CLI
  start        Start the managed Docker runtime
  stop         Stop the managed Docker runtime and keep its data
  logs         Show the last 200 Docker log lines
  uninstall    Remove installer-owned client setup and keep memory data

Options:
  --agents <auto|all|codex,claude>  Agents to configure
  --scope <user|project>            Install for this user or one project
  --project-dir <path>              Project directory for project scope
  --api-port <port>                 Local REST port (default: 8000)
  --mcp-port <port>                 Local MCP port (default: 9050)
  --dry-run                         Show the plan without changing anything
  --non-interactive                 Never prompt
  --yes, -y                         Accept the safe install plan
  --json                            Print one JSON result
  --follow                          Follow logs instead of returning
  --help, -h                        Show this help
  --version, -v                     Show the CLI version
`;
}
