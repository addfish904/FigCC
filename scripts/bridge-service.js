import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const LABEL = 'com.figcodex.bridge';
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, '.figcodex-data');
const SERVER_ENTRY = path.join(ROOT, 'bridge', 'server.js');
const STDOUT_LOG = path.join(DATA_DIR, 'bridge-stdout.log');
const STDERR_LOG = path.join(DATA_DIR, 'bridge-stderr.log');

function xml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

async function readToken() {
  return (await readFile(path.join(DATA_DIR, 'bridge-token'), 'utf8').catch(() => '')).trim();
}

function reportInstalled() {
  console.log(`FigCC bridge service installed: ${LABEL}`);
  console.log('It will start at login and restart automatically if it exits.');
  console.log('Status: npm run bridge:status');
  console.log(`Logs: ${DATA_DIR}`);
}

/* ------------------------------------------------------------------ macOS */

const PLIST_PATH = path.join(os.homedir(), 'Library', 'LaunchAgents', `${LABEL}.plist`);

function macService() {
  const uid = String(process.getuid());
  return { service: `gui/${uid}/${LABEL}`, domain: `gui/${uid}` };
}

function launchctl(...args) {
  return execFileSync('/bin/launchctl', args, { encoding: 'utf8' });
}

function macBootoutIfLoaded() {
  const result = spawnSync('/bin/launchctl', ['bootout', macService().service], {
    encoding: 'utf8',
    stdio: 'ignore',
  });
  return result.status === 0;
}

function plist() {
  const nodeDir = path.dirname(process.execPath);
  const environmentPath = `${nodeDir}:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(process.execPath)}</string>
    <string>${xml(SERVER_ENTRY)}</string>
  </array>
  <key>WorkingDirectory</key>
  <string>${xml(ROOT)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${xml(environmentPath)}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>5</integer>
  <key>StandardOutPath</key>
  <string>${xml(STDOUT_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xml(STDERR_LOG)}</string>
</dict>
</plist>
`;
}

async function macInstall() {
  await mkdir(DATA_DIR, { recursive: true });
  await mkdir(path.dirname(PLIST_PATH), { recursive: true });
  macBootoutIfLoaded();
  await writeFile(PLIST_PATH, plist(), { mode: 0o644 });
  const { service, domain } = macService();
  launchctl('bootstrap', domain, PLIST_PATH);
  launchctl('enable', service);
  launchctl('kickstart', '-k', service);
  reportInstalled();
}

async function macUninstall() {
  macBootoutIfLoaded();
  await unlink(PLIST_PATH).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
  console.log(`FigCC bridge service removed: ${LABEL}`);
}

async function macStatus() {
  const result = spawnSync('/bin/launchctl', ['print', macService().service], { encoding: 'utf8' });
  if (result.status !== 0) {
    console.log('FigCC bridge service is not installed or not loaded.');
    process.exitCode = 1;
    return;
  }
  const state = result.stdout.match(/\bstate = ([^\n]+)/)?.[1]?.trim() || 'loaded';
  const pid = result.stdout.match(/\bpid = (\d+)/)?.[1] || '—';
  printStatus(state, pid, await readToken());
}

/* ---------------------------------------------------------------- Windows */

// Windows has no LaunchAgent. The closest user-level equivalent is a Scheduled
// Task with a logon trigger plus restart-on-failure, which gives us the same
// RunAtLoad + KeepAlive behaviour without needing administrator rights.
const TASK_NAME = 'FigCC Bridge';
const TASK_XML_PATH = path.join(DATA_DIR, 'bridge-task.xml');
// Left behind by installs from before the supervisor moved into node.
const LEGACY_LAUNCHER_CMD_PATH = path.join(DATA_DIR, 'bridge-launcher.cmd');
const SUPERVISOR_ENTRY = path.join(ROOT, 'scripts', 'bridge-supervisor.js');
const LAUNCHER_VBS_PATH = path.join(DATA_DIR, 'bridge-launcher.vbs');
// Lets uninstall break the supervision loop before it can restart the bridge.
const STOP_FLAG_PATH = path.join(DATA_DIR, 'bridge-stop');

