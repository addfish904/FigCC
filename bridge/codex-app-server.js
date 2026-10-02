import { EventEmitter } from 'node:events';
import readline from 'node:readline';
import { runCodex, spawnCodex } from './codex-exec.js';

export function mcpDisableConfig(name) {
  const value = String(name);
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(value)) return null;
  return `mcp_servers.${value}.enabled=false`;
}

async function appServerArgs(binary) {
  const args = ['app-server', '--stdio'];
  try {
    const result = await runCodex(binary, ['mcp', 'list', '--json'], {
      timeout: 10_000,
      maxBuffer: 4 * 1024 * 1024,
    });
    const servers = JSON.parse(result.stdout);
    const overrides = (Array.isArray(servers) ? servers.slice(0, 128) : [])
      .map((server) => mcpDisableConfig(server?.name || ''))
      .filter(Boolean);
    for (let index = 0; index < overrides.length; index += 4) {
      const checked = await Promise.all(overrides.slice(index, index + 4).map(async (override) => {
        try {
          // `mcp list` also contains plugin-injected servers that do not exist
          // in the base config. Overriding those creates an incomplete table.
          await runCodex(binary, ['-c', override, 'mcp', 'list', '--json'], {
            timeout: 10_000,
            maxBuffer: 4 * 1024 * 1024,
          });
          return override;
        } catch {
          // The runtime boundary still tells Codex not to use injected tools.
          return null;
        }
      }));
      for (const override of checked) {
        if (override) args.push('-c', override);
      }
    }
  } catch {
    // Older compatible builds may not support JSON listing. FigCC's thread
    // still receives an explicit tool-only runtime boundary in that case.
  }
  return args;
}

export class CodexAppServer extends EventEmitter {
  constructor({ binary, cwd }) {
    super();
    this.binary = binary;
    this.cwd = cwd;
    this.child = null;
    this.nextId = 1;
    this.pending = new Map();
    this.started = false;
    this.stopping = false;
  }

  async start() {
    if (this.started) return;
    this.stopping = false;
    const child = spawnCodex(this.binary, await appServerArgs(this.binary), {
      cwd: this.cwd,
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;

    const lines = readline.createInterface({ input: child.stdout });
    lines.on('line', (line) => this.#consume(line));
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => this.emit('diagnostic', String(chunk).trim()));
    child.on('error', (error) => this.#closed(error));
    child.on('close', (code, signal) => {
      const suffix = signal ? ` signal ${signal}` : ` exit ${code}`;
      this.#closed(new Error(`Codex app-server 已停止（${suffix.trim()}）。`));
    });

    await this.request('initialize', {
      clientInfo: {
        name: 'figcodex_local_bridge',
        title: 'FigCC Local Bridge',
        version: '2.0.0',
      },
      capabilities: { experimentalApi: true },
    });
    this.notify('initialized', {});
    this.started = true;
  }

  request(method, params = {}, timeoutMs = 30_000) {
    if (!this.child?.stdin?.writable) {
      return Promise.reject(new Error('Codex app-server 尚未啟動。'));
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`Codex app-server request timed out: ${method}`));
          }, timeoutMs)
        : null;
      timer?.unref();
      this.pending.set(id, { resolve, reject, timer, method });
      this.#write({ jsonrpc: '2.0', method, id, params });
    });
  }

  notify(method, params = {}) {
    this.#write({ jsonrpc: '2.0', method, params });
  }

  respond(id, result) {
    this.#write({ jsonrpc: '2.0', id, result });
  }

  respondError(id, message, code = -32000) {
    this.#write({ jsonrpc: '2.0', id, error: { code, message } });
  }

  async stop() {
    if (!this.child) return;
    this.stopping = true;
    this.child.kill('SIGTERM');
    this.child = null;
    this.started = false;
  }

  #write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex app-server connection is closed.');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #consume(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.emit('diagnostic', `Unparsed app-server output: ${line.slice(0, 500)}`);
      return;
    }

    if (message.id !== undefined && message.method) {
      this.emit('request', message);
      return;
    }
    if (message.id !== undefined) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (pending.timer) clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || pending.method));
      else pending.resolve(message.result);
      return;
    }
    if (message.method) this.emit('notification', message);
  }

  #closed(error) {
    if (this.stopping) return;
    this.started = false;
    for (const pending of this.pending.values()) {
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('closed', error);
  }
}
