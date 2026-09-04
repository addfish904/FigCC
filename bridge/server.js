import crypto from 'node:crypto';
import http from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket, WebSocketServer } from 'ws';
import { promptWithFileAttachments, saveFileAttachments } from './attachment-store.js';
import { CodexAppServer } from './codex-app-server.js';
import { discoverCodex, readLoginStatus } from './codex-discovery.js';
import { discoverClaude } from './claude-discovery.js';
import { ClaudeProvider, CLAUDE_PERMISSION_PROFILES } from './claude-provider.js';
import { needsDynamicToolReview, reviewDynamicTool } from './dynamic-tool-reviewer.js';
import { LinkedSkillStore } from './linked-skill-store.js';
import {
  normalizePermissionProfiles,
  resolvePermissionProfile,
} from './permission-profiles.js';
import { WorkspaceStore } from './workspace-store.js';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DATA_DIR = path.join(ROOT, '.figcodex-data');
const LEGACY_DATA_DIR = path.join(ROOT, '.figclaw-data');
const TOKEN_FILE = path.join(DATA_DIR, 'bridge-token');
const LEGACY_TOKEN_FILE = path.join(LEGACY_DATA_DIR, 'bridge-token');
const HOST = process.env.FIGCODEX_HOST || process.env.FIGCLAW_HOST || '127.0.0.1';
const PORT = Number(process.env.FIGCODEX_PORT || process.env.FIGCLAW_PORT || 4319);
const MAX_MESSAGE_BYTES = 40 * 1024 * 1024;
const BRIDGE_VERSION = '3.0.0';

let codexInfo = null;
let loginStatus = null;
let codex = null;
let codexError = null;
let models = [];
let permissionProfiles = normalizePermissionProfiles(null);
let permissionProfilesSupported = false;
let startupPromise = null;
let claudeInfo = null;
let claudeProvider = null;
let claudeError = null;
let claudeStartupPromise = null;
let skillWatcher = null;
let skillWatcherRetry = null;
let skillWatcherStarting = false;
let workspaceSelectionPending = false;

const workspaceStore = new WorkspaceStore({ defaultRoot: ROOT, dataDir: DATA_DIR });
const skillStore = new LinkedSkillStore({ bundledRoot: ROOT, dataDir: DATA_DIR });

const threadOwners = new Map();
const threadWorkspaceRoots = new Map();
const activeTurns = new Map();
const turnContexts = new Map();
const threadPromptContexts = new Map();
const pendingToolCalls = new Map();
const sockets = new Set();

async function ensureToken() {
  if (process.env.FIGCODEX_BRIDGE_TOKEN) return process.env.FIGCODEX_BRIDGE_TOKEN;
  if (process.env.FIGCLAW_BRIDGE_TOKEN) return process.env.FIGCLAW_BRIDGE_TOKEN;
  await mkdir(DATA_DIR, { recursive: true });
  const existing = await readFile(TOKEN_FILE, 'utf8').catch(() => '');
  if (existing.trim()) return existing.trim();
  const legacy = await readFile(LEGACY_TOKEN_FILE, 'utf8').catch(() => '');
  if (legacy.trim()) {
    await writeFile(TOKEN_FILE, `${legacy.trim()}\n`, { mode: 0o600 });
    return legacy.trim();
  }
  const token = crypto.randomBytes(24).toString('base64url');
  await writeFile(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  return token;
}

function sameToken(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b);
}

function send(socket, value) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(value));
}

function publicError(error) {
  return error instanceof Error ? error.message : String(error);
}

