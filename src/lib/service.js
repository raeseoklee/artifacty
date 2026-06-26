import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir, platform as osPlatform } from "node:os";
import path from "node:path";

const DEFAULT_LABEL = "com.artifacty.server";
const DEFAULT_TASK_NAME = "ArtifactyServer";

export async function serviceCommand(action, options = {}) {
  const definition = serviceDefinition(action, options);

  if (definition.renderOnly) {
    return {
      action,
      platform: definition.platform,
      path: definition.path,
      content: definition.content,
      dryRun: true,
      nextSteps: definition.nextSteps
    };
  }

  if (action === "install") {
    const existing = await readFile(definition.path, "utf8").catch(() => "");
    const changed = existing !== definition.content;
    if (!options.dryRun) {
      await mkdir(path.dirname(definition.path), { recursive: true });
      await writeFile(definition.path, definition.content, "utf8");
    }
    return {
      action,
      platform: definition.platform,
      path: definition.path,
      changed,
      dryRun: Boolean(options.dryRun),
      content: options.dryRun ? definition.content : undefined,
      nextSteps: definition.nextSteps
    };
  }

  if (action === "uninstall") {
    const existed = existsSync(definition.path);
    if (!options.dryRun) {
      await rm(definition.path, { force: true });
    }
    return {
      action,
      platform: definition.platform,
      path: definition.path,
      changed: existed,
      dryRun: Boolean(options.dryRun),
      nextSteps: definition.uninstallSteps
    };
  }

  throw new Error("service requires action: plist, unit, task, install, or uninstall");
}

