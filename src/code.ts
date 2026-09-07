// ─── Constants ────────────────────────────────────────────────────────────────
const STORAGE_KEY_SETTINGS = 'figcodex_settings_v1';
const STORAGE_KEY_SKILLS = 'figcodex_skills_v1';
const STORAGE_KEY_HISTORY = 'figcodex_chat_history_v2';
const LEGACY_STORAGE_KEY_SETTINGS = 'figclaw_codex_settings_v1';
const LEGACY_STORAGE_KEY_FIGCLAW_SKILLS = 'figclaw_skills_v1';
const LEGACY_STORAGE_KEY_FIGCLAW_HISTORY = 'figclaw_chat_history_v2';
const LEGACY_STORAGE_KEY_SKILLS = 'claude_skills';
const LEGACY_STORAGE_KEY_HISTORY = 'claude_chat_history';
const MAX_SELECTION_NODES = 12;
const MAX_SELECTION_PREVIEWS = 3;
const MAX_SELECTION_TEXT_LENGTH = 12_000;
const MAX_PREVIEW_BYTES = 8 * 1024 * 1024;
const PREVIEW_MAX_EDGE = 768;
const DEFAULT_SETTINGS = {
  bridgeUrl: 'http://localhost:4319',
  bridgeToken: '',
  provider: 'codex' as 'codex' | 'claude',
  runtimes: {
    codex: { model: '', effort: '', permissionProfile: ':read-only' },
    claude: { model: '', effort: '', permissionProfile: ':read-only' },
  },
};

figma.showUI(__html__, { themeColors: true, width: 400, height: 680 });

// ─── Init ─────────────────────────────────────────────────────────────────────
async function postInitState() {
  const settings = await getSettings();
  const skills = await getSkills();
  const chatHistory = await getChatHistory();
  figma.ui.postMessage({
    type: 'init',
    settings,
    skills,
    chatHistory,
  });
  scheduleSelectionContext(0);
}

async function getSettings(): Promise<typeof DEFAULT_SETTINGS> {
  const raw = await figma.clientStorage.getAsync(STORAGE_KEY_SETTINGS)
    || await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY_SETTINGS);
  const value = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const runtimes = value.runtimes && typeof value.runtimes === 'object'
    ? value.runtimes as Record<string, Record<string, unknown>>
    : {};
  return {
    bridgeUrl: String(value.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl),
    bridgeToken: String(value.bridgeToken || ''),
    provider: value.provider === 'claude' ? 'claude' : 'codex',
    runtimes: {
      codex: {
        model: String(runtimes.codex?.model || value.model || ''),
        effort: String(runtimes.codex?.effort || value.effort || ''),
        permissionProfile: String(runtimes.codex?.permissionProfile || value.permissionProfile || ':read-only'),
      },
      claude: {
        model: String(runtimes.claude?.model || ''),
        effort: String(runtimes.claude?.effort || ''),
        permissionProfile: String(runtimes.claude?.permissionProfile || ':read-only'),
      },
    },
  };
}

async function saveSettings(input: unknown): Promise<void> {
  const value = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const runtimes = value.runtimes && typeof value.runtimes === 'object'
    ? value.runtimes as Record<string, Record<string, unknown>>
    : {};
  const settings = {
    bridgeUrl: String(value.bridgeUrl || DEFAULT_SETTINGS.bridgeUrl).trim(),
    bridgeToken: String(value.bridgeToken || '').trim(),
    provider: value.provider === 'claude' ? 'claude' as const : 'codex' as const,
    runtimes: {
      codex: {
        model: String(runtimes.codex?.model || '').trim(),
        effort: String(runtimes.codex?.effort || '').trim(),
        permissionProfile: String(runtimes.codex?.permissionProfile || ':read-only').trim(),
      },
      claude: {
        model: String(runtimes.claude?.model || '').trim(),
        effort: String(runtimes.claude?.effort || '').trim(),
        permissionProfile: String(runtimes.claude?.permissionProfile || ':read-only').trim(),
      },
    },
  };
  await figma.clientStorage.setAsync(STORAGE_KEY_SETTINGS, settings);
  figma.ui.postMessage({ type: 'settings-saved', settings });
}

// ─── Skills storage ───────────────────────────────────────────────────────────
async function getSkills(): Promise<unknown[]> {
  const raw = await figma.clientStorage.getAsync(STORAGE_KEY_SKILLS)
    || await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY_FIGCLAW_SKILLS)
    || await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY_SKILLS);
  if (!raw) return [];
  try {
    return Array.isArray(raw) ? raw : JSON.parse(String(raw));
  } catch (_e) {
    return [];
  }
}