function attachCodexEvents(instance) {
  instance.on('diagnostic', (message) => {
    if (message) console.error(`[codex] ${message}`);
  });
  instance.on('closed', (error) => {
    codexError = publicError(error);
    codex = null;
    for (const socket of sockets) send(socket, {
      type: 'provider.error', provider: 'codex', error: codexError,
    });
  });
  instance.on('notification', ({ method, params }) => {
    const socket = params?.threadId ? threadOwners.get(params.threadId) : null;
    if (!socket) return;

    if (method === 'turn/started') {
      const turnId = params.turn?.id;
      if (turnId) activeTurns.set(params.threadId, turnId);
      send(socket, { type: 'turn.started', threadId: params.threadId, turnId });
      return;
    }
    if (method === 'item/agentMessage/delta') {
      send(socket, {
        type: 'agent.delta',
        threadId: params.threadId,
        turnId: params.turnId,
        itemId: params.itemId,
        delta: params.delta,
      });
      return;
    }
    if (method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage') {
        send(socket, {
          type: 'agent.completed',
          threadId: params.threadId,
          turnId: params.turnId,
          itemId: item.id,
          text: item.text || '',
          phase: item.phase || null,
        });
      } else if (item.type === 'dynamicToolCall') {
        send(socket, {
          type: 'tool.completed',
          threadId: params.threadId,
          turnId: params.turnId,
          callId: item.id,
          tool: item.tool,
          success: item.success,
        });
      }
      return;
    }
    if (method === 'turn/completed') {
      activeTurns.delete(params.threadId);
      if (params.turn?.id) turnContexts.delete(params.turn.id);
      threadPromptContexts.delete(params.threadId);
      send(socket, {
        type: 'turn.completed',
        threadId: params.threadId,
        turnId: params.turn?.id,
        status: params.turn?.status,
        error: params.turn?.error?.message || params.turn?.error || null,
      });
      return;
    }
    if (method === 'error') {
      send(socket, {
        type: 'turn.error',
        threadId: params.threadId,
        turnId: params.turnId,
        error: params.error?.message || 'Codex turn failed.',
        willRetry: Boolean(params.willRetry),
      });
    }
  });

  instance.on('request', (request) => {
    void handleCodexRequest(instance, request).catch((error) => {
      instance.respond(request.id, {
        contentItems: [{ type: 'inputText', text: `FigCC bridge error: ${publicError(error)}` }],
        success: false,
      });
    });
  });
}

async function handleCodexRequest(instance, request) {
  if (request.method !== 'item/tool/call') {
    instance.respondError(request.id, `FigCC does not support server request: ${request.method}`);
    return;
  }

  const params = request.params || {};
  const socket = threadOwners.get(params.threadId);
  if (!socket) {
    instance.respond(request.id, {
      contentItems: [{ type: 'inputText', text: 'FigCC plugin is disconnected.' }],
      success: false,
    });
    return;
  }

  let review = null;
  if (needsDynamicToolReview(params.tool)) {
    const requestId = String(request.id);
    send(socket, {
      type: 'review.started',
      requestId,
      threadId: params.threadId,
      turnId: params.turnId,
      tool: params.tool,
    });
    review = await reviewDynamicTool({
      codex: instance,
      root: threadWorkspaceRoots.get(params.threadId) || workspaceStore.runtimeRoot(),
      userPrompt: turnContexts.get(params.turnId) || threadPromptContexts.get(params.threadId) || '',
      tool: params.tool,
      arguments: params.arguments || {},
    });

    if (threadOwners.get(params.threadId) !== socket || socket.readyState !== WebSocket.OPEN) {
      instance.respond(request.id, {
        contentItems: [{ type: 'inputText', text: 'FigCC plugin disconnected during auto-review.' }],
        success: false,
      });
      return;
    }

    send(socket, {
      type: 'review.completed',
      requestId,
      threadId: params.threadId,
      turnId: params.turnId,
      tool: params.tool,
      approved: review.approved,
      risk: review.risk,
      reason: review.reason,
    });
    if (!review.approved) {
      instance.respond(request.id, {
        contentItems: [{
          type: 'inputText',
          text: `FigCC auto-review denied ${params.tool}: ${review.reason}`,
        }],
        success: false,
      });
      return;
    }
  }

  if (params.tool === 'create_skill' || params.tool === 'update_skill') {
    try {
      const result = await executeSkillTool(params.tool, params.arguments || {});
      instance.respond(request.id, {
        contentItems: [{ type: 'inputText', text: JSON.stringify(result) }],
        success: true,
      });
      await broadcastSkills();
    } catch (error) {
      instance.respond(request.id, {
        contentItems: [{ type: 'inputText', text: publicError(error) }],
        success: false,
      });
    }
    return;
  }

  pendingToolCalls.set(String(request.id), { provider: 'codex', requestId: request.id, socket });
  send(socket, {
    type: 'tool.call',
    requestId: String(request.id),
    threadId: params.threadId,
    turnId: params.turnId,
    callId: params.callId,
    namespace: params.namespace,
    tool: params.tool,
    arguments: params.arguments || {},
    ...(review ? { review } : {}),
  });
}

