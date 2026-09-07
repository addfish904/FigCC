import assert from 'node:assert/strict';
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { CLAUDE_PERMISSION_PROFILES } from '../bridge/claude-provider.js';
import { SkillStore } from '../bridge/skill-store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('provider switch starts an isolated chat and History restores native provider sessions', async () => {
  const [ui, header, history, bridge, claude, plugin] = await Promise.all([
    readFile(path.join(root, 'src', 'UI.svelte'), 'utf8'),
    readFile(path.join(root, 'src', 'components', 'Header.svelte'), 'utf8'),
    readFile(path.join(root, 'src', 'components', 'History.svelte'), 'utf8'),
    readFile(path.join(root, 'bridge', 'server.js'), 'utf8'),
    readFile(path.join(root, 'bridge', 'claude-provider.js'), 'utf8'),
    readFile(path.join(root, 'src', 'code.ts'), 'utf8'),
  ]);

  assert.ok(header.includes('onProviderChange'));
  assert.ok(header.includes('>Codex</button>'));
  assert.ok(header.includes('>Claude</button>'));
  assert.ok(ui.includes('function switchProvider'));
  assert.ok(ui.includes('resetChatState();'));
  assert.ok(ui.includes("provider = chat.provider === 'claude' ? 'claude' : 'codex'"));
  assert.ok(ui.includes('chat.sessionId || null'));
  assert.ok(ui.includes('chat.threadId || null'));
  assert.ok(!ui.includes('fallbackContext'));
  assert.ok(!bridge.includes('Imported conversation context'));
  assert.ok(history.includes('providerName(chat)'));
  assert.ok(bridge.includes("provider === 'claude'"));
  assert.ok(claude.includes('resume: requestedSessionId'));
  assert.ok(plugin.includes('runtimes:'));
});

test('Claude uses live Agent SDK models, narrow MCP configuration, and safe permission defaults', async () => {
  const claude = await readFile(path.join(root, 'bridge', 'claude-provider.js'), 'utf8');
  assert.ok(claude.includes('session.supportedModels()'));
  assert.ok(claude.includes('strictMcpConfig: true'));
  assert.ok(claude.includes("permissionMode: 'dontAsk'"));
  assert.ok(claude.includes("permissionMode: 'bypassPermissions'"));
  assert.equal(CLAUDE_PERMISSION_PROFILES[0].id, ':read-only');
  assert.ok(CLAUDE_PERMISSION_PROFILES.some((profile) => profile.id === ':auto'));
});

