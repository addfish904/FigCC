// Keeps the bridge running on Windows. Started windowless by the Scheduled
// Task through a wscript wrapper; see scripts/bridge-service.js.
//
// This used to be a batch-file loop, which froze for good the first time a
// console control event reached it: cmd answers Ctrl+C/Ctrl+Break inside a
// batch file by asking "Terminate batch job (Y/N)?" and waits for a key on a
// window nobody can see. The bridge died with it and was never restarted.
// Supervising from node has no such prompt, and ignoring those events here
// keeps the supervisor alive when they arrive.
import { spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, '.figcodex-data');
const SERVER_ENTRY = path.join(ROOT, 'bridge', 'server.js');
// Lets uninstall stop supervision deliberately instead of racing a restart.
const STOP_FLAG = path.join(DATA_DIR, 'bridge-stop');
const RESTART_DELAY_MS = 5_000;

for (const signal of ['SIGINT', 'SIGBREAK', 'SIGHUP']) {
  process.on(signal, () => {});
}

mkdirSync(DATA_DIR, { recursive: true });

function start() {
  if (existsSync(STOP_FLAG)) process.exit(0);
  const stdout = openSync(path.join(DATA_DIR, 'bridge-stdout.log'), 'a');
  const stderr = openSync(path.join(DATA_DIR, 'bridge-stderr.log'), 'a');
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    stdio: ['ignore', stdout, stderr],
    windowsHide: true,
  });
  // The child holds its own handles now; keeping these open would leak a pair
  // on every restart.
  closeSync(stdout);
  closeSync(stderr);
  // A failed spawn can raise both 'error' and 'exit'; restart only once.
  let restartScheduled = false;
  const restart = () => {
    if (restartScheduled) return;
    restartScheduled = true;
    if (existsSync(STOP_FLAG)) process.exit(0);
    setTimeout(start, RESTART_DELAY_MS);
  };
  child.on('exit', restart);
  child.on('error', restart);
}

start();