async function ensureCodex() {
  if (codex?.started) return codex;
  if (startupPromise) return startupPromise;
  startupPromise = (async () => {
    codexError = null;
    codexInfo = await discoverCodex();
    loginStatus = await readLoginStatus(codexInfo.binary);
    if (!loginStatus.ok) {
      throw new Error(`Codex CLI 尚未登入：${loginStatus.message || '請先執行 codex login。'}`);
    }
    const instance = new CodexAppServer({ binary: codexInfo.binary, cwd: ROOT });
    attachCodexEvents(instance);
    await instance.start();
    const modelResult = await instance.request('model/list', { limit: 100 }).catch(() => ({ data: [] }));
    models = (modelResult?.data || []).filter((model) => !model.hidden).map((model) => ({
      id: String(model.model || model.id || ''),
      label: String(model.displayName || model.model || model.id || ''),
      isDefault: Boolean(model.isDefault),
      supportedReasoningEfforts: (Array.isArray(model.supportedReasoningEfforts)
        ? model.supportedReasoningEfforts
        : [])
        .map((option) => ({
          id: String(option?.reasoningEffort || option?.effort || option || '').trim(),
          description: String(option?.description || '').slice(0, 500),
        }))
        .filter((option) => option.id),
      defaultReasoningEffort: String(model.defaultReasoningEffort || '').trim(),
    })).filter((model) => model.id);
    try {
      const permissionResult = await instance.request('permissionProfile/list', {
        cwd: workspaceStore.runtimeRoot(),
        limit: 100,
      });
      permissionProfiles = normalizePermissionProfiles(permissionResult);
      permissionProfilesSupported = Array.isArray(permissionResult?.data)
        && permissionResult.data.some((profile) => (
          String(profile?.id || '').trim()
          && profile?.allowed !== false
        ));
    } catch {
      permissionProfiles = normalizePermissionProfiles(null);
      permissionProfilesSupported = false;
    }
    codex = instance;
    return codex;
  })();

  try {
    return await startupPromise;
  } catch (error) {
    codexError = publicError(error);
    throw error;
  } finally {
    startupPromise = null;
  }
}

async function ensureClaude() {
  if (claudeProvider) return claudeProvider;
  if (claudeStartupPromise) return claudeStartupPromise;
  claudeStartupPromise = (async () => {
    claudeError = null;
    claudeInfo = await discoverClaude();
    const provider = new ClaudeProvider({
      root: ROOT,
      binary: claudeInfo.binary,
      version: claudeInfo.version,
      send,
      executeTool: executeProviderTool,
    });
    await provider.initialize();
    claudeProvider = provider;
    return provider;
  })();
  try {
    return await claudeStartupPromise;
  } catch (error) {
    claudeError = publicError(error);
    throw error;
  } finally {
    claudeStartupPromise = null;
  }
}

function codexCatalog() {
  return {
    id: 'codex',
    label: 'Codex',
    available: Boolean(codex?.started),
    cliVersion: codexInfo?.version || '',
    auth: loginStatus?.message || (codexError ? '' : 'Logged in'),
    models,
    permissionProfiles,
    ...(codexError ? { error: codexError } : {}),
  };
}

function claudeCatalog() {
  return claudeProvider?.catalog() || {
    id: 'claude',
    label: 'Claude',
    available: false,
    cliVersion: claudeInfo?.version || '',
    auth: '',
    models: [],
    permissionProfiles: CLAUDE_PERMISSION_PROFILES.map((profile) => ({ ...profile })),
    ...(claudeError ? { error: claudeError } : {}),
  };
}