test('canonical skill packages are shared by Codex and Claude and the store is bounded', async () => {
  // The contract is that both provider paths resolve to the one canonical
  // skills folder. Windows uses junctions with absolute targets rather than
  // relative POSIX symlinks, so compare resolved targets instead of raw ones.
  const canonicalSkills = await realpath(path.join(root, 'skills'));
  for (const provider of ['.agents', '.claude']) {
    const linkPath = path.join(root, provider, 'skills');
    assert.ok((await lstat(linkPath)).isSymbolicLink(), `${provider}/skills must be a link`);
    const target = await readlink(linkPath);
    assert.equal(await realpath(path.resolve(root, provider, target)), canonicalSkills);
  }
  const example = await readFile(path.join(root, 'skills', 'accessibility', 'SKILL.md'), 'utf8');
  assert.match(example, /^---\nname: accessibility\n/);

  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'figcodex-skill-test-'));
  try {
    const store = new SkillStore({
      root: temporaryRoot,
      dataDir: path.join(temporaryRoot, '.figcodex-data'),
    });
    const created = await store.create({
      name: 'Test Skill',
      content: '# Skill: Test Skill\n\nKeep this scoped.',
      mode: 'passive',
    });
    assert.equal(created.id, 'test-skill');
    const skills = await store.list();
    assert.equal(skills.length, 1);
    assert.equal(skills[0].mode, 'passive');
    assert.match(skills[0].content, /^---\nname: test-skill\n/);

    const externalDirectory = path.join(temporaryRoot, 'skills', 'external-skill');
    await mkdir(externalDirectory, { recursive: true });
    await writeFile(
      path.join(externalDirectory, 'SKILL.md'),
      '---\nname: external-skill\n---\n\nExternally managed instructions.\n'
    );
    let external = (await store.list()).find((skill) => skill.id === 'external-skill');
    assert.equal(external?.mode, 'passive');
    await store.setMode('external-skill', 'active');
    external = (await store.list()).find((skill) => skill.id === 'external-skill');
    assert.equal(external?.mode, 'active');

    const nativeConfig = await store.disabledNativeSkillConfig();
    assert.deepEqual(nativeConfig.skills.config, [
      {
        path: path.join(temporaryRoot, 'skills', 'external-skill', 'SKILL.md'),
        enabled: false,
      },
      {
        path: path.join(temporaryRoot, 'skills', 'test-skill', 'SKILL.md'),
        enabled: false,
      },
    ]);

    await assert.rejects(
      store.create({ name: 'Too Big', content: 'x'.repeat(129 * 1024) }),
      /128 KB/
    );
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('bundled skills do not inject the removed design disclaimer', async () => {
  const overlyCautious = await readFile(
    path.join(root, 'skills', 'overly-cautious', 'SKILL.md'),
    'utf8'
  );
  assert.ok(!overlyCautious.includes('I am not responsible for any design decisions'));
});

test('provider-native skill discovery cannot bypass FigCC skill modes', async () => {
  const [server, claude] = await Promise.all([
    readFile(path.join(root, 'bridge', 'server.js'), 'utf8'),
    readFile(path.join(root, 'bridge', 'claude-provider.js'), 'utf8'),
  ]);
  assert.ok(server.includes('skillStore.disabledNativeSkillConfig()'));
  assert.ok(server.includes('config: skillConfig'));
  assert.ok(claude.includes('skills: []'));
  assert.ok(!claude.includes("skills: 'all'"));
});

test('external skill file edits are detected without a separate index', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'figcodex-skill-watch-test-'));
  const store = new SkillStore({
    root: temporaryRoot,
    dataDir: path.join(temporaryRoot, '.figcodex-data'),
  });
  await store.create({
    name: 'Watched Skill',
    content: '# Skill: Watched Skill\n\nOriginal instructions.',
  });

  let timeout;
  let watcher;
  try {
    const refreshed = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error('Timed out waiting for the skill watcher.')), 3_000);
      store.watchChanges(async () => {
        const skills = await store.list();
        if (skills[0]?.content.includes('Updated externally.')) resolve();
      }, reject).then((value) => {
        watcher = value;
        return writeFile(
          path.join(temporaryRoot, 'skills', 'watched-skill', 'SKILL.md'),
          '---\nname: watched-skill\n---\n\nUpdated externally.\n'
        );
      }).catch(reject);
    });
    await refreshed;
  } finally {
    if (timeout) clearTimeout(timeout);
    watcher?.close();
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('skill scan errors stay scoped to skill synchronization', async () => {
  const server = await readFile(path.join(root, 'bridge', 'server.js'), 'utf8');
  assert.ok(server.includes("type: 'skills.error'"));
  assert.ok(server.includes('Could not refresh skills'));
  assert.ok(server.includes('await broadcastSkills(socket);'));
});

test('messages to the plugin are snapshotted so reactive state can be cloned', async () => {
  const ui = await readFile(path.join(root, 'src', 'UI.svelte'), 'utf8');
  // postMessage structured-clones its payload and throws on a Svelte 5 $state
  // Proxy, silently dropping any message that carries reactive state -- which
  // is how save-settings and save-chat-history came to fail without a trace.
  assert.match(ui, /parent\.postMessage\(\{ pluginMessage: \$state\.snapshot\(msg\) \}/);
  assert.ok(!/parent\.postMessage\(\{ pluginMessage: msg \}/.test(ui));
});

test('document reads use the async APIs that dynamic-page access requires', async () => {
  const plugin = await readFile(path.join(root, 'src', 'code.ts'), 'utf8');
  const manifest = JSON.parse(await readFile(path.join(root, 'public', 'manifest.json'), 'utf8'));
  assert.equal(manifest.documentAccess, 'dynamic-page');
  // Under dynamic-page access these synchronous getters throw, so get_styles
  // returned nothing and callers fell back to raw colour values.
  for (const banned of [
    'figma.getNodeById(',
    'getLocalPaintStyles()',
    'getLocalTextStyles()',
    'getLocalEffectStyles()',
    'getLocalGridStyles()',
    'getLocalVariableCollections()',
    'variables.getVariableById(',
  ]) {
    assert.ok(!plugin.includes(banned), `${banned} throws under dynamic-page access`);
  }
  // Style names alone do not say which style holds a given colour.
  assert.match(plugin, /getLocalPaintStylesAsync\(\)[\s\S]{0,400}paints: s\.paints/);
});

test('the panel ships its own resize grip because Figma provides none', async () => {
  const [ui, plugin] = await Promise.all([
    readFile(path.join(root, 'src', 'UI.svelte'), 'utf8'),
    readFile(path.join(root, 'src', 'code.ts'), 'utf8'),
  ]);
  // Figma exposes no resizable ShowUIOption and no window-resize event, so a
  // draggable grip plus figma.ui.resize is the only way to size the panel.
  assert.ok(ui.includes('class="resize-grip"'));
  assert.ok(ui.includes('onpointerdown={startResizeDrag}'));
  assert.ok(plugin.includes('figma.ui.resize(Math.max(w, 320), Math.max(h, 200))'));
  // Automatic sizing has to stand down once dragged, or it fights the pointer.
  assert.match(ui, /function sendResize\(\) \{\s*if \(!mainEl \|\| userResized\) return;/);
});
