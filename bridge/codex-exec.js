import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// npm installs Codex globally on Windows as a .cmd shim, and Node refuses to
// spawn one directly -- it fails with EINVAL. A shell is required, and once a
// shell re-parses the command line anything containing a space has to be
// quoted. Every place that runs the Codex binary has to agree on this, so the
// decision lives here rather than at each call site.
function needsShell(binary) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(String(binary));
}

function quoteForShell(value) {
  const text = String(value);
  return /[\s"^&|<>()]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

function resolveInvocation(binary, args, options) {
  if (!needsShell(binary)) return { command: binary, args, options };
  return {
    command: quoteForShell(binary),
    args: args.map(quoteForShell),
    options: { ...options, shell: true },
  };
}

export function runCodex(binary, args, options = {}) {
  const invocation = resolveInvocation(binary, args, options);
  return execFileAsync(invocation.command, invocation.args, invocation.options);
}

export function spawnCodex(binary, args, options = {}) {
  const invocation = resolveInvocation(binary, args, options);
  return spawn(invocation.command, invocation.args, invocation.options);
}

export const __test = { needsShell, quoteForShell };
