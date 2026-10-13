<p align="center">
  <img src="./icon.png" width="144" alt="FigCC four-circle logo">
</p>

<h1 align="center">FigCC</h1>

<p align="center">
  A local Codex or Claude Code Figma agent for inspecting, reasoning about, and editing your canvas.
</p>

<p align="center">
  <a href="./README.zh-TW.md">繁體中文</a> ·
  <a href="./CONTRIBUTING.md">Contributing</a> ·
  <a href="./LICENSE">MIT License</a> ·
  <a href="./NOTICE.md">Attribution</a>
</p>

> [!IMPORTANT]
> FigCC, formerly FigCodex, is a derivative work based on [PavelLaptev/FigClaw](https://github.com/PavelLaptev/FigClaw), used under the MIT License. FigCC replaces the original direct Claude API integration with an authenticated local bridge for Codex CLI and Claude Code, plus a different permission model, interface, and feature set. See [NOTICE.md](NOTICE.md).

FigCC connects a Figma plugin to Codex CLI and Claude Code installations already authenticated on your Mac. It does not require a Claude API key or a separate OpenAI model API key inside Figma. Codex uses App Server; Claude uses the official Agent SDK with an in-process FigCC MCP server. Each provider keeps its own native conversation identity.

FigCC is an independent community project and is not affiliated with or endorsed by Figma, Anthropic, or OpenAI.

## What FigCC adds

Compared with the upstream FigClaw project, FigCC currently includes:

- **Two local runtimes** — uses Codex CLI App Server or the Claude Code Agent SDK with each CLI's existing login; the plugin iframe never calls a model API directly.
- **Provider-isolated chats** — switching Codex/Claude always starts a new empty chat. History restores that chat's provider and resumes only its native Codex thread or Claude session.
- **Live runtime controls** — loads the selected provider's model, reasoning-effort, and permission controls, then lets you change them beside the Send button.
- **Native resume** — preserves Codex thread IDs and Claude session IDs separately so later messages and cross-file History resumes continue the correct conversation.
- **Selection-aware composer** — shows selected Figma text, images, frames, and mixed nodes before sending. Visual nodes include bounded rendered previews; text nodes include bounded text and style metadata.
- **Reference images** — supports uploaded, pasted, and Figma-selection images in the same message.
- **File attachments** — attach common documents, data files, and source files with the paperclip control; the authenticated bridge stores bounded private copies and makes them available to the selected local provider.
- **Direct canvas editing** — Figma inspection and canvas mutations run directly through the plugin sandbox, so normal drawing requests are not blocked by an unrelated consent review.
- **Selectable local-file permissions** — Codex defaults to the CLI's Read only profile with automatically reviewed escalation for explicit project-file work; Workspace and Full access remain explicit user choices.
- **Authenticated local transport** — the bridge binds to loopback and requires a persistent random pairing token.
- **Persistent macOS bridge** — a user LaunchAgent can start the bridge at login and restart it if it exits.
- **Selectable project workspace** — Settings opens a native macOS folder picker. The chosen folder becomes the provider project root, while its live `skills/` directory is merged with FigCC's built-in skills.
- **Shared native skills** — canonical `skills/<name>/SKILL.md` packages are linked into both `.agents/skills` and `.claude/skills`; upload, activate, `@mention`, create, or update them once for both providers.
- **History and migration** — saves conversations across Figma files and imports compatible legacy FigClaw settings, history, skills, and pairing tokens.
- **Dual-provider interface** — FigCC branding, compact native typography, four-circle mark, connection state, tool status, compact model/effort/permission controls, and vertically scrollable long-form tabs designed for the 400 px plugin panel.

## Architecture

```text
Figma plugin UI
    ⇅ authenticated WebSocket (ws://localhost:4319/ws)
FigCC local bridge
    ├⇄ JSON-RPC over stdio → codex app-server
    └⇄ Agent SDK + in-process MCP → Claude Code
    ⇅ tool calls and results
Figma plugin sandbox → current Figma document
```

Codex App Server is used instead of starting a new `codex exec` process for every prompt. Claude runs through the official Agent SDK and a narrowly configured in-process MCP server. Both paths can pause for a Figma tool, accept the result, continue streaming, and later resume their own native conversation.

## Figma tools

| Tool | Purpose |
| --- | --- |
| `get_selection` | Read the current selection and serialized node data. |
| `get_page_nodes` | Read the current page tree to a bounded depth. |
| `get_node_by_id` | Inspect a specific Figma node. |
| `get_styles` | List local paint, text, effect, and grid styles. |
| `get_variables` | Read variable collections, modes, and resolved values. |
| `get_components` | List components and component sets. |
| `get_pages` | List document pages and child counts. |
| `run_figma_code` | Execute Figma Plugin API JavaScript directly with top-level `await`. |
| `fetch_docs` | Fetch an allowlisted Figma Plugin API reference page. |
| `notify` | Show a Figma toast. |
| `download_files` | Download generated text or binary files, with ZIP fallback for multiple files. |
| `create_skill` / `update_skill` | Persist agent-authored skill documents in the selected workspace, or FigCC by default. |

## Requirements

- macOS and the Figma desktop app
- Node.js 18 or newer
- a recent Codex CLI with App Server dynamic-tool support and/or a recent Claude Code installation
- the selected CLI authenticated locally (`codex login` or launch `claude` and sign in)

FigCC searches `CODEX_BIN`, active Node/NVM installations, the ChatGPT desktop app bundle, and `PATH`, then selects the newest compatible Codex executable. Set `CODEX_BIN=/absolute/path/to/codex` to force a specific binary.

For Claude, FigCC searches `CLAUDE_BIN`, common Claude Code installation paths, active Node/NVM installations, and `PATH`. Set `CLAUDE_BIN=/absolute/path/to/claude` to force a specific binary. Either provider may be unavailable while the other remains usable.

## Install

```bash
npm install
npm run build
npm run bridge:install
npm run bridge:token
```

`bridge:install` registers `com.figcodex.bridge` as a user-level macOS LaunchAgent. It starts at login, restarts after an unexpected exit, and writes local logs under `.figcodex-data/`.

Then import the plugin:

1. Open Figma desktop.
2. Choose **Plugins → Development → Import plugin from manifest…**.
3. Select `public/manifest.json` from this repository.
4. Open FigCC → **Settings**.
5. Leave the URL as `http://localhost:4319`.
6. Paste the value printed by `npm run bridge:token` and choose **Save & Connect**.
7. Optionally choose **Project workspace → Choose folder…** to link an existing project and its `skills/` folder.
8. Wait for **Connected**, then return to **Chat**.

## Use

1. Optionally select one or more layers on the Figma canvas. Their context appears in the composer and can be excluded before sending.
2. Type a request, paste/upload reference images, attach documents or source files with the paperclip, or invoke a passive skill with `@skill-name`.
   Press Enter to send or Shift+Enter for a new line. While using an input method editor (IME), Enter confirms the current composition without sending; press Enter again after composition ends to send.
3. Choose **Codex** or **Claude** in the header. Changing provider opens a new empty chat and never transfers context.
4. Choose that provider's live model, reasoning effort, and local-file permission profile beside **Send** when needed.
5. Review the streamed tool/status messages while FigCC works. History shows a provider badge and restores the matching runtime automatically.

## Project workspace

Settings can link one local project folder through the native macOS folder picker. The authenticated bridge persists that selection in `.figcodex-data/workspace.json`; the Figma iframe cannot submit an arbitrary filesystem path.

- The selected folder becomes the working directory and enforced workspace root for new Codex threads and Claude sessions.
- Read only remains the default. Selecting a folder does not grant writes; **Workspace** or another explicit provider permission profile still controls local changes.
- FigCC merges built-in skills with `<selected-folder>/skills/<name>/SKILL.md`. A workspace skill overrides a built-in skill with the same id.
- Skills are read directly from disk and watched for additions, edits, and removals. FigCC does not copy them or build a separate index.
- New or imported skills are written to the selected project's `skills/` folder. With no selected project, they use FigCC's built-in `skills/` folder.
- Changing workspace starts a new empty chat. Saved native threads and sessions resume only when their recorded workspace still matches.

Example requests:

- “Describe the selected component and its variants.”
- “Create a button component with auto layout, 16/10 padding, and an 8 px radius.”
- “Turn the selected colors and text styles into Figma variables.”
- “Rename every selected layer to a file-safe name.”
- “Export all icon frames on this page as SVG and PNG.”
- “Use this reference image to restyle the selected card.”

## Skills

Custom skills are Markdown instruction files:

- **Active** skills are included in every turn.
- **Passive** skills are included only when invoked with `@skill-name`.
- Skills discovered directly from the filesystem start as **Passive** when no saved mode exists, so preinstalled or externally added instructions do not silently change every conversation.
- The agent can create and update skills through reviewed dynamic tools.
- Built-in example skills live as packages under [`skills/`](skills/). A selected project may add live packages under its own `skills/` folder.
- `.agents/skills` and `.claude/skills` are symlinks to that canonical directory, so both CLIs see the same updates.
- The bridge watches the built-in and selected-project directories directly. External file additions, edits, and removals are re-read from disk and pushed to the plugin automatically; no separate skill index is created.
- In dedicated FigCC provider sessions, native project-skill auto-discovery is disabled. The plugin's **Active** toggle and explicit `@skill-name` invocation are the only ways canonical skills enter a prompt.

Treat third-party skill files as code-like instructions: inspect them before enabling them.

## Security model

- The bridge binds to `127.0.0.1` by default and rejects clients without the pairing token.
- Pairing tokens and Codex/Claude credentials remain local and are never inserted into prompts.
- Codex defaults to the live `:read-only` permission profile with `approvalPolicy: on-request` and `approvalsReviewer: auto_review`. Older compatible CLIs safely fall back to `sandbox: read-only`.
- The permission control is populated by the live Codex App Server catalog. `:workspace` permits writes inside the project sandbox; `:danger-full-access` removes the filesystem sandbox and is shown as a warning choice.
- Claude models come from the live Agent SDK catalog. Claude defaults to `:read-only`; Workspace, Auto, and Full access map to Claude Code's native permission modes.
- User-configured MCP servers stay disabled for the dedicated canvas runtime; Claude receives only the in-process FigCC MCP server.
- Provider switching never copies transcript text or native IDs. History resumes only the provider recorded with that chat.
- Figma canvas tools, including `run_figma_code`, are forwarded directly to the plugin sandbox without bridge auto-review. Skill storage and downloads retain their separate fail-closed review boundary.
- The Figma manifest has no wildcard network access. It allows only the loopback bridge and the allowlisted documentation host.
- Selection previews remain in the plugin until the user presses Send.
- `.figcodex-data/`, `.figclaw-data/`, logs, tokens, and generated App Server schemas are excluded from git.

`run_figma_code` can modify the open Figma document without an approval pause. Use Figma version history for important files and review generated actions proportionally to their impact. The permission selector controls local project files, not the Figma canvas.

## Commands

| Command | Description |
| --- | --- |
| `npm run dev` | Watch and rebuild the plugin. |
| `npm run build` | Build `public/index.html` and `public/code.js`. |
| `npm run check` | Build and run all local tests. |
| `npm run bridge` | Run the bridge in the current terminal. |
| `npm run bridge:install` | Install/start the persistent macOS user service. |
| `npm run bridge:status` | Inspect the persistent bridge service. |
| `npm run bridge:uninstall` | Stop and remove the persistent bridge service. |
| `npm run bridge:token` | Print the persistent pairing token. |
| `npm run bridge:smoke` | Test a real Codex dynamic tool call and thread resume. |
| `npm run bridge:claude-smoke` | Test a real Claude MCP tool call and native session resume. |
| `npm run bridge:review-smoke` | Test that a Figma canvas tool bypasses auto-review and is forwarded directly. |
| `npm run bridge:permissions-smoke` | Test an automatically reviewed project write. |
| `npm run bridge:selection-smoke` | Test selection metadata and local-image input. |
| `npm run codex:schema` | Generate current experimental App Server TypeScript bindings. |

## Project structure

```text
bridge/                 Provider discovery/adapters, App Server client, bridge, skills, reviewer
scripts/                service installer, token helper, schemas, smoke tests
src/UI.svelte           plugin iframe and provider-scoped event/tool routing
src/code.ts             Figma sandbox, storage, selection capture, executors
src/tools.ts            dynamic-tool schemas
src/system-prompt.md    Figma agent instructions
src/components/         Svelte interface
skills/                 canonical <name>/SKILL.md packages for both providers
test/                   unit and security-contract tests
public/                 Figma manifest and generated build output
docs/attribution/       preserved upstream FigClaw promotional assets
```

Generated files under `public/` should be rebuilt, not edited by hand.

## Contributing

Read [AGENTS.md](AGENTS.md) for repository-wide engineering constraints and [CONTRIBUTING.md](CONTRIBUTING.md) for the local development workflow. Keep the English and Traditional Chinese documentation aligned when behavior changes.

## Attribution and license

FigCC is based on [PavelLaptev/FigClaw](https://github.com/PavelLaptev/FigClaw), originally created by Pavel Laptev. The upstream project is MIT licensed, and its original copyright notice is retained.

FigCC is released under the [MIT License](LICENSE). See [NOTICE.md](NOTICE.md) for the complete attribution and a summary of the substantial modifications.
