<script lang="ts">
  import Badge from './Badge.svelte';
  import Button from './Button.svelte';
  import Icon from './Icon.svelte';
  import EmptyState from './EmptyState.svelte';

  type DisplayMessage = {
    role: 'user' | 'assistant' | 'tool' | 'code';
    text: string;
    images?: string[];
    files?: Array<{ name: string; mediaType: string; size: number }>;
    toolName?: string;
    toolStatus?: 'running' | 'done' | 'error';
  };

  type ContentBlock =
    | { type: 'text'; text: string }
    | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    | { type: 'tool_result'; tool_use_id: string; content: string };

  type ApiMessage = {
    role: 'user' | 'assistant';
    content: string | ContentBlock[];
  };

  type SavedChat = {
    id: string;
    title: string;
    savedAt: number;
    displayMessages: DisplayMessage[];
    apiHistory?: ApiMessage[];
    threadId?: string | null;
    sessionId?: string | null;
    provider?: 'codex' | 'claude';
    policyVersion?: string;
    fileName?: string;
  };

  let {
    savedChats = [],
    currentChatId = '',
    currentFileName = '',
    onResume,
    onDelete,
    onUnapply,
    onMove,
  }: {
    savedChats?: SavedChat[];
    currentChatId?: string;
    currentFileName?: string;
    onResume: (chat: SavedChat) => void;
    onDelete: (id: string) => void;
    onUnapply: () => void;
    // targetFileName is '' for the Ungrouped bucket, matching how a chat with
    // no fileName is grouped.
    onMove: (chatId: string, targetFileName: string) => void;
  } = $props();

  const UNGROUPED = 'Ungrouped';

  // Chats are grouped by the Figma document they were held in. Chats saved
  // before the file name was recorded have none, so they collect under one
  // heading rather than being hidden or misfiled.
  let groups = $derived.by(() => {
    const byFile = new Map<string, SavedChat[]>();
    for (const chat of savedChats) {
      const key = chat.fileName?.trim() || UNGROUPED;
      const bucket = byFile.get(key);
      if (bucket) bucket.push(chat);
      else byFile.set(key, [chat]);
    }
    return [...byFile.entries()]
      .map(([name, chats]) => ({
        name,
        chats,
        isCurrentFile: Boolean(currentFileName) && name === currentFileName,
        newest: Math.max(...chats.map((c) => c.savedAt || 0)),
      }))
      .sort((a, b) => {
        // The document in front of the user first, then most recent activity,
        // with the undated leftovers last.
        if (a.isCurrentFile !== b.isCurrentFile) return a.isCurrentFile ? -1 : 1;
        if ((a.name === UNGROUPED) !== (b.name === UNGROUPED)) return a.name === UNGROUPED ? 1 : -1;
        return b.newest - a.newest;
      });
  });

  function formatDate(ts: number): string {
    const d = new Date(ts);
    const now = new Date();
    const isToday =
      d.getDate() === now.getDate() &&
      d.getMonth() === now.getMonth() &&
      d.getFullYear() === now.getFullYear();
    if (isToday) {
      return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
  }

  function msgCount(chat: SavedChat): number {
    return chat.displayMessages.filter((m) => m.role === 'user' || m.role === 'assistant').length;
  }

  function providerName(chat: SavedChat): string {
    return chat.provider === 'claude' ? 'Claude' : 'Codex';
  }

  let listEl = $state<HTMLElement | null>(null);
  let canScrollUp = $state(false);
  let canScrollDown = $state(false);

  // Drag-and-drop moves a chat between project groups. A "Move to…" select is
  // kept alongside it because the group headings are one thin sticky row --
  // an easy miss to drop onto in a 320-680px panel.
  let draggingId = $state<string | null>(null);
  let dragOverGroup = $state<string | null>(null);

  function groupKeyFor(chat: SavedChat): string {
    return chat.fileName?.trim() || UNGROUPED;
  }

  function handleDrop(groupName: string, event: DragEvent) {
    event.preventDefault();
    dragOverGroup = null;
    const id = event.dataTransfer?.getData('text/plain') || draggingId;
    draggingId = null;
    if (!id) return;
    onMove(id, groupName === UNGROUPED ? '' : groupName);
  }

  function updateScrollState() {
    if (!listEl) return;
    canScrollUp = listEl.scrollTop > 0;
    canScrollDown = listEl.scrollTop + listEl.clientHeight < listEl.scrollHeight - 1;
  }

  $effect(() => {
    savedChats;
    if (listEl) requestAnimationFrame(updateScrollState);
  });
</script>

<section class="history" class:fade-top={canScrollUp} class:fade-bottom={canScrollDown}>
  {#if savedChats.length === 0}
    <EmptyState padding="40px">
      {#snippet icon()}
        <svg
          width="68"
          height="52"
          viewBox="0 0 68 52"
          fill="none"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            d="M40.25 0.75V33.25H30.25V45.2744L17.5713 33.4512L17.3555 33.25H0.75V0.75H40.25Z"
            stroke="var(--color-text-tertiary)"
            stroke-width="1.5"
          />
          <path
            d="M44 12.5H67V41H49L40.5 49.5V41H34.5"
            stroke="var(--color-text-tertiary)"
            stroke-width="1.5"
            stroke-dasharray="2 2"
          />
        </svg>
      {/snippet}
      {#snippet text()}
        No past chats yet.<br />New chats are saved automatically.
      {/snippet}
    </EmptyState>
  {:else}
    <ul class="list" bind:this={listEl} onscroll={updateScrollState}>
      {#each groups as group (group.name)}
        <li
          class="group-heading"
          class:current-file={group.isCurrentFile}
          class:drag-over={dragOverGroup === group.name}
          ondragover={(e) => { e.preventDefault(); dragOverGroup = group.name; }}
          ondragleave={() => { if (dragOverGroup === group.name) dragOverGroup = null; }}
          ondrop={(e) => handleDrop(group.name, e)}
        >
          <span class="group-name" title={group.name}>{group.name}</span>
          <span class="group-count">{group.chats.length}</span>
        </li>
        {#each group.chats as chat (chat.id)}
          {@const isApplied = chat.id === currentChatId}
          <li
            class="item"
            class:active={isApplied}
            class:dragging={draggingId === chat.id}
            draggable="true"
            ondragstart={(e) => {
              draggingId = chat.id;
              e.dataTransfer?.setData('text/plain', chat.id);
              if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move';
            }}
            ondragend={() => { draggingId = null; dragOverGroup = null; }}
          >
            <div class="item-meta">
              <span class="title">{chat.title}</span>
              <Badge variant="label">{providerName(chat)}</Badge>
              {#if isApplied}<Badge variant="active">applied</Badge>{/if}
            </div>
            <span class="sub">{formatDate(chat.savedAt)} · {msgCount(chat)} messages</span>
            <div class="item-actions">
              {#if groups.length > 1}
                <select
                  class="move-select"
                  title="Move to project…"
                  value=""
                  onchange={(e) => {
                    const target = e.currentTarget.value;
                    e.currentTarget.value = '';
                    if (target) onMove(chat.id, target === UNGROUPED ? '' : target);
                  }}
                >
                  <option value="" disabled selected>Move to…</option>
                  {#each groups as target (target.name)}
                    {#if target.name !== groupKeyFor(chat)}
                      <option value={target.name}>{target.name}</option>
                    {/if}
                  {/each}
                </select>
              {/if}
              {#if isApplied}
                <Button variant="ghost" onclick={onUnapply} title="Unapply"
                  ><Icon name="close" /></Button
                >
              {:else}
                <Button variant="ghost" onclick={() => onResume(chat)} title="Apply"
                  ><Icon name="arrow-up" /></Button
                >
              {/if}
              <Button variant="ghost" onclick={() => onDelete(chat.id)} title="Delete"
                ><Icon name="bin" /></Button
              >
            </div>
          </li>
        {/each}
      {/each}
    </ul>
  {/if}
</section>

<style>
  .group-heading {
    display: flex;
    align-items: center;
    gap: 6px;
    position: sticky;
    top: 0;
    z-index: 1;
    padding: 6px 8px;
    background: var(--color-bg);
    border-bottom: 1px solid var(--color-border-1);
    font-size: 10px;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--color-text-tertiary);
  }

  .group-heading.current-file {
    color: var(--color-text-primary);
  }

  .group-heading.drag-over {
    background: var(--color-surface-2);
    color: var(--color-text-primary);
    outline: 1px dashed var(--color-border-3);
    outline-offset: -1px;
  }

  .group-name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .group-count {
    margin-left: auto;
    flex: none;
    opacity: 0.7;
  }

  .history {
    position: relative;
    display: flex;
    flex-direction: column;
    flex: 1;
    overflow: hidden;

    &::after,
    &::before {
      z-index: 1;
      position: absolute;
      left: 0;
      content: '';
      height: 30px;
      width: 100%;
      pointer-events: none;
      opacity: 0;
      transition: opacity 0.2s ease;
    }

    &::after {
      top: 0;
      background: linear-gradient(var(--color-bg) 20%, transparent 100%);
    }

    &::before {
      bottom: 0;
      background: linear-gradient(transparent 0%, var(--color-bg) 80%);
    }

    &.fade-top::after {
      opacity: 1;
    }

    &.fade-bottom::before {
      opacity: 1;
    }
  }

  .list {
    list-style: none;
    padding: 0;
    margin: 0;
    display: flex;
    flex-direction: column;
    gap: 8px;
    overflow-y: auto;
    flex: 1;
    padding: var(--spacing-inner-padding);
    max-height: 650px;
  }

  .item {
    display: grid;
    grid-template-columns: 1fr auto;
    grid-template-rows: auto auto;
    align-items: center;
    gap: 6px 8px;
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-md);
    padding: 10px 12px;
  }

  .item-meta {
    grid-column: 1;
    grid-row: 1;
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  .title {
    font-size: 14px;
    font-weight: 500;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .sub {
    font-size: 12px;
    opacity: 0.4;
    grid-column: 1;
    grid-row: 2;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .item-actions {
    grid-column: 2;
    grid-row: 1 / 3;
    display: flex;
    align-items: center;
    gap: 4px;
  }

  .item.dragging {
    opacity: 0.5;
  }

  .move-select {
    max-width: 72px;
    font-size: 11px;
    color: var(--color-text-secondary);
    background: var(--color-surface-1);
    border: 1px solid var(--color-border-1);
    border-radius: var(--radius-sm, 4px);
    padding: 4px 4px;
  }
</style>
