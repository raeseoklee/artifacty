import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

const DEFAULT_LABEL = "com.artifacty.server";

export async function serviceCommand(action, options = {}) {
  const plistPath = path.resolve(options.plistPath || path.join(homedir(), "Library", "LaunchAgents", `${DEFAULT_LABEL}.plist`));
  const plist = createLaunchAgentPlist(options);

  if (action === "plist") {
    return { action, path: plistPath, content: plist, dryRun: true };
  }

  if (action === "install") {
    const existing = await readFile(plistPath, "utf8").catch(() => "");
    const changed = existing !== plist;
    if (!options.dryRun) {
      await mkdir(path.dirname(plistPath), { recursive: true });
      await writeFile(plistPath, plist, "utf8");
    }
    return {
      action,
      path: plistPath,
      changed,
      dryRun: Boolean(options.dryRun),
      content: options.dryRun ? plist : undefined,
      nextSteps: [
        `launchctl load ${plistPath}`,
        `launchctl unload ${plistPath}`
      ]
    };
  }

  if (action === "uninstall") {
    const existed = existsSync(plistPath);
    if (!options.dryRun) {
      await rm(plistPath, { force: true });
    }
    return {
      action,
      path: plistPath,
      changed: existed,
      dryRun: Boolean(options.dryRun)
    };
  }

  throw new Error("service requires action: plist, install, or uninstall");
}

export function createLaunchAgentPlist(options = {}) {
  const projectDir = path.resolve(options.projectDir || process.cwd());
  const nodePath = process.execPath;
  const serverPath = path.resolve(options.serverPath || path.join(projectDir, "src", "server.js"));
  const host = options.host || process.env.ARTIFACTY_HOST || "127.0.0.1";
  const port = options.port || process.env.ARTIFACTY_PORT;
  const home = path.resolve(options.home || process.env.ARTIFACTY_HOME || path.join(homedir(), ".artifacty"));
  const logDir = path.join(home, "logs");
  const portArguments = port
    ? `    <string>--port</string>
    <string>${escapeXml(port)}</string>
`
    : "";

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${DEFAULT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(nodePath)}</string>
    <string>${escapeXml(serverPath)}</string>
    <string>--host</string>
    <string>${escapeXml(host)}</string>
${portArguments}    <string>--home</string>
    <string>${escapeXml(home)}</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>ARTIFACTY_HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${escapeXml(path.join(logDir, "server.out.log"))}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(path.join(logDir, "server.err.log"))}</string>
</dict>
</plist>
`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