async function ensureProviders() {
  await Promise.allSettled([ensureCodex(), ensureClaude()]);
  if (!codex?.started && !claudeProvider) {
    throw new Error(`No local provider is ready. Codex: ${codexError || 'unavailable'} Claude: ${claudeError || 'unavailable'}`);
  }
}

async function executeSkillTool(tool, args) {
  if (tool === 'create_skill') {
    return skillStore.create({ name: args?.name, content: args?.content, mode: args?.mode });
  }
  if (tool === 'update_skill') {
    return skillStore.update({ id: args?.id, name: args?.name, content: args?.content });
  }
  throw new Error(`Unsupported skill tool: ${tool}`);
}

async function broadcastSkills(target = null) {
  let skills;
  try {
    skills = await skillStore.list();
  } catch (error) {
    const message = { type: 'skills.error', error: `Could not refresh skills: ${publicError(error)}` };
    console.error(`[skills] ${message.error}`);
    if (target) {
      send(target, message);
      return false;
    }
    for (const socket of sockets) {
      if (socket.figcodexAuthenticated) send(socket, message);
    }
    return false;
  }
  const message = { type: 'skills.list', skills };
  if (target) {
    send(target, message);
    return true;
  }
  for (const socket of sockets) {
    if (socket.figcodexAuthenticated) send(socket, message);
  }
  return true;
}

function scheduleSkillWatcherRestart(error) {
  if (error) console.error(`[skills] Filesystem monitor unavailable: ${publicError(error)}`);
  skillWatcher?.close();
  skillWatcher = null;
  if (skillWatcherRetry) return;
  skillWatcherRetry = setTimeout(() => {
    skillWatcherRetry = null;
    void startSkillWatcher();
  }, 5_000);
  skillWatcherRetry.unref?.();
}

async function startSkillWatcher() {
  if (skillWatcher || skillWatcherStarting) return;
  skillWatcherStarting = true;
  try {
    skillWatcher = await skillStore.watchChanges(
      () => broadcastSkills(),
      (error) => scheduleSkillWatcherRestart(error)
    );
  } catch (error) {
    scheduleSkillWatcherRestart(error);
  } finally {
    skillWatcherStarting = false;
  }
}

async function restartSkillWatcher() {
  if (skillWatcherRetry) {
    clearTimeout(skillWatcherRetry);
    skillWatcherRetry = null;
  }
  skillWatcher?.close();
  skillWatcher = null;
  await startSkillWatcher();
}

function workspaceBusy() {
  return activeTurns.size > 0 || Boolean(claudeProvider?.activeTurns?.size);
}

function broadcastWorkspace(type = 'workspace.state', target = null, extra = {}) {
  const message = { type, workspace: workspaceStore.publicState(), ...extra };
  if (target) {
    send(target, message);
    return;
  }
  for (const socket of sockets) {
    if (socket.figcodexAuthenticated) send(socket, message);
  }
}

async function applyWorkspaceResult(result, target) {
  if (result.cancelled) {
    broadcastWorkspace('workspace.state', target, { cancelled: true });
    return;
  }
  if (!result.changed) {
    broadcastWorkspace('workspace.state', target);
    return;
  }
  skillStore.setWorkspace(workspaceStore.selectedRoot);
  await restartSkillWatcher();
  broadcastWorkspace('workspace.changed');
  await broadcastSkills();
}

async function executeProviderTool(socket, context) {
  if (context.tool === 'create_skill' || context.tool === 'update_skill') {
    const result = await executeSkillTool(context.tool, context.arguments || {});
    await broadcastSkills();
    return result;
  }
  const requestId = crypto.randomUUID();
  return new Promise((resolve) => {
    pendingToolCalls.set(requestId, { provider: 'claude', socket, resolve });
    send(socket, {
      type: 'tool.call',
      requestId,
      threadId: context.threadId,
      turnId: context.turnId,
      callId: context.callId,
      namespace: 'figcodex',
      tool: context.tool,
      arguments: context.arguments || {},
      ...(context.review ? { review: context.review } : {}),
    });
  });
}

