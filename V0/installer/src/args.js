import { InstallerError } from "./errors.js";

const COMMANDS = new Set([
  "docker:install",
  "docker:reset",
  "docker:restart",
  "docker:up",
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
  ["--namespace", "namespace"],
  ["--api-port", "apiPort"],
  ["--mcp-port", "mcpPort"],
]);

export function parseArgs(argv) {
  const args = [...argv];
  let command = "install";
  let dockerTarget = null;

  if (args[0] === "rules") {
    args.shift();
    if (["--help", "-h"].includes(args[0])) {
      command = "rules-install";
    } else {
      const action = args.shift();
      if (!action || !["install", "uninstall", "update"].includes(action)) {
        throw new InstallerError(
          "E_BAD_COMMAND",
          `Unknown rules command: ${action ?? "missing"}`,
          "Use rules install, rules update, or rules uninstall.",
        );
      }
      command = `rules-${action}`;
    }
  } else if (args[0] && !args[0].startsWith("-")) {
    command = args.shift();
    if (!COMMANDS.has(command)) {
      throw new InstallerError(
        "E_BAD_COMMAND",
        `Unknown command: ${command}`,
        "Run with --help to see the available commands.",
      );
    }
  }

  if (command === "docker:restart") {
    const helpOrVersion = ["--help", "-h", "--version", "-v"].includes(args[0]);
    if (!helpOrVersion) {
      dockerTarget = args.shift();
    }
    if (!dockerTarget && !helpOrVersion) {
      throw new InstallerError(
        "E_BAD_OPTION",
        "docker:restart needs a target.",
        "Use docker:restart app.",
      );
    }
    if (!helpOrVersion && dockerTarget !== "app") {
      throw new InstallerError(
        "E_BAD_OPTION",
        `Unsupported Docker restart target: ${dockerTarget}`,
        "Use app to restart the API, MCP server, and worker while keeping Redis running.",
      );
    }
  }

  const options = {
    agents: null,
    agentsSpecified: false,
    apiPort: null,
    dryRun: false,
    dockerTarget,
    follow: false,
    force: false,
    help: false,
    json: false,
    mcpPort: null,
    namespace: null,
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
      const option = VALUE_FLAGS.get(flag);
      options[option] = value;
      if (option === "agents") {
        options.agentsSpecified = true;
      }
      continue;
    }

    switch (flag) {
      case "--dry-run":
        options.dryRun = true;
        break;
      case "--follow":
        options.follow = true;
        break;
      case "--force":
        options.force = true;
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
  validateDockerOptions(command, options);
  if (options.force && command !== "docker:reset") {
    throw new InstallerError(
      "E_BAD_OPTION",
      "--force can only be used with docker:reset.",
    );
  }
  if (options.scope && !["project", "user"].includes(options.scope)) {
    throw new InstallerError(
      "E_BAD_SCOPE",
      `Unsupported scope: ${options.scope}`,
      "Use user or project.",
    );
  }

  return { command, options };
}

function validateDockerOptions(command, options) {
  if (!command.startsWith("docker:")) {
    return;
  }
  if (command === "docker:reset" && options.yes) {
    throw new InstallerError(
      "E_BAD_OPTION",
      "docker:reset does not use --yes.",
      "Use --force to skip only the reset confirmation.",
    );
  }
  if (command === "docker:install") {
    return;
  }

  const unused = [];
  if (options.agentsSpecified) unused.push("--agents");
  if (options.scope) unused.push("--scope");
  if (options.projectDir) unused.push("--project-dir");
  if (options.namespace) unused.push("--namespace");
  if (options.apiPort !== null) unused.push("--api-port");
  if (options.mcpPort !== null) unused.push("--mcp-port");
  if (options.follow) unused.push("--follow");
  if (options.yes) unused.push("--yes");
  if (options.nonInteractive && command !== "docker:reset") {
    unused.push("--non-interactive");
  }
  if (unused.length > 0) {
    throw new InstallerError(
      "E_BAD_OPTION",
      `${unused.join(", ")} cannot be used with ${command}.`,
    );
  }
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

export function helpText(programName = "agent-memory") {
  return `Agent Memory local installer

Usage:
  ${programName} [command] [options]

Commands:
  docker:install  Build this checkout and safely install its app containers
  docker:up       Start the local Docker stack without rebuilding it
  docker:restart app  Restart the API, MCP server, and worker; keep Redis running
  docker:reset [--force]  Rebuild the stack but keep the Redis memory database
  install      Install or repair the runtime, Skill, MCP, and agent rules (default)
  rules install  Add safe shared-memory rules without changing the runtime
  rules update   Update only the installer-owned shared-memory rules
  rules uninstall Remove only installer-owned shared-memory rules
  status       Show the saved install and container state without changing it
  doctor       Run deeper read-only checks
  update       Pull and apply the release bundled with this CLI
  start        Start the managed Docker runtime
  stop         Stop the managed Docker runtime and keep its data
  logs         Show the last 200 Docker log lines
  uninstall    Remove installer-owned agent setup and keep memory data

Options:
  --agents <auto|all|codex,claude>  Agents to configure
  --scope <user|project>            Install globally for this user or in one project
  --project-dir <path>              Project directory for project scope
  --namespace <name>                Fixed memory name for project scope
  --api-port <port>                 Local REST port (default: 8000)
  --mcp-port <port>                 Local MCP port (default: 9050)
  --dry-run                         Show the plan without changing anything
  --non-interactive                 Never prompt
  --yes, -y                         Accept the safe install plan
  --json                            Print one JSON result
  --follow                          Follow logs instead of returning
  --force                           Skip only the docker:reset confirmation
  --help, -h                        Show this help
  --version, -v                     Show the CLI version
`;
}
