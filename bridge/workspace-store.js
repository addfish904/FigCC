import { execFile } from 'node:child_process';
import { lstat, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const MAX_PATH_LENGTH = 4096;

export async function validateWorkspacePath(input) {
  const candidate = String(input || '').trim();
  if (!candidate || candidate.length > MAX_PATH_LENGTH || !path.isAbsolute(candidate)) {
    throw new Error('The selected workspace must be an absolute local folder.');
  }
  const resolved = await realpath(candidate).catch(() => '');
  if (!resolved) throw new Error('The selected workspace no longer exists.');
  if (resolved === path.parse(resolved).root) {
    throw new Error('Choose a project folder instead of the filesystem root.');
  }
  const info = await lstat(resolved).catch(() => null);
  if (!info?.isDirectory()) throw new Error('The selected workspace is not a folder.');
  return resolved;
}

const PICKER_PROMPT = 'Choose a FigCC project workspace';

async function chooseWorkspaceFolderMac() {
  try {
    const { stdout } = await execFileAsync('/usr/bin/osascript', [
      '-e',
      `POSIX path of (choose folder with prompt "${PICKER_PROMPT}")`,
    ], {
      timeout: 120_000,
      maxBuffer: 16 * 1024,
    });
    return String(stdout || '').trim();
  } catch (error) {
    const detail = `${error?.stderr || ''} ${error?.message || ''}`;
    if (/User canceled|\(-128\)/i.test(detail)) return null;
    throw new Error('Could not open the macOS folder picker.');
  }
}

// Windows has no osascript equivalent, so drive the WinForms folder browser
// through PowerShell. The `CANCELLED` sentinel keeps a user dismissing the
// dialog distinct from an empty selection.
const WINDOWS_PICKER_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${PICKER_PROMPT}'
$dialog.ShowNewFolderButton = $true
$dialog.RootFolder = [System.Environment+SpecialFolder]::Desktop
$form = New-Object System.Windows.Forms.Form
$form.TopMost = $true
$form.StartPosition = 'CenterScreen'
if ($dialog.ShowDialog($form) -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
} else {
  [Console]::Out.Write('CANCELLED')
}
$form.Dispose()
`;

async function chooseWorkspaceFolderWindows() {
  try {
    const { stdout } = await execFileAsync('powershell.exe', [
      '-NoProfile',
      '-NonInteractive',
      '-STA',
      '-ExecutionPolicy', 'Bypass',
      '-Command', WINDOWS_PICKER_SCRIPT,
    ], {
      timeout: 120_000,
      maxBuffer: 16 * 1024,
      windowsHide: true,
    });
    const selected = String(stdout || '').trim();
    if (!selected || selected === 'CANCELLED') return null;
    return selected;
  } catch (error) {
    if (error?.killed) throw new Error('The folder picker timed out.');
    throw new Error('Could not open the Windows folder picker.');
  }
}

export async function chooseWorkspaceFolder() {
  if (process.platform === 'darwin') return chooseWorkspaceFolderMac();
  if (process.platform === 'win32') return chooseWorkspaceFolderWindows();
  throw new Error('The native workspace picker is available on macOS and Windows only.');
}

export class WorkspaceStore {
  constructor({ defaultRoot, dataDir, picker = chooseWorkspaceFolder }) {
    this.defaultRoot = defaultRoot;
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'workspace.json');
    this.picker = picker;
    this.selectedRoot = null;
  }

  async initialize() {
    const saved = await readFile(this.stateFile, 'utf8').catch(() => '');
    if (!saved) return this.publicState();
    try {
      const value = JSON.parse(saved);
      this.selectedRoot = await validateWorkspacePath(value?.path);
    } catch {
      this.selectedRoot = null;
    }
    return this.publicState();
  }

  runtimeRoot() {
    return this.selectedRoot || this.defaultRoot;
  }

  publicState() {
    const root = this.runtimeRoot();
    return {
      selected: Boolean(this.selectedRoot),
      path: root,
      name: path.basename(root),
      skillsPath: path.join(root, 'skills'),
    };
  }

  async choose() {
    const selected = await this.picker();
    if (!selected) return { changed: false, cancelled: true, workspace: this.publicState() };
    const root = await validateWorkspacePath(selected);
    const previousRoot = this.runtimeRoot();
    this.selectedRoot = root === this.defaultRoot ? null : root;
    const changed = previousRoot !== this.runtimeRoot();
    await this.persist();
    return { changed, cancelled: false, workspace: this.publicState() };
  }

  async clear() {
    const changed = Boolean(this.selectedRoot);
    this.selectedRoot = null;
    await this.persist();
    return { changed, cancelled: false, workspace: this.publicState() };
  }

  async persist() {
    await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
    const temporary = `${this.stateFile}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify({ path: this.selectedRoot }, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.stateFile);
  }
}