export function createLaunchAgentPlist(options = {}) {
  const config = serviceConfig(options);
  const programArguments = [config.nodePath, ...serverArgs(config)]
    .map((argument) => `    <string>${escapeXml(argument)}</string>`)
    .join("\n");
  const environment = environmentEntries(config)
    .map(([key, value]) => `    <key>${escapeXml(key)}</key>
    <string>${escapeXml(value)}</string>`)
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEFAULT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
${programArguments}
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${environment}
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(config.logDir, "server.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(config.logDir, "server.err.log"))}</string>
</dict>
</plist>
`;
}

export function createSystemdUserUnit(options = {}) {
  const config = serviceConfig(options);
  const environment = environmentEntries(config)
    .map(([key, value]) => `Environment=${systemdQuote(`${key}=${value}`)}`)
    .join("\n");
  const execStart = [config.nodePath, ...serverArgs(config)]
    .map(systemdQuote)
    .join(" ");

  return `[Unit]
Description=Artifacty local artifact server
After=network.target

[Service]
Type=simple
${environment}
ExecStart=${execStart}
Restart=on-failure
RestartSec=2

[Install]
WantedBy=default.target
`;
}

export function createWindowsTaskScript(options = {}) {
  const config = serviceConfig(options);
  const argumentsLine = serverArgs(config, { includeApiTokenArg: true })
    .map(quoteWindowsArg)
    .join(" ");

  return `$ErrorActionPreference = 'Stop'

$taskName = ${powershellString(config.taskName)}
$node = ${powershellString(config.nodePath)}
$arguments = ${powershellString(argumentsLine)}
$description = 'Artifacty local artifact server'

$action = New-ScheduledTaskAction -Execute $node -Argument $arguments
$trigger = New-ScheduledTaskTrigger -AtLogOn
$settings = New-ScheduledTaskSettingsSet -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries

Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Description $description -Force | Out-Null
Start-ScheduledTask -TaskName $taskName

Write-Host "Installed and started scheduled task '$taskName'."
Write-Host "Stop: schtasks /End /TN $taskName"
Write-Host "Remove: schtasks /Delete /TN $taskName /F"
`;
}

function serviceDefinition(action, options = {}) {
  if (action === "plist") {
    return definitionForPlatform("macos", options, true);
  }
  if (action === "unit") {
    return definitionForPlatform("linux", options, true);
  }
  if (action === "task") {
    return definitionForPlatform("windows", options, true);
  }
  if (action === "install" || action === "uninstall") {
    return definitionForPlatform(normalizePlatform(options.platform), options, false);
  }
  throw new Error("service requires action: plist, unit, task, install, or uninstall");
}

function definitionForPlatform(platform, options = {}, renderOnly) {
  const config = serviceConfig({ ...options, platform });
  if (platform === "macos") {
    return {
      platform,
      renderOnly,
      path: servicePath(platform, options),
      content: createLaunchAgentPlist(options),
      nextSteps: [
        `launchctl load ${shellQuote(servicePath(platform, options))}`,
        `launchctl unload ${shellQuote(servicePath(platform, options))}`
      ],
      uninstallSteps: [
        `launchctl unload ${shellQuote(servicePath(platform, options))}`
      ]
    };
  }
  if (platform === "linux") {
    return {
      platform,
      renderOnly,
      path: servicePath(platform, options),
      content: createSystemdUserUnit(options),
      nextSteps: [
        "systemctl --user daemon-reload",
        `systemctl --user enable --now ${path.basename(servicePath(platform, options))}`,
        `systemctl --user status ${path.basename(servicePath(platform, options))}`,
        `journalctl --user -u ${path.basename(servicePath(platform, options))} -f`,
        `systemctl --user disable --now ${path.basename(servicePath(platform, options))}`
      ],
      uninstallSteps: [
        "systemctl --user daemon-reload",
        `systemctl --user disable --now ${path.basename(servicePath(platform, options))}`
      ]
    };
  }
  if (platform === "windows") {
    return {
      platform,
      renderOnly,
      path: servicePath(platform, options),
      content: createWindowsTaskScript(options),
      nextSteps: [
        `powershell -ExecutionPolicy Bypass -File ${quoteWindowsArg(servicePath(platform, options))}`,
        `schtasks /Query /TN ${config.taskName}`,
        `schtasks /End /TN ${config.taskName}`,
        `schtasks /Delete /TN ${config.taskName} /F`
      ],
      uninstallSteps: [
        `schtasks /Delete /TN ${config.taskName} /F`
      ]
    };
  }
  throw new Error(`Unsupported service platform: ${platform}`);
}

function serviceConfig(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const home = path.resolve(options.home || process.env.ARTIFACTY_HOME || path.join(homedir(), ".artifacty"));
  return {
    projectDir,
    nodePath: path.resolve(options.nodePath || process.execPath),
    serverPath: path.resolve(options.serverPath || path.join(projectDir, "src", "server.js")),
    host: options.host || process.env.ARTIFACTY_HOST || "127.0.0.1",
    port: options.port !== undefined && options.port !== null ? String(options.port) : process.env.ARTIFACTY_PORT || "",
    home,
    logDir: path.join(home, "logs"),
    apiToken: options.apiToken || "",
    shareMode: options.shareMode || "",
    allowSecrets: Boolean(options.allowSecrets),
    taskName: options.taskName || DEFAULT_TASK_NAME
  };
}

function serverArgs(config, options = {}) {
  const args = [
    config.serverPath,
    "--host",
    config.host,
    "--home",
    config.home
  ];
  if (config.port) {
    args.push("--port", String(config.port));
  }
  if (config.shareMode) {
    args.push("--share-mode", config.shareMode);
  }
  if (config.allowSecrets) {
    args.push("--allow-secrets");
  }
  if (options.includeApiTokenArg && config.apiToken) {
    args.push("--api-token", config.apiToken);
  }
  return args;
}

function environmentEntries(config) {
  const entries = [["ARTIFACTY_HOME", config.home]];
  if (config.apiToken) {
    entries.push(["ARTIFACTY_API_TOKEN", config.apiToken]);
  }
  return entries;
}

function servicePath(platform, options = {}) {
  if (options.servicePath || options.path) {
    return path.resolve(options.servicePath || options.path);
  }
  if (platform === "macos") {
    return path.resolve(options.plistPath || path.join(homedir(), "Library", "LaunchAgents", `${DEFAULT_LABEL}.plist`));
  }
  if (platform === "linux") {
    return path.resolve(options.unitPath || path.join(homedir(), ".config", "systemd", "user", `${DEFAULT_LABEL}.service`));
  }
  if (platform === "windows") {
    const localAppData = process.env.LOCALAPPDATA || path.join(homedir(), "AppData", "Local");
    return path.resolve(options.scriptPath || path.join(localAppData, "Artifacty", "install-artifacty-server-task.ps1"));
  }
  throw new Error(`Unsupported service platform: ${platform}`);
}

function normalizePlatform(value = osPlatform()) {
  if (value === "darwin" || value === "mac" || value === "macos") {
    return "macos";
  }
  if (value === "win32" || value === "windows" || value === "win") {
    return "windows";
  }
  if (value === "linux") {
    return "linux";
  }
  throw new Error("service platform must be macos, linux, or windows");
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function systemdQuote(value) {
  return `"${String(value).replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

function powershellString(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function quoteWindowsArg(value) {
  const text = String(value);
  if (!/[\s"]/.test(text)) {
    return text;
  }
  return `"${text.replaceAll('"', '\\"')}"`;
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