function normalizeTools(rawTools) {
  if (!Array.isArray(rawTools) || rawTools.length === 0) throw new Error('FigCC tools are missing.');
  return rawTools.slice(0, 32).map((tool) => {
    const name = String(tool?.name || '');
    if (!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new Error(`Invalid tool name: ${name}`);
    return {
      type: 'function',
      name,
      description: String(tool.description || '').slice(0, 8_000),
      inputSchema: tool.input_schema && typeof tool.input_schema === 'object'
        ? tool.input_schema
        : { type: 'object', properties: {} },
    };
  });
}

async function saveImages(chatId, images) {
  const safeChatId = String(chatId || 'chat').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 80) || 'chat';
  const directory = path.join(DATA_DIR, 'attachments', safeChatId);
  await mkdir(directory, { recursive: true });
  const paths = [];
  for (const image of Array.isArray(images) ? images.slice(0, 5) : []) {
    const match = String(image?.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/);
    if (!match) continue;
    const bytes = Buffer.from(match[2], 'base64');
    if (bytes.length === 0 || bytes.length > 12 * 1024 * 1024) continue;
    const extension = match[1] === 'jpeg' ? 'jpg' : match[1];
    const filePath = path.join(directory, `${crypto.randomUUID()}.${extension}`);
    await writeFile(filePath, bytes);
    paths.push(filePath);
  }
  return paths;
}

async function startTurn(socket, message) {
  const provider = String(message.provider || 'codex');
  if (provider !== 'codex' && provider !== 'claude') {
    throw new Error(`Unknown provider: ${provider}`);
  }
  const fileAttachments = await saveFileAttachments({
    dataDir: DATA_DIR,
    chatId: message.chatId,
    files: message.files,
  });
  message = {
    ...message,
    prompt: promptWithFileAttachments(message.prompt, fileAttachments),
  };
  const workspaceRoot = workspaceStore.runtimeRoot();
  const claimedWorkspace = String(message.workspacePath || '');
  const workspaceMatches = claimedWorkspace
    ? claimedWorkspace === workspaceRoot
    : workspaceRoot === ROOT;
  const requestedThreadId = String(message.threadId || '').trim();
  const knownThreadRoot = requestedThreadId ? threadWorkspaceRoots.get(requestedThreadId) : null;
  const threadId = workspaceMatches && (!knownThreadRoot || knownThreadRoot === workspaceRoot)
    ? requestedThreadId
    : '';
  message = { ...message, threadId };
  if (provider === 'claude') {
    await (await ensureClaude()).startTurn(socket, message, normalizeTools(message.tools), workspaceRoot);
    return;
  }
  const instance = await ensureCodex();
  const developerInstructions = String(message.instructions || '').slice(0, 160_000);
  // The plugin owns skill activation and @mention injection. Disable native
  // auto-discovery for the same canonical files so Passive cannot be bypassed.
  const skillConfig = await skillStore.disabledNativeSkillConfig();
  const requestedModel = String(message.model || '').trim();
  const selectedModel = models.find((item) => item.id === requestedModel);
  const model = selectedModel?.id;
  const requestedEffort = String(message.effort || '').trim();
  const effort = selectedModel?.supportedReasoningEfforts
    .some((item) => item.id === requestedEffort)
    ? requestedEffort
    : undefined;
  const permissionProfile = resolvePermissionProfile(permissionProfiles, message.permissionProfile);
  const permissionSettings = permissionProfilesSupported
    ? { permissions: permissionProfile }
    : { sandbox: 'read-only' };
  let codexThreadId = threadId;

  if (codexThreadId) {
    try {
      await instance.request('thread/resume', {
        threadId: codexThreadId,
        cwd: workspaceRoot,
        runtimeWorkspaceRoots: [workspaceRoot],
        approvalPolicy: 'on-request',
        approvalsReviewer: 'auto_review',
        config: skillConfig,
        ...permissionSettings,
        developerInstructions,
        ...(model ? { model } : {}),
      });
    } catch {
      codexThreadId = '';
    }
  }

  if (!codexThreadId) {
    const started = await instance.request('thread/start', {
      cwd: workspaceRoot,
      runtimeWorkspaceRoots: [workspaceRoot],
      approvalPolicy: 'on-request',
      approvalsReviewer: 'auto_review',
      config: skillConfig,
      ...permissionSettings,
      serviceName: 'figcodex_local_bridge',
      developerInstructions,
      personality: 'friendly',
      dynamicTools: normalizeTools(message.tools),
      ...(model ? { model } : {}),
    });
    codexThreadId = started?.thread?.id;
    if (!codexThreadId) throw new Error('Codex app-server did not return a thread id.');
  }

  threadOwners.set(codexThreadId, socket);
  threadWorkspaceRoots.set(codexThreadId, workspaceRoot);
  socket.figcodexThreads.add(codexThreadId);
  const imagePaths = await saveImages(message.chatId, message.images);
  const input = [
    { type: 'text', text: String(message.prompt || ''), text_elements: [] },
    ...imagePaths.map((imagePath) => ({ type: 'localImage', path: imagePath })),
  ];
  threadPromptContexts.set(codexThreadId, String(message.prompt || '').slice(0, 80_000));
  let turn;
  try {
    turn = await instance.request('turn/start', {
      threadId: codexThreadId,
      input,
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    });
  } catch (error) {
    threadPromptContexts.delete(codexThreadId);
    throw error;
  }
  const turnId = turn?.turn?.id;
  if (turnId) {
    activeTurns.set(codexThreadId, turnId);
    turnContexts.set(turnId, String(message.prompt || '').slice(0, 80_000));
  }
  send(socket, { type: 'turn.accepted', requestId: message.requestId, threadId: codexThreadId, turnId });
}