async function saveSkills(skills: unknown[]): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY_SKILLS, skills);
}

async function saveRuntimePreferences(
  provider: unknown,
  model: unknown,
  effort: unknown,
  permissionProfile: unknown
): Promise<void> {
  const current = await getSettings();
  const providerId = provider === 'claude' ? 'claude' : 'codex';
  await figma.clientStorage.setAsync(STORAGE_KEY_SETTINGS, {
    ...current,
    provider: providerId,
    runtimes: {
      ...current.runtimes,
      [providerId]: {
        model: String(model || '').trim(),
        effort: String(effort || '').trim(),
        permissionProfile: String(permissionProfile || ':read-only').trim(),
      },
    },
  });
}

// ─── Chat history storage ─────────────────────────────────────────────────────
async function getChatHistory(): Promise<unknown[]> {
  const raw = await figma.clientStorage.getAsync(STORAGE_KEY_HISTORY)
    || await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY_FIGCLAW_HISTORY)
    || await figma.clientStorage.getAsync(LEGACY_STORAGE_KEY_HISTORY);
  if (!raw) return [];
  try {
    return Array.isArray(raw) ? raw : JSON.parse(String(raw));
  } catch (_e) {
    return [];
  }
}

async function saveChatHistory(chats: unknown[]): Promise<void> {
  await figma.clientStorage.setAsync(STORAGE_KEY_HISTORY, chats);
}

type PluginMessage = { type: string; [key: string]: unknown };

async function handleStorageMessage(msg: PluginMessage): Promise<boolean> {
  if (msg.type === 'request-init') {
    await postInitState();
    return true;
  }

  if (msg.type === 'save-settings') {
    await saveSettings(msg.settings);
    return true;
  }

  if (msg.type === 'save-runtime-preferences') {
    await saveRuntimePreferences(msg.provider, msg.model, msg.effort, msg.permissionProfile);
    return true;
  }

  if (msg.type === 'get-skills') {
    const skills = await getSkills();
    figma.ui.postMessage({ type: 'skills-value', skills: Array.isArray(skills) ? skills : [] });
    return true;
  }

  if (msg.type === 'save-skills') {
    const skills = Array.isArray(msg.skills) ? msg.skills : [];
    await saveSkills(skills);
    figma.ui.postMessage({ type: 'skills-saved' });
    return true;
  }

  if (msg.type === 'save-chat-history') {
    const chats = Array.isArray(msg.chats) ? msg.chats : [];
    await saveChatHistory(chats);
    return true;
  }

  return false;
}

// ─── Code runner ──────────────────────────────────────────────────────────────
// Wraps the user code in an async IIFE so top-level await works,
// then injects `figma` into scope via a Function constructor.
async function runCode(code: string): Promise<unknown> {
  // The Function receives `figma` as its only argument.
  // We wrap the code in an async block so Codex can freely use await.
  const wrapped = `return (async () => { ${code} })()`;
  // eslint-disable-next-line no-new-func
  const fn = new Function('figma', wrapped);
  const result = await fn(figma);
  return result !== undefined ? result : { ok: true };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function serializeNode(node: SceneNode): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: node.id,
    name: node.name,
    type: node.type,
    visible: node.visible,
  };

  if ('x' in node) base.x = node.x;
  if ('y' in node) base.y = node.y;
  if ('width' in node) base.width = node.width;
  if ('height' in node) base.height = node.height;
  if ('opacity' in node) base.opacity = node.opacity;

  if ('fills' in node) {
    const fills = node.fills;
    if (Array.isArray(fills)) {
      base.fills = fills.map((f) => {
        if (f.type === 'SOLID') {
          return {
            type: 'SOLID',
            color: f.color,
            opacity: f.opacity,
          };
        }
        return { type: f.type };
      });
    }
  }

  if ('characters' in node) base.characters = node.characters;
  if ('fontSize' in node) base.fontSize = node.fontSize;
  if ('fontName' in node) base.fontName = node.fontName;

  if ('children' in node) {
    base.childCount = (node as ChildrenMixin).children.length;
    base.children = (node as ChildrenMixin).children.map(serializeNode);
  }

  return base;
}

type SelectionContextNodePayload = {
  id: string;
  name: string;
  type: string;
  kind: 'text' | 'image' | 'visual';
  width: number;
  height: number;
  x: number;
  y: number;
  visible: boolean;
  locked?: boolean;
  text?: string;
  textLength?: number;
  textTruncated?: boolean;
  style?: Record<string, unknown>;
  fills?: unknown[];
  previewDataUrl?: string;
};

