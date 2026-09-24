<script lang="ts">
  import Icon from './Icon.svelte';
  type TextPart = { type: 'text'; text: string } | { type: 'code'; lang: string; text: string };

  type DisplayMessage = {
    role: 'user' | 'assistant' | 'tool' | 'code';
    text: string;
    images?: string[];
    files?: Array<{ name: string; mediaType: string; size: number }>;
    toolName?: string;
    toolStatus?: 'running' | 'done' | 'error';
    figmaSelection?: string;
    strippedImageCount?: number;
  };

  let { msg, provider = 'codex' }: { msg: DisplayMessage; provider?: 'codex' | 'claude' } = $props();

  function splitCodeBlocks(text: string): TextPart[] {
    const parts: TextPart[] = [];
    const regex = /```(\w*)\n?([\s\S]*?)```/g;
    let last = 0;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(text)) !== null) {
      if (match.index > last) {
        const t = text.slice(last, match.index).trim();
        if (t) parts.push({ type: 'text', text: t });
      }
      parts.push({ type: 'code', lang: match[1] || 'code', text: match[2].trim() });
      last = match.index + match[0].length;
    }
    const tail = text.slice(last).trim();
    if (tail) parts.push({ type: 'text', text: tail });
    return parts.length ? parts : [{ type: 'text', text }];
  }

  function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }
</script>

{#if msg.role === 'tool'}
  <div
    class="tool-call"
    class:running={msg.toolStatus === 'running'}
    class:done={msg.toolStatus === 'done'}
    class:error={msg.toolStatus === 'error'}
  >
    <Icon name={msg.toolStatus === 'running' ? 'spinner' : msg.toolStatus === 'error' ? 'close' : 'tick'} />
    <span class="tool-name">{msg.text}</span>
  </div>
{:else}
  <div class="message {msg.role}">
    {#if msg.role === 'assistant'}
      <p class="meta">{provider === 'claude' ? 'Claude' : 'Codex'}</p>
    {/if}
    {#if msg.role === 'user' && msg.figmaSelection}
      <div class="figma-context">
        <Icon name="preview" size={12} />
        <span>{msg.figmaSelection}</span>
      </div>
    {/if}
    {#if msg.images && msg.images.length > 0}
      <div class="image-grid">
        {#each msg.images as src}
          <img class="attached-img" {src} alt="attachment" />
        {/each}
      </div>
    {/if}
    {#if msg.strippedImageCount}
      <div class="stripped-note">
        {msg.strippedImageCount}
        {msg.strippedImageCount > 1 ? 'images' : 'image'} not kept in history
      </div>
    {/if}
    {#if msg.files && msg.files.length > 0}
      <div class="attached-files">
        {#each msg.files as file}
          <div class="attached-file" title={file.name}>
            <Icon name="paperclip" size={12} />
            <span class="attached-file-name">{file.name}</span>
            <span class="attached-file-size">{formatBytes(file.size)}</span>
          </div>
        {/each}
      </div>
    {/if}
    <div class="content-wrap">
      {#each splitCodeBlocks(msg.text) as part}
        {#if part.type === 'code'}
          <details class="code-block inline-code-block">
            <summary class="code-header">
              <span>{part.lang || 'code'}</span>
              <span class="code-toggle-hint">show</span>
            </summary>
            <pre class="code-body">{part.text}</pre>
          </details>
        {:else if part.text}
          <p class="body">{part.text}</p>
        {/if}
      {/each}
    </div>
  </div>
{/if}

<style>
  .message {
    border-radius: var(--radius-md);
    padding: 9px 11px;
    line-height: 1.5;
  }

  .message.user {
    background: var(--color-accent-bg);
    border: 1px solid var(--color-border-1);
    align-self: flex-end;
    max-width: 90%;
  }

  .message.assistant {
    background: transparent;
    align-self: flex-start;
    max-width: 95%;
  }

  .meta {
    color: var(--color-text-tertiary);
    font-size: 10px;
    margin: 0 0 3px;
  }

  .figma-context {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    max-width: 100%;
    margin-bottom: 6px;
    padding: 3px 6px;
    border: 1px solid var(--color-teal-border);
    border-radius: var(--radius-pill);
    background: var(--color-teal-bg);
    color: var(--color-teal);
    font-size: 10px;
  }

  .figma-context span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .content-wrap {
    display: flex;
    flex-direction: column;
    gap: 8px;
  }

  .body {
    font-size: 13px;
    margin: 0;
    white-space: pre-wrap;
    word-break: break-word;
  }

  .stripped-note {
    margin-bottom: 6px;
    font-size: 11px;
    font-style: italic;
    opacity: 0.5;
  }

  /* Attached images */
  .image-grid {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-bottom: 6px;
  }

  .attached-img {
    max-width: 120px;
    max-height: 120px;
    border-radius: var(--radius-md);
    object-fit: cover;
    border: 1px solid var(--color-border-1);
    cursor: zoom-in;
  }

  .attached-files {
    display: flex;
    flex-direction: column;
    gap: 4px;
    margin-bottom: 6px;
  }

  .attached-file {
    display: flex;
    align-items: center;
    gap: 5px;
    min-width: 0;
    padding: 4px 6px;
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-md);
    color: var(--color-text-secondary);
    font-size: 10px;
  }

  .attached-file-name {
    overflow: hidden;
    flex: 1;
    color: var(--color-text-primary);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .attached-file-size {
    flex-shrink: 0;
    color: var(--color-text-tertiary);
  }

  /* Code block */
  .inline-code-block {
    margin: 4px 0;
  }

  .code-block {
    border-radius: var(--radius-md);
    overflow: hidden;
    border: 1px solid transparent;
    align-self: flex-start;
    width: 100%;
    border-color: var(--color-border-1);
  }

  .code-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--color-surface-1);
    padding: 4px 10px;
    font-size: 10px;
    gap: 6px;
    opacity: 0.6;
    font-family: monospace;
    cursor: pointer;
    list-style: none;
    user-select: none;
    border: none;
  }

  .code-header::-webkit-details-marker {
    display: none;
  }

  .code-toggle-hint {
    font-size: 10px;
    opacity: 0.5;
  }

  .code-block[open] .code-toggle-hint {
    display: none;
  }

  .code-body {
    margin: 0;
    padding: 10px;
    background: var(--color-overlay-30);
    font-family: 'Menlo', 'Monaco', 'Courier New', monospace;
    font-size: 11px;
    line-height: 1.6;
    white-space: pre;
    overflow-x: auto;
    color: var(--color-text-secondary);
  }

  /* Tool call pill */
  .tool-call {
    display: flex;
    gap: 6px;
    font-size: 11px;
    line-height: 1.4;
    padding: 6px 8px;
    border-radius: var(--radius-pill);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    width: fit-content;
    opacity: 0.75;
  }

  .tool-call.running {
    border-color: var(--color-teal-border);
    color: var(--color-teal);
    opacity: 1;
  }

  .tool-call.done {
    border-color: var(--color-green-border);
    color: var(--color-green);
  }

  .tool-call.error {
    border-color: var(--color-danger-border);
    color: var(--color-danger);
    opacity: 1;
  }

  .tool-name {
    font-family: inherit;
    font-size: 11px;
    font-weight: 500;
    letter-spacing: 0;
  }
</style>