async function handleMessage(socket, message, token) {
  if (!socket.figcodexAuthenticated) {
    if (message.type !== 'authenticate' || !sameToken(message.token, token)) {
      send(socket, { type: 'auth.error', error: 'Bridge pairing token is invalid.' });
      socket.close(4001, 'Unauthorized');
      return;
    }
    socket.figcodexAuthenticated = true;
    await ensureProviders();
    send(socket, {
      type: 'bridge.ready',
      bridgeVersion: BRIDGE_VERSION,
      providers: { codex: codexCatalog(), claude: claudeCatalog() },
      cliVersion: codexInfo?.version || '',
      codexBin: codexInfo?.binary || '',
      auth: loginStatus?.message || 'Logged in',
      models,
      permissionProfiles,
      appServerReady: Boolean(codex?.started),
      workspace: workspaceStore.publicState(),
    });
    await broadcastSkills(socket);
    return;
  }

  if (message.type === 'turn.start') {
    await startTurn(socket, message);
    return;
  }
  if (message.type === 'workspace.choose') {
    if (workspaceBusy() || workspaceSelectionPending) {
      send(socket, {
        type: 'workspace.error',
        error: workspaceSelectionPending
          ? 'A workspace folder picker is already open.'
          : 'Stop the active turn before changing workspace.',
      });
      return;
    }
    workspaceSelectionPending = true;
    try {
      await applyWorkspaceResult(await workspaceStore.choose(), socket);
    } catch (error) {
      send(socket, { type: 'workspace.error', error: publicError(error) });
    } finally {
      workspaceSelectionPending = false;
    }
    return;
  }
  if (message.type === 'workspace.clear') {
    if (workspaceBusy() || workspaceSelectionPending) {
      send(socket, {
        type: 'workspace.error',
        error: workspaceSelectionPending
          ? 'Close the open workspace folder picker first.'
          : 'Stop the active turn before changing workspace.',
      });
      return;
    }
    try {
      await applyWorkspaceResult(await workspaceStore.clear(), socket);
    } catch (error) {
      send(socket, { type: 'workspace.error', error: publicError(error) });
    }
    return;
  }
  if (message.type === 'turn.interrupt') {
    const provider = String(message.provider || 'codex');
    const threadId = String(message.threadId || '');
    const turnId = String(message.turnId || activeTurns.get(threadId) || '');
    if (provider === 'claude') {
      await (await ensureClaude()).interrupt(threadId, turnId);
    } else if (threadId && turnId) {
      await (await ensureCodex()).request('turn/interrupt', { threadId, turnId });
    }
    return;
  }
  if (message.type === 'tool.result') {
    const pending = pendingToolCalls.get(String(message.requestId));
    if (!pending || pending.socket !== socket) return;
    pendingToolCalls.delete(String(message.requestId));
    const result = message.result === undefined ? { ok: true } : message.result;
    const success = message.success !== false && !(result && typeof result === 'object' && 'error' in result);
    if (pending.provider === 'claude') {
      pending.resolve(result);
    } else {
      (await ensureCodex()).respond(pending.requestId, {
        contentItems: [{ type: 'inputText', text: JSON.stringify(result).slice(0, 500_000) }],
        success,
      });
    }
    return;
  }
  if (message.type === 'models.list') {
    const provider = String(message.provider || 'codex');
    send(socket, {
      type: 'models.list',
      provider,
      models: provider === 'claude' ? claudeProvider?.models || [] : models,
    });
    return;
  }
  if (message.type === 'skills.list') {
    await broadcastSkills(socket);
    return;
  }
  if (message.type === 'skills.import') {
    await skillStore.importLegacy(message.skills);
    await broadcastSkills();
    return;
  }
  if (message.type === 'skills.create') {
    try {
      await skillStore.create(message.skill || {});
      await broadcastSkills();
    } catch (error) {
      send(socket, { type: 'skills.error', error: publicError(error) });
    }
    return;
  }
  if (message.type === 'skills.remove') {
    try {
      await skillStore.remove(message.id);
      await broadcastSkills();
    } catch (error) {
      send(socket, { type: 'skills.error', error: publicError(error) });
    }
    return;
  }
  if (message.type === 'skills.mode') {
    try {
      await skillStore.setMode(message.id, message.mode);
      await broadcastSkills();
    } catch (error) {
      send(socket, { type: 'skills.error', error: publicError(error) });
    }
  }
}