type SelectionContextPayload = {
  revision: number;
  pageId: string;
  pageName: string;
  total: number;
  truncated: boolean;
  nodes: SelectionContextNodePayload[];
};

let selectionRevision = 0;
let selectionTimer: ReturnType<typeof setTimeout> | null = null;

function roundNumber(value: number): number {
  return Math.round(value * 100) / 100;
}

function safeMixedValue(value: unknown): unknown {
  if (value === figma.mixed) return 'mixed';
  if (value === undefined) return undefined;
  try {
    return JSON.parse(JSON.stringify(value));
  } catch {
    return String(value);
  }
}

function colorToHex(color: RGB): string {
  const channel = (value: number) => Math.round(value * 255).toString(16).padStart(2, '0');
  return `#${channel(color.r)}${channel(color.g)}${channel(color.b)}`.toUpperCase();
}

function summarizePaints(node: SceneNode): unknown[] | undefined {
  if (!('fills' in node) || !Array.isArray(node.fills)) return undefined;
  return node.fills.slice(0, 4).map((paint) => {
    if (paint.type === 'SOLID') {
      return {
        type: paint.type,
        color: colorToHex(paint.color),
        opacity: paint.opacity ?? 1,
      };
    }
    if (paint.type === 'IMAGE') {
      return {
        type: paint.type,
        scaleMode: paint.scaleMode,
        opacity: paint.opacity ?? 1,
      };
    }
    return { type: paint.type, opacity: 'opacity' in paint ? paint.opacity ?? 1 : 1 };
  });
}

function selectionNodePayload(node: SceneNode): SelectionContextNodePayload {
  const fills = summarizePaints(node);
  const hasImageFill = Boolean(fills?.some((paint) => (
    paint && typeof paint === 'object' && (paint as Record<string, unknown>).type === 'IMAGE'
  )));
  const payload: SelectionContextNodePayload = {
    id: node.id,
    name: String(node.name || node.type).slice(0, 500),
    type: node.type,
    kind: node.type === 'TEXT' ? 'text' : hasImageFill ? 'image' : 'visual',
    width: roundNumber(node.width),
    height: roundNumber(node.height),
    x: roundNumber(node.x),
    y: roundNumber(node.y),
    visible: node.visible,
    ...('locked' in node ? { locked: Boolean(node.locked) } : {}),
    ...(fills && fills.length > 0 ? { fills } : {}),
  };

  if (node.type === 'TEXT') {
    const text = node.characters;
    payload.text = text.slice(0, MAX_SELECTION_TEXT_LENGTH);
    payload.textLength = text.length;
    payload.textTruncated = text.length > MAX_SELECTION_TEXT_LENGTH;
    payload.style = {
      fontName: safeMixedValue(node.fontName),
      fontSize: safeMixedValue(node.fontSize),
      fontWeight: safeMixedValue(node.fontWeight),
      textAlignHorizontal: node.textAlignHorizontal,
      textAlignVertical: node.textAlignVertical,
      textAutoResize: node.textAutoResize,
      textCase: safeMixedValue(node.textCase),
      textDecoration: safeMixedValue(node.textDecoration),
      letterSpacing: safeMixedValue(node.letterSpacing),
      lineHeight: safeMixedValue(node.lineHeight),
      paragraphSpacing: safeMixedValue(node.paragraphSpacing),
    };
  }

  return payload;
}

async function buildSelectionContext(revision: number): Promise<SelectionContextPayload> {
  const selected = [...figma.currentPage.selection];
  const limited = selected.slice(0, MAX_SELECTION_NODES);
  const nodes = limited.map(selectionNodePayload);
  let previewCount = 0;

  for (let index = 0; index < limited.length && previewCount < MAX_SELECTION_PREVIEWS; index += 1) {
    const node = limited[index];
    if (node.type === 'TEXT' || !('exportAsync' in node)) continue;
    try {
      const longestEdge = Math.max(node.width, node.height);
      const scale = longestEdge > 0
        ? Math.max(0.1, Math.min(2, PREVIEW_MAX_EDGE / longestEdge))
        : 1;
      const bytes = await node.exportAsync({
        format: 'PNG',
        constraint: { type: 'SCALE', value: scale },
      });
      if (bytes.length > 0 && bytes.length <= MAX_PREVIEW_BYTES) {
        nodes[index].previewDataUrl = `data:image/png;base64,${figma.base64Encode(bytes)}`;
        previewCount += 1;
      }
    } catch {
      // Some Figma/FigJam node types cannot be exported. Metadata is still useful context.
    }
  }

  return {
    revision,
    pageId: figma.currentPage.id,
    pageName: figma.currentPage.name,
    total: selected.length,
    truncated: selected.length > limited.length,
    nodes,
  };
}

