import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { runCodex } from './codex-exec.js';

const WINDOWS = process.platform === 'win32';
// npm's global install writes codex (a POSIX shell script Windows cannot run),
// codex.cmd and codex.ps1 side by side. Only the .cmd is a usable entry point
// here, and it has to be preferred over the extensionless file.
const EXECUTABLE_NAMES = WINDOWS ? ['codex.cmd', 'codex.exe', 'codex'] : ['codex'];

async function isExecutable(filePath) {
  if (!filePath) return false;
  try {
    // X_OK is meaningless on Windows -- node treats it as F_OK -- and the POSIX
    // shell script npm leaves there still reports as executable, so existence
    // is all this can establish. Whether it actually runs is settled by
    // inspectCodex calling it.
    await access(filePath, WINDOWS ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function parseVersion(output) {
  const match = String(output || '').match(/codex-cli\s+(\d+)\.(\d+)\.(\d+)([^\s]*)?/i);
  if (!match) return null;
  return {
    text: `${match[1]}.${match[2]}.${match[3]}${match[4] || ''}`,
    parts: [Number(match[1]), Number(match[2]), Number(match[3])],
    prerelease: Boolean(match[4]),
  };
}

function compareVersion(a, b) {
  for (let index = 0; index < 3; index += 1) {
    if (a.version.parts[index] !== b.version.parts[index]) {
      return b.version.parts[index] - a.version.parts[index];
    }
  }
  return Number(a.version.prerelease) - Number(b.version.prerelease);
}

function withExecutableNames(directory) {
  return EXECUTABLE_NAMES.map((name) => path.join(directory, name));
}

async function nvmCandidates() {
  const versionsRoot = path.join(homedir(), '.nvm', 'versions', 'node');
  const versions = await readdir(versionsRoot).catch(() => []);
  return versions.flatMap((version) => withExecutableNames(path.join(versionsRoot, version, 'bin')));
}

export async function listCodexCandidates() {
  if (process.env.CODEX_BIN) return [process.env.CODEX_BIN];

  const pathCandidates = String(process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .flatMap(withExecutableNames);
  const candidates = [
    ...withExecutableNames(path.dirname(process.execPath)),
    // npm's global prefix is not always on the PATH of a service process.
    ...(WINDOWS && process.env.APPDATA
      ? withExecutableNames(path.join(process.env.APPDATA, 'npm'))
      : []),
    ...(await nvmCandidates()),
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    ...pathCandidates,
  ];
  return [...new Set(candidates)];
}

export async function inspectCodex(binary) {
  if (!(await isExecutable(binary))) return null;
  try {
    const [versionResult, helpResult] = await Promise.all([
      runCodex(binary, ['--version'], { timeout: 8_000, maxBuffer: 1024 * 1024 }),
      runCodex(binary, ['app-server', 'generate-ts', '--help'], {
        timeout: 8_000,
        maxBuffer: 2 * 1024 * 1024,
      }),
    ]);
    const version = parseVersion(versionResult.stdout);
    const help = `${helpResult.stdout}\n${helpResult.stderr}`;
    if (!version || !help.includes('--experimental')) return null;
    return { binary, version };
  } catch {
    return null;
  }
}

export async function discoverCodex() {
  const candidates = await listCodexCandidates();
  const inspected = (await Promise.all(candidates.map(inspectCodex))).filter(Boolean);
  if (inspected.length === 0) {
    const target = process.env.CODEX_BIN
      ? `目前的 CODEX_BIN (${process.env.CODEX_BIN})`
      : 'CODEX_BIN';
    throw new Error(
      `找不到支援 app-server dynamic tools 的 Codex CLI。請更新 Codex，或讓 ${target} 指向新版執行檔。`
    );
  }

  // Prefer the newest capable binary. The ChatGPT desktop app can bundle a
  // prerelease CLI that matches its current config/cache format more closely
  // than an older stable CLI elsewhere on PATH.
  const selected = inspected.sort(compareVersion)[0];
  return {
    binary: selected.binary,
    version: selected.version.text,
    candidates: inspected.map((item) => ({ binary: item.binary, version: item.version.text })),
  };
}

export async function readLoginStatus(binary) {
  try {
    const result = await runCodex(binary, ['login', 'status'], {
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    });
    const text = `${result.stdout}\n${result.stderr}`.trim();
    return { ok: /logged in/i.test(text), message: text };
  } catch (error) {
    const text = `${error?.stdout || ''}\n${error?.stderr || ''}`.trim();
    return { ok: false, message: text || error.message };
  }
}

export const __test = { parseVersion, compareVersion };