await workspaceStore.initialize();
skillStore.setWorkspace(workspaceStore.selectedRoot);
const token = await ensureToken();
await Promise.allSettled([
  ensureCodex().catch((error) => console.error(`Codex preflight failed: ${publicError(error)}`)),
  ensureClaude().catch((error) => console.error(`Claude preflight failed: ${publicError(error)}`)),
]);

function handleHttpRequest(request, response) {
  if (request.method === 'GET' && request.url === '/health') {
    const ready = Boolean(codex?.started || claudeProvider);
    response.writeHead(ready ? 200 : 503, {
      'Content-Type': 'application/json; charset=utf-8',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });
    response.end(JSON.stringify({
      ok: ready,
      service: 'figcodex-local-bridge',
      version: BRIDGE_VERSION,
      cliVersion: codexInfo?.version || null,
      loggedIn: Boolean(loginStatus?.ok),
      requiresPairingToken: true,
      providers: { codex: codexCatalog(), claude: claudeCatalog() },
      error: ready ? null : `Codex: ${codexError || 'unavailable'} Claude: ${claudeError || 'unavailable'}`,
    }));
    return;
  }
  response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify({ error: 'Not found' }));
}

const webSocketServer = new WebSocketServer({ noServer: true, maxPayload: MAX_MESSAGE_BYTES });