function scheduleSelectionContext(delay = 120): void {
  selectionRevision += 1;
  const revision = selectionRevision;
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(async () => {
    selectionTimer = null;
    try {
      const context = await buildSelectionContext(revision);
      if (revision !== selectionRevision) return;
      figma.ui.postMessage({ type: 'selection-context', context });
    } catch (error) {
      if (revision !== selectionRevision) return;
      figma.ui.postMessage({
        type: 'selection-context-error',
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }, delay);
}

async function resolveNodeById(id: string): Promise<SceneNode | null> {
  return await figma.getNodeByIdAsync(id) as SceneNode | null;
}

// ─── Tool Executor ────────────────────────────────────────────────────────────
async function executeTool(name: string, input: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case 'get_selection': {
      const nodes = figma.currentPage.selection;
      if (nodes.length === 0) return { nodes: [], message: 'Nothing is selected.' };
      return { nodes: nodes.map(serializeNode) };
    }

    case 'get_page_nodes': {
      const depth = typeof input.depth === 'number' ? input.depth : 2;
      const summarize = (nodes: readonly SceneNode[], d: number): unknown[] =>
        nodes.map((n) => {
          const s = serializeNode(n);
          if (d <= 1) delete s.children;
          else if ('children' in n && d > 1) {
            s.children = summarize((n as ChildrenMixin).children, d - 1);
          }
          return s;
        });
      return { nodes: summarize(figma.currentPage.children, depth) };
    }

    case 'get_node_by_id': {
      const node = await resolveNodeById(String(input.id));
      if (!node) return { error: 'Node not found: ' + input.id };
      return { node: serializeNode(node) };
    }

    case 'get_styles': {
      const paintStyles = (await figma.getLocalPaintStylesAsync()).map((s) => ({
        id: s.id,
        name: s.name,
        type: 'paint',
        // Without the paints, a caller only sees style names and cannot tell
        // which one holds the colour it needs, so it resorts to a raw value.
        paints: s.paints,
      }));
      const textStyles = (await figma.getLocalTextStylesAsync()).map((s) => ({
        id: s.id,
        name: s.name,
        type: 'text',
        fontSize: s.fontSize,
        fontName: s.fontName,
        lineHeight: s.lineHeight,
        letterSpacing: s.letterSpacing,
      }));
      const effectStyles = (await figma.getLocalEffectStylesAsync()).map((s) => ({
        id: s.id,
        name: s.name,
        type: 'effect',
        effects: s.effects,
      }));
      const gridStyles = (await figma.getLocalGridStylesAsync()).map((s) => ({
        id: s.id,
        name: s.name,
        type: 'grid',
      }));
      return { paintStyles, textStyles, effectStyles, gridStyles };
    }

    case 'get_variables': {
      const localCollections = await figma.variables.getLocalVariableCollectionsAsync();
      const collections = await Promise.all(localCollections.map(async (col) => ({
        id: col.id,
        name: col.name,
        modes: col.modes,
        defaultModeId: col.defaultModeId,
        variables: await Promise.all(col.variableIds.map(async (varId) => {
          const v = await figma.variables.getVariableByIdAsync(varId);
          if (!v) return { id: varId };
          return {
            id: v.id,
            name: v.name,
            resolvedType: v.resolvedType,
            scopes: v.scopes,
            valuesByMode: v.valuesByMode,
          };
        })),
      })));
      return { collections };
    }

    case 'get_components': {
      const components = figma.currentPage
        .findAll((n) => n.type === 'COMPONENT' || n.type === 'COMPONENT_SET')
        .map((n) => {
          const base: Record<string, unknown> = {
            id: n.id,
            name: n.name,
            type: n.type,
          };
          if ('description' in n) base.description = n.description;
          if ('componentPropertyDefinitions' in n)
            base.componentPropertyDefinitions = n.componentPropertyDefinitions;
          return base;
        });
      return { components };
    }

    case 'get_pages': {
      const pages = figma.root.children.map((p) => ({
        id: p.id,
        name: p.name,
        nodeCount: p.children.length,
        isCurrent: p.id === figma.currentPage.id,
      }));
      return { pages };
    }

    case 'notify': {
      figma.notify(String(input.message || ''), {
        timeout: typeof input.timeout === 'number' ? input.timeout : 3000,
        error: input.error === true,
      });
      return { notified: true };
    }

    case 'create_skill': {
      const name = String(input.name || '').trim();
      const content = String(input.content || '');
      if (!name) return { error: 'name is required.' };
      const newSkill: Record<string, unknown> = {
        id: 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
          const r = (Math.random() * 16) | 0;
          return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        }),
        name,
        content,
        fileName: `${name}.md`,
        addedAt: Date.now(),
      };
      const allSkills = (await getSkills()) as Array<Record<string, unknown>>;
      allSkills.push(newSkill);
      await saveSkills(allSkills);
      figma.ui.postMessage({ type: 'skills-updated', skills: allSkills });
      return { created: true, id: newSkill.id, name: newSkill.name };
    }

    case 'update_skill': {
      const id = String(input.id || '');
      const content = String(input.content || '');
      const newName = input.name !== undefined ? String(input.name) : undefined;
      if (!id) return { error: 'id is required.' };
      const allSkills = (await getSkills()) as Array<Record<string, unknown>>;
      const idx = allSkills.findIndex((s) => s.id === id);
      if (idx === -1) return { error: `Skill with id "${id}" not found.` };
      if (newName !== undefined) allSkills[idx].name = newName;
      allSkills[idx].content = content;
      await saveSkills(allSkills);
      figma.ui.postMessage({ type: 'skills-updated', skills: allSkills });
      return { updated: true, id, name: allSkills[idx].name };
    }

    case 'download_files': {
      const files = Array.isArray(input.files) ? input.files : [];
      if (files.length === 0) return { error: 'No files provided.' };

      const serialized = files.map((f: Record<string, unknown>) => {
        const content = f.content;
        // Uint8Array comes through as an object with numeric keys — convert to plain array for postMessage
        const isUint8 =
          content instanceof Uint8Array ||
          (content !== null &&
            typeof content === 'object' &&
            !Array.isArray(content) &&
            Object.prototype.toString.call(content) === '[object Uint8Array]');
        return {
          filename: String(f.filename || 'export'),
          mimeType: String(f.mimeType || 'application/octet-stream'),
          content: isUint8 ? Array.from(content as Uint8Array) : content,
          isBinary: isUint8,
        };
      });

      figma.ui.postMessage({ type: 'download-files', files: serialized });
      return {
        downloading: serialized.length,
        files: serialized.map((f: Record<string, unknown>) => f.filename),
      };
    }

    default:
      return { error: 'Unknown tool: ' + name };
  }
}

