import crypto from 'node:crypto';
import { createSdkMcpServer, query, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import {
  needsDynamicToolReview,
  parseReviewDecision,
  REVIEW_OUTPUT_SCHEMA,
  REVIEWER_INSTRUCTIONS,
  reviewableArguments,
} from './dynamic-tool-reviewer.js';

const CATALOG_TIMEOUT_MS = 20_000;
const REVIEW_TIMEOUT_MS = 90_000;

export const CLAUDE_PERMISSION_PROFILES = Object.freeze([
  {
    id: ':read-only',
    description: 'Read project files only; writes and commands are unavailable.',
    allowed: true,
  },
  {
    id: ':workspace',
    description: 'Allow edits inside this project; other actions are automatically reviewed.',
    allowed: true,
  },
  {
    id: ':auto',
    description: 'Let Claude Code classify local permission prompts automatically.',
    allowed: true,
  },
  {
    id: ':danger-full-access',
    description: 'Bypass Claude Code permission checks. Use only for a task you trust.',
    allowed: true,
  },
]);

function timeoutAfter(milliseconds, label) {
  return new Promise((_, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} timed out.`)), milliseconds);
    timer.unref();
  });
}

// Claude Code lists aliases ("Opus", "Sonnet"); show the version they resolve to.
function claudeModelLabel(model) {
  const fallback = String(model.displayName || model.value || '');
  const match = String(model.resolvedModel || '').match(/^claude-([a-z]+)-(\d+)(?:-(\d{1,2})(?!\d))?/);
  if (!match) return fallback;
  const name = `${match[1][0].toUpperCase()}${match[1].slice(1)} ${match[2]}${match[3] ? `.${match[3]}` : ''}`;
  return model.value === 'default' ? `Default (${name})` : name;
}

function schemaToZod(schema) {
  if (!schema || typeof schema !== 'object') return z.unknown();
  if (Array.isArray(schema.enum) && schema.enum.length > 0) {
    const values = schema.enum;
    return values.length === 1
      ? z.literal(values[0])
      : z.union(values.map((value) => z.literal(value)));
  }
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    return schema.anyOf.length === 1
      ? schemaToZod(schema.anyOf[0])
      : z.union(schema.anyOf.map(schemaToZod));
  }
  let value;
  switch (schema.type) {
    case 'string':
      value = z.string();
      if (Number.isFinite(schema.minLength)) value = value.min(schema.minLength);
      if (Number.isFinite(schema.maxLength)) value = value.max(schema.maxLength);
      break;
    case 'integer': value = z.number().int(); break;
    case 'number': value = z.number(); break;
    case 'boolean': value = z.boolean(); break;
    case 'array': value = z.array(schemaToZod(schema.items)); break;
    case 'object': {
      const required = new Set(Array.isArray(schema.required) ? schema.required : []);
      const shape = {};
      for (const [key, property] of Object.entries(schema.properties || {})) {
        const propertySchema = schemaToZod(property);
        shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
      }
      value = z.object(shape);
      break;
    }
    default: value = z.unknown();
  }
  if (schema.description && value?.describe) value = value.describe(String(schema.description));
  return value;
}

function toolShape(inputSchema) {
  const required = new Set(Array.isArray(inputSchema?.required) ? inputSchema.required : []);
  const shape = {};
  for (const [key, property] of Object.entries(inputSchema?.properties || {})) {
    const propertySchema = schemaToZod(property);
    shape[key] = required.has(key) ? propertySchema : propertySchema.optional();
  }
  return shape;
}

function contentText(message) {
  return (Array.isArray(message?.message?.content) ? message.message.content : [])
    .filter((block) => block?.type === 'text')
    .map((block) => String(block.text || ''))
    .join('');
}

function promptWithImages(prompt, images) {
  const blocks = [];
  for (const image of Array.isArray(images) ? images.slice(0, 5) : []) {
    const match = String(image?.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,([a-zA-Z0-9+/=]+)$/);
    if (!match || Buffer.byteLength(match[2], 'base64') > 12 * 1024 * 1024) continue;
    blocks.push({
      type: 'image',
      source: { type: 'base64', media_type: `image/${match[1]}`, data: match[2] },
    });
  }
  blocks.push({ type: 'text', text: String(prompt || '') });
  if (blocks.length === 1) return String(prompt || '');
  return (async function* imagePrompt() {
    yield {
      type: 'user',
      message: { role: 'user', content: blocks },
      parent_tool_use_id: null,
      uuid: crypto.randomUUID(),
    };
  }());
}

function profileOptions(profileId, mcpToolNames, canUseTool) {
  const commonReadTools = ['Read', 'Glob', 'Grep'];
  const commonWriteTools = [...commonReadTools, 'Edit', 'Write', 'Bash'];
  if (profileId === ':danger-full-access') {
    return {
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      tools: commonWriteTools,
      allowedTools: [...commonWriteTools, ...mcpToolNames],
    };
  }
  if (profileId === ':workspace') {
    return {
      permissionMode: 'acceptEdits',
      tools: commonWriteTools,
      allowedTools: [...commonReadTools, ...mcpToolNames],
      canUseTool,
    };
  }
  if (profileId === ':auto') {
    return {
      permissionMode: 'auto',
      tools: commonWriteTools,
      allowedTools: [...commonReadTools, ...mcpToolNames],
    };
  }
  return {
    permissionMode: 'dontAsk',
    tools: commonReadTools,
    allowedTools: [...commonReadTools, ...mcpToolNames],
  };
}

export class ClaudeProvider {
  constructor({ root, binary, version, send, executeTool }) {
    this.root = root;
    this.binary = binary;
    this.version = version;
    this.send = send;
    this.executeTool = executeTool;
    this.models = [];
    this.activeTurns = new Map();
  }

  baseOptions(root = this.root) {
    return {
      cwd: root,
      pathToClaudeCodeExecutable: this.binary,
      settingSources: ['project'],
      strictMcpConfig: true,
      persistSession: true,
    };
  }

  async initialize() {
    const controller = new AbortController();
    const idlePrompt = (async function* idle() {
      await new Promise((resolve) => controller.signal.addEventListener('abort', resolve, { once: true }));
    }());
    const session = query({
      prompt: idlePrompt,
      options: {
        ...this.baseOptions(),
        abortController: controller,
        persistSession: false,
        permissionMode: 'dontAsk',
        tools: [],
        allowedTools: [],
        skills: [],
      },
    });
    try {
      const liveModels = await Promise.race([
        session.supportedModels(),
        timeoutAfter(CATALOG_TIMEOUT_MS, 'Claude model catalog'),
      ]);
      this.models = (Array.isArray(liveModels) ? liveModels : []).slice(0, 100).map((model) => ({
        id: String(model.value || ''),
        label: claudeModelLabel(model),
        description: String(model.description || '').slice(0, 500),
        isDefault: Boolean(model.value === 'default'),
        supportedReasoningEfforts: (Array.isArray(model.supportedEffortLevels)
          ? model.supportedEffortLevels
          : model.supportsEffort
            ? ['low', 'medium', 'high']
            : [])
          .map((effort) => ({ id: String(effort), description: '' })),
        defaultReasoningEffort: '',
      })).filter((model) => model.id);
      return this.models;
    } finally {
      controller.abort();
      session.close();
    }
  }

  catalog() {
    return {
      id: 'claude',
      label: 'Claude',
      available: true,
      cliVersion: this.version,
      auth: 'Uses the local Claude Code login',
      models: this.models,
      permissionProfiles: CLAUDE_PERMISSION_PROFILES.map((profile) => ({ ...profile })),
    };
  }

  async review({ userPrompt, tool: toolName, arguments: args, workspaceRoot = this.root }) {
    const proposedArguments = reviewableArguments(toolName, args);
    const prompt = [
      'CURRENT USER REQUEST:',
      String(userPrompt || '').slice(0, 80_000),
      '',
      'PROPOSED TOOL:',
      String(toolName || ''),
      '',
      'PROPOSED ARGUMENTS:',
      JSON.stringify(proposedArguments, null, 2),
    ].join('\n');
    const controller = new AbortController();
    const session = query({
      prompt,
      options: {
        ...this.baseOptions(workspaceRoot),
        abortController: controller,
        persistSession: false,
        permissionMode: 'dontAsk',
        tools: [],
        allowedTools: [],
        skills: [],
        systemPrompt: REVIEWER_INSTRUCTIONS,
        outputFormat: { type: 'json_schema', schema: REVIEW_OUTPUT_SCHEMA },
        maxTurns: 1,
      },
    });
    try {
      const consume = (async () => {
        let lastText = '';
        for await (const message of session) {
          if (message.type === 'assistant') lastText = contentText(message) || lastText;
          if (message.type !== 'result') continue;
          const structured = message.structured_output;
          const parsed = structured && typeof structured === 'object'
            ? parseReviewDecision(JSON.stringify(structured))
            : parseReviewDecision(message.result || lastText);
          return parsed || {
            approved: false,
            risk: 'high',
            reason: 'Auto-review returned an invalid decision, so the action was denied.',
          };
        }
        return { approved: false, risk: 'high', reason: 'Auto-review ended without a decision.' };
      })();
      return await Promise.race([consume, timeoutAfter(REVIEW_TIMEOUT_MS, 'Claude auto-review')]);
    } catch (error) {
      return {
        approved: false,
        risk: 'high',
        reason: `Auto-review could not run: ${error instanceof Error ? error.message : String(error)}`.slice(0, 1_000),
      };
    } finally {
      controller.abort();
      session.close();
    }
  }

  async startTurn(socket, message, normalizedTools, workspaceRoot = this.root) {
    const turnId = crypto.randomUUID();
    const requestedSessionId = String(message.threadId || '').trim();
    const selectedModel = this.models.find((model) => model.id === String(message.model || '').trim());
    const selectedEffort = selectedModel?.supportedReasoningEfforts
      .some((item) => item.id === String(message.effort || '').trim())
      ? String(message.effort).trim()
      : '';
    const permissionProfile = CLAUDE_PERMISSION_PROFILES.some(
      (profile) => profile.id === message.permissionProfile
    ) ? message.permissionProfile : ':read-only';
    let nativeSessionId = requestedSessionId;
    const userPrompt = String(message.prompt || '').slice(0, 80_000);

    const definitions = normalizedTools.map((definition) => tool(
      definition.name,
      definition.description,
      toolShape(definition.inputSchema),
      async (args) => {
        let review = null;
        const reviewRequestId = crypto.randomUUID();
        if (needsDynamicToolReview(definition.name)) {
          this.send(socket, {
            type: 'review.started',
            requestId: reviewRequestId,
            threadId: nativeSessionId,
            turnId,
            tool: definition.name,
          });
          review = await this.review({
            userPrompt,
            tool: definition.name,
            arguments: args,
            workspaceRoot,
          });
          this.send(socket, {
            type: 'review.completed',
            requestId: reviewRequestId,
            threadId: nativeSessionId,
            turnId,
            tool: definition.name,
            ...review,
          });
          if (!review.approved) {
            return {
              content: [{ type: 'text', text: `FigCC auto-review denied ${definition.name}: ${review.reason}` }],
              isError: true,
            };
          }
        }
        const result = await this.executeTool(socket, {
          provider: 'claude',
          threadId: nativeSessionId,
          turnId,
          callId: crypto.randomUUID(),
          tool: definition.name,
          arguments: args,
          review,
          workspaceRoot,
        });
        const isError = Boolean(result && typeof result === 'object' && 'error' in result);
        return {
          content: [{ type: 'text', text: JSON.stringify(result).slice(0, 500_000) }],
          isError,
        };
      },
      { alwaysLoad: true },
    ));
    const mcpServer = createSdkMcpServer({
      name: 'figcodex',
      version: '1.0.0',
      instructions: 'Use these tools for all Figma canvas inspection and changes.',
      tools: definitions,
      alwaysLoad: true,
    });
    const mcpToolNames = normalizedTools.map((definition) => `mcp__figcodex__${definition.name}`);
    const permissionReviewer = async (toolName, input) => {
      const reviewRequestId = crypto.randomUUID();
      this.send(socket, {
        type: 'review.started', requestId: reviewRequestId, threadId: nativeSessionId, turnId, tool: toolName,
      });
      const review = await this.review({
        userPrompt,
        tool: toolName,
        arguments: input,
        workspaceRoot,
      });
      this.send(socket, {
        type: 'review.completed', requestId: reviewRequestId, threadId: nativeSessionId, turnId, tool: toolName, ...review,
      });
      return review.approved
        ? { behavior: 'allow', updatedInput: input }
        : { behavior: 'deny', message: review.reason };
    };
    const controller = new AbortController();
    const session = query({
      prompt: promptWithImages(userPrompt, message.images),
      options: {
        ...this.baseOptions(workspaceRoot),
        abortController: controller,
        includePartialMessages: true,
        systemPrompt: String(message.instructions || '').slice(0, 160_000),
        mcpServers: { figcodex: mcpServer },
        // FigCC injects only Active or explicitly @mentioned canonical
        // skills. Do not let Claude's native discovery bypass that UI mode.
        skills: [],
        ...(requestedSessionId ? { resume: requestedSessionId } : {}),
        ...(selectedModel ? { model: selectedModel.id } : {}),
        ...(selectedEffort ? { effort: selectedEffort } : {}),
        ...profileOptions(permissionProfile, mcpToolNames, permissionReviewer),
      },
    });
    const active = { session, controller, turnId };
    this.activeTurns.set(turnId, active);
    if (requestedSessionId) this.activeTurns.set(requestedSessionId, active);
    this.send(socket, {
      type: 'turn.accepted',
      requestId: message.requestId,
      ...(requestedSessionId ? { threadId: requestedSessionId } : {}),
      turnId,
    });

    try {
      for await (const sdkMessage of session) {
        if (sdkMessage.session_id && sdkMessage.session_id !== nativeSessionId) {
          nativeSessionId = String(sdkMessage.session_id);
          this.activeTurns.set(nativeSessionId, active);
          this.send(socket, { type: 'turn.started', threadId: nativeSessionId, turnId });
        }
        if (sdkMessage.type === 'stream_event') {
          const event = sdkMessage.event;
          if (event?.type === 'content_block_delta' && event.delta?.type === 'text_delta') {
            this.send(socket, {
              type: 'agent.delta', threadId: nativeSessionId, turnId, itemId: turnId, delta: event.delta.text,
            });
          }
          continue;
        }
        if (sdkMessage.type === 'assistant') {
          const text = contentText(sdkMessage);
          if (text) {
            this.send(socket, {
              type: 'agent.completed', threadId: nativeSessionId, turnId, itemId: turnId, text,
            });
          }
          continue;
        }
        if (sdkMessage.type !== 'result') continue;
        const failed = sdkMessage.is_error || sdkMessage.subtype !== 'success';
        const error = failed
          ? (Array.isArray(sdkMessage.errors) ? sdkMessage.errors.join('\n') : sdkMessage.result || 'Claude turn failed.')
          : null;
        this.send(socket, {
          type: 'turn.completed',
          threadId: nativeSessionId,
          turnId,
          status: failed ? 'failed' : 'completed',
          error,
        });
      }
    } catch (error) {
      const interrupted = controller.signal.aborted;
      this.send(socket, {
        type: 'turn.completed',
        threadId: nativeSessionId,
        turnId,
        status: interrupted ? 'interrupted' : 'failed',
        error: interrupted ? null : (error instanceof Error ? error.message : String(error)),
      });
    } finally {
      session.close();
      this.activeTurns.delete(turnId);
      if (requestedSessionId) this.activeTurns.delete(requestedSessionId);
      if (nativeSessionId) this.activeTurns.delete(nativeSessionId);
    }
  }

  async interrupt(threadId, turnId) {
    const active = this.activeTurns.get(String(threadId || '')) || this.activeTurns.get(String(turnId || ''));
    if (!active) return;
    active.controller.abort();
    await active.session.interrupt().catch(() => {});
  }

  async close() {
    const active = [...new Set(this.activeTurns.values())];
    this.activeTurns.clear();
    for (const item of active) {
      item.controller.abort();
      item.session.close();
    }
  }
}