function handleUpgrade(request, socket, head) {
  const url = new URL(request.url, `http://${request.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname !== '/ws') {
    socket.destroy();
    return;
  }
  webSocketServer.handleUpgrade(request, socket, head, (webSocket) => {
    webSocketServer.emit('connection', webSocket, request);
  });
}

function createBridgeServer() {
  const instance = http.createServer(handleHttpRequest);
  instance.on('upgrade', handleUpgrade);
  return instance;
}

const server = createBridgeServer();
server.on('error', async (error) => {
  console.error(`FigCC bridge could not listen on ${HOST}:${PORT}: ${publicError(error)}`);
  await codex?.stop();
  process.exit(1);
});

// `localhost` is not one address. Windows resolves it to ::1 before 127.0.0.1,
// while macOS usually does the reverse, so a bridge bound only to 127.0.0.1 is
// unreachable from a client that picks the IPv6 loopback -- which is what the
// Figma plugin does, and its manifest allowlists `ws://localhost:4319` only, so
// pointing it at a literal IPv4 address is not an option either.
//
// Serve both loopback addresses. This stays loopback-only: it does not widen
// the bind to other interfaces. An explicit FIGCODEX_HOST is always honoured
// verbatim.
const LOOPBACK_ALIASES = { '127.0.0.1': '::1', '::1': '127.0.0.1', localhost: '::1' };
const HOST_EXPLICIT = Boolean(process.env.FIGCODEX_HOST || process.env.FIGCLAW_HOST);
const SECONDARY_HOST = HOST_EXPLICIT ? null : LOOPBACK_ALIASES[HOST] || null;

function listenOnSecondaryLoopback() {
  if (!SECONDARY_HOST) return;
  const secondary = createBridgeServer();
  // A missing IPv6 stack, or something already on that address, must not take
  // the bridge down -- the primary listener is what the contract depends on.
  secondary.on('error', (error) => {
    console.log(`FigCC bridge is not serving ${SECONDARY_HOST}:${PORT}: ${publicError(error)}`);
  });
  secondary.listen(PORT, SECONDARY_HOST, () => {
    console.log(`FigCC Bridge also listening on http://${formatHost(SECONDARY_HOST)}:${PORT}`);
  });
}

function formatHost(host) {
  return host.includes(':') ? `[${host}]` : host;
}

webSocketServer.on('connection', (socket) => {
  sockets.add(socket);
  socket.figcodexAuthenticated = false;
  socket.figcodexThreads = new Set();
  const authTimer = setTimeout(() => socket.close(4001, 'Authentication timeout'), 8_000);
  authTimer.unref();

  socket.on('message', async (raw) => {
    try {
      const message = JSON.parse(String(raw));
      await handleMessage(socket, message, token);
      if (socket.figcodexAuthenticated) clearTimeout(authTimer);
    } catch (error) {
      send(socket, { type: 'bridge.error', error: publicError(error) });
    }
  });
  socket.on('close', () => {
    clearTimeout(authTimer);
    sockets.delete(socket);
    for (const threadId of socket.figcodexThreads) {
      if (threadOwners.get(threadId) === socket) threadOwners.delete(threadId);
    }
    for (const [requestId, pending] of pendingToolCalls.entries()) {
      if (pending.socket !== socket) continue;
      pendingToolCalls.delete(requestId);
      if (pending.provider === 'claude') {
        pending.resolve({ error: 'FigCC plugin disconnected before the tool completed.' });
      } else {
        codex?.respond(pending.requestId, {
          contentItems: [{ type: 'inputText', text: 'FigCC plugin disconnected before the tool completed.' }],
          success: false,
        });
      }
    }
  });
});

server.listen(PORT, HOST, () => {
  console.log(`FigCC Bridge listening on http://${formatHost(HOST)}:${PORT}`);
  listenOnSecondaryLoopback();
  console.log('Pairing token ready. Run npm run bridge:token to copy it safely.');
  if (codexInfo) console.log(`Codex CLI ${codexInfo.version}: ${codexInfo.binary}`);
  if (claudeInfo) console.log(`Claude Code ${claudeInfo.version}: ${claudeInfo.binary}`);
  if (codexError) console.log(`Codex warning: ${codexError}`);
  if (claudeError) console.log(`Claude warning: ${claudeError}`);
});
void startSkillWatcher();

async function shutdown() {
  if (skillWatcherRetry) clearTimeout(skillWatcherRetry);
  skillWatcher?.close();
  for (const socket of sockets) socket.close(1001, 'Bridge shutting down');
  await codex?.stop();
  await claudeProvider?.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 2_000).unref();
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