// ─── Message Handler ──────────────────────────────────────────────────────────
figma.on('selectionchange', () => scheduleSelectionContext());

figma.ui.onmessage = async (msg: PluginMessage) => {
  try {
    const handledStorage = await handleStorageMessage(msg);
    if (handledStorage) {
      return;
    }

    if (msg.type === 'request-selection-context') {
      const requestId = String(msg.requestId || '');
      selectionRevision += 1;
      const revision = selectionRevision;
      if (selectionTimer) {
        clearTimeout(selectionTimer);
        selectionTimer = null;
      }
      try {
        const context = await buildSelectionContext(revision);
        figma.ui.postMessage({ type: 'selection-context-response', requestId, context });
        if (revision === selectionRevision) {
          figma.ui.postMessage({ type: 'selection-context', context });
        }
      } catch (error) {
        figma.ui.postMessage({
          type: 'selection-context-response',
          requestId,
          context: null,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }

    if (msg.type === 'resize') {
      const w = typeof msg.width === 'number' ? msg.width : 400;
      const h = typeof msg.height === 'number' ? msg.height : 680;
      // The panel drives its own resize grip, so clamp both axes here rather
      // than trusting whatever the drag produced.
      figma.ui.resize(Math.max(w, 320), Math.max(h, 200));
      return;
    }

    if (msg.type === 'execute-tool') {
      const toolName = String(msg.toolName);
      const toolInput = (msg.toolInput || {}) as Record<string, unknown>;
      try {
        let result: unknown;
        if (toolName === 'run_figma_code') {
          const code = String(toolInput.code || '');
          result = await runCode(code);
        } else {
          result = await executeTool(toolName, toolInput);
        }
        // Ensure result is JSON-serialisable before posting
        const safe = JSON.parse(JSON.stringify(result !== undefined ? result : { ok: true }));
        figma.ui.postMessage({ type: 'tool-result', toolUseId: msg.toolUseId, result: safe });
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        figma.ui.postMessage({
          type: 'tool-result',
          toolUseId: msg.toolUseId,
          result: { error: errMsg },
        });
      }
      return;
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unexpected plugin error.';
    figma.ui.postMessage({ type: 'chat-error', error: errorMessage });
  }
};