function schtasks(args, { check = true } = {}) {
  const result = spawnSync('schtasks.exe', args, { encoding: 'utf8', windowsHide: true });
  if (check && result.status !== 0) {
    throw new Error(`schtasks ${args[0]} failed: ${(result.stderr || result.stdout || '').trim()}`);
  }
  return result;
}

function powershell(script) {
  return spawnSync('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true });
}

// KeepAlive comes from scripts/bridge-supervisor.js, not from Task Scheduler:
// RestartOnFailure only covers a task that fails to *start*, and a task whose
// process exits counts as completed, so it would never resurrect a crashed
// bridge. The supervisor also restarts after a 5s delay, matching
// LaunchAgent's ThrottleInterval, and writes the same append-only logs.
//
// It used to be a batch-file loop. That froze for good the first time a
// console control event reached it -- cmd answers Ctrl+C/Ctrl+Break by asking
// "Terminate batch job (Y/N)?" on a window nobody can see -- leaving the
// bridge dead with nothing to restart it.
//
// wscript starts the supervisor with window style 0 so no console flashes on
// login, and waits on it so the task's lifetime matches the supervisor's.
function launcherVbs() {
  return [
    'Set shell = CreateObject("WScript.Shell")',
    `WScript.Quit shell.Run("""${process.execPath}"" ""${SUPERVISOR_ENTRY}""", 0, True)`,
    '',
  ].join('\r\n');
}

function taskXml() {
  const user = process.env.USERDOMAIN
    ? `${process.env.USERDOMAIN}\\${process.env.USERNAME}`
    : os.userInfo().username;
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Author>${xml(user)}</Author>
    <Description>FigCC local bridge (${LABEL}) for the Figma plugin.</Description>
    <URI>\\${xml(TASK_NAME)}</URI>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${xml(user)}</UserId>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <AllowHardTerminate>true</AllowHardTerminate>
    <StartWhenAvailable>true</StartWhenAvailable>
    <RunOnlyIfNetworkAvailable>false</RunOnlyIfNetworkAvailable>
    <IdleSettings>
      <StopOnIdleEnd>false</StopOnIdleEnd>
      <RestartOnIdle>false</RestartOnIdle>
    </IdleSettings>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
    <Hidden>false</Hidden>
    <RunOnlyIfIdle>false</RunOnlyIfIdle>
    <DisallowStartOnRemoteAppSession>false</DisallowStartOnRemoteAppSession>
    <UseUnifiedSchedulingEngine>true</UseUnifiedSchedulingEngine>
    <WakeToRun>false</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <Priority>7</Priority>
    <RestartOnFailure>
      <Interval>PT1M</Interval>
      <Count>99</Count>
    </RestartOnFailure>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>wscript.exe</Command>
      <Arguments>"${xml(LAUNCHER_VBS_PATH)}"</Arguments>
      <WorkingDirectory>${xml(ROOT)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
}

function windowsTaskExists() {
  return schtasks(['/query', '/TN', TASK_NAME], { check: false }).status === 0;
}

async function windowsInstall() {
  await mkdir(DATA_DIR, { recursive: true });
  // A flag left behind by a previous uninstall would stop the loop immediately.
  await unlink(STOP_FLAG_PATH).catch(() => {});
  await unlink(LEGACY_LAUNCHER_CMD_PATH).catch(() => {});
  await writeFile(LAUNCHER_VBS_PATH, launcherVbs());
  // schtasks /XML expects a Unicode document; UTF-16LE with a BOM is the
  // encoding it accepts on every supported Windows version.
  await writeFile(TASK_XML_PATH, `﻿${taskXml()}`, 'utf16le');

  if (windowsTaskExists()) schtasks(['/end', '/TN', TASK_NAME], { check: false });
  schtasks(['/create', '/TN', TASK_NAME, '/XML', TASK_XML_PATH, '/F']);
  schtasks(['/run', '/TN', TASK_NAME]);
  reportInstalled();
}

async function windowsUninstall() {
  if (!windowsTaskExists()) {
    console.log(`FigCC bridge service was not installed: ${LABEL}`);
    return;
  }
  // Raise the flag before killing anything, so the supervision loop sees a
  // deliberate stop rather than a crash and does not restart the bridge.
  await mkdir(DATA_DIR, { recursive: true });
  await writeFile(STOP_FLAG_PATH, '');
  schtasks(['/end', '/TN', TASK_NAME], { check: false });
  schtasks(['/delete', '/TN', TASK_NAME, '/F']);
  // /end stops wscript but leaves the node supervisor and bridge behind.
  windowsLauncherPids().forEach((pid) => {
    spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
  });
  await unlink(STOP_FLAG_PATH).catch(() => {});
  console.log(`FigCC bridge service removed: ${LABEL}`);
}

// The whole launcher tree: wscript -> node supervisor -> node bridge, plus the
// cmd loop older installs used. Matching on the command line alone is not
// safe: any shell or editor whose command line merely mentions these files
// would be killed along with them -- uninstall once took down the terminal it
// was run from. So require one of the launcher's own executables and the full
// path of one of its own entry points.
function windowsLauncherPids() {
  const quote = (value) => `'${String(value).replace(/'/g, "''")}'`;
  const entries = [LAUNCHER_VBS_PATH, LEGACY_LAUNCHER_CMD_PATH, SUPERVISOR_ENTRY, SERVER_ENTRY]
    .map((entry) => `$_.CommandLine -like ('*' + ${quote(entry)} + '*')`)
    .join(' -or ');
  const result = powershell(
    'Get-CimInstance Win32_Process'
    + " | Where-Object { @('wscript.exe','cscript.exe','cmd.exe','node.exe') -contains $_.Name"
    + ` -and (${entries}) }`
    + ' | Select-Object -ExpandProperty ProcessId',
  );
  return String(result.stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function windowsBridgePid() {
  const result = powershell(
    "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\""
    + " | Where-Object { $_.CommandLine -like '*bridge*server.js*' }"
    + ' | Select-Object -ExpandProperty ProcessId',
  );
  return String(result.stdout || '').trim().split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

async function windowsStatus() {
  const result = schtasks(['/query', '/TN', TASK_NAME, '/FO', 'LIST', '/V'], { check: false });
  if (result.status !== 0) {
    console.log('FigCC bridge service is not installed or not loaded.');
    process.exitCode = 1;
    return;
  }
  const scheduled = result.stdout.match(/^\s*Status:\s*(.+)$/m)?.[1]?.trim() || 'unknown';
  const pids = windowsBridgePid();
  const state = pids.length ? 'running' : `${scheduled.toLowerCase()} (bridge process not found)`;
  printStatus(state, pids.join(', ') || '—', await readToken());
}

/* ------------------------------------------------------------------ shared */

function printStatus(state, pid, token) {
  console.log(`FigCC bridge service: ${state}`);
  console.log(`PID: ${pid}`);
  console.log('URL: http://127.0.0.1:4319');
  console.log(`Pairing token: ${token ? 'available via npm run bridge:token' : 'not created yet'}`);
}

const PLATFORMS = {
  darwin: { install: macInstall, uninstall: macUninstall, status: macStatus },
  win32: { install: windowsInstall, uninstall: windowsUninstall, status: windowsStatus },
};

const platform = PLATFORMS[process.platform];
if (!platform) {
  throw new Error(`The FigCC bridge service installer supports macOS and Windows, not ${process.platform}.`);
}

const action = process.argv[2] || 'status';
if (action === 'install') await platform.install();
else if (action === 'uninstall') await platform.uninstall();
else if (action === 'status') await platform.status();
else throw new Error(`Unknown action: ${action}`);
