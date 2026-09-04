import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { LinkedSkillStore } from '../bridge/linked-skill-store.js';
import { WorkspaceStore, validateWorkspacePath } from '../bridge/workspace-store.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function writeSkill(projectRoot, id, body) {
  const directory = path.join(projectRoot, 'skills', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    path.join(directory, 'SKILL.md'),
    `---\nname: ${id}\ndescription: "${id}"\n---\n\n${body}\n`
  );
}

test('workspace selection is canonical, persisted locally, and resettable', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'figcc-workspace-test-'));
  const defaultRoot = path.join(temporaryRoot, 'figcc');
  const selectedRoot = path.join(temporaryRoot, 'project-a');
  const dataDir = path.join(defaultRoot, '.figcodex-data');
  await Promise.all([
    mkdir(defaultRoot, { recursive: true }),
    mkdir(selectedRoot, { recursive: true }),
  ]);

  try {
    const canonicalSelectedRoot = await realpath(selectedRoot);
    assert.equal(await validateWorkspacePath(selectedRoot), canonicalSelectedRoot);
    await assert.rejects(validateWorkspacePath('relative/project'), /absolute local folder/);
    await assert.rejects(validateWorkspacePath(path.parse(selectedRoot).root), /filesystem root/);

    const store = new WorkspaceStore({
      defaultRoot,
      dataDir,
      picker: async () => selectedRoot,
    });
    assert.equal(store.publicState().selected, false);
    const selected = await store.choose();
    assert.equal(selected.changed, true);
    assert.deepEqual(store.publicState(), {
      selected: true,
      path: canonicalSelectedRoot,
      name: 'project-a',
      skillsPath: path.join(canonicalSelectedRoot, 'skills'),
    });
    // Windows does not implement POSIX permission bits, so node reports 0o666
    // regardless of the requested mode. Access there is governed by the ACL on
    // the user profile directory instead.
    if (process.platform !== 'win32') {
      assert.equal((await stat(path.join(dataDir, 'workspace.json'))).mode & 0o777, 0o600);
    }

    const restored = new WorkspaceStore({ defaultRoot, dataDir, picker: async () => null });
    await restored.initialize();
    assert.equal(restored.runtimeRoot(), canonicalSelectedRoot);
    await restored.clear();
    assert.equal(restored.runtimeRoot(), defaultRoot);
    assert.equal(JSON.parse(await readFile(path.join(dataDir, 'workspace.json'), 'utf8')).path, null);
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('workspace skills merge over bundled skills without an index or eager folder write', async () => {
  const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'figcc-linked-skills-test-'));
  const bundledRoot = path.join(temporaryRoot, 'figcc');
  const workspaceRoot = path.join(temporaryRoot, 'project-a');
  const dataDir = path.join(bundledRoot, '.figcodex-data');
  await Promise.all([
    mkdir(bundledRoot, { recursive: true }),
    mkdir(workspaceRoot, { recursive: true }),
  ]);

  try {
    await writeSkill(bundledRoot, 'shared', 'Bundled instructions.');
    await writeSkill(bundledRoot, 'bundled-only', 'Bundled only.');
    await writeSkill(workspaceRoot, 'shared', 'Workspace instructions.');
    const store = new LinkedSkillStore({ bundledRoot, dataDir });
    store.setWorkspace(workspaceRoot);

    const skills = await store.list();
    assert.equal(skills.length, 2);
    assert.equal(skills.find((skill) => skill.id === 'shared')?.source, 'workspace');
    assert.match(skills.find((skill) => skill.id === 'shared')?.content || '', /Workspace instructions/);
    assert.equal(skills.find((skill) => skill.id === 'bundled-only')?.source, 'bundled');

    await store.create({ name: 'Project Skill', content: 'Created for this project.' });
    await access(path.join(workspaceRoot, 'skills', 'project-skill', 'SKILL.md'));
    await assert.rejects(access(path.join(bundledRoot, 'skills', 'project-skill', 'SKILL.md')));

    let watcher;
    let watcherTimeout;
    try {
      const refreshed = new Promise((resolve, reject) => {
        watcherTimeout = setTimeout(
          () => reject(new Error('Timed out waiting for linked workspace skill refresh.')),
          3_000
        );
        store.watchChanges(async () => {
          const shared = (await store.list()).find((skill) => skill.id === 'shared');
          if (shared?.content.includes('Updated outside FigCC.')) resolve();
        }, reject).then(async (value) => {
          watcher = value;
          await writeSkill(workspaceRoot, 'shared', 'Updated outside FigCC.');
        }).catch(reject);
      });
      await refreshed;
    } finally {
      if (watcherTimeout) clearTimeout(watcherTimeout);
      watcher?.close();
    }

    const emptyWorkspace = path.join(temporaryRoot, 'project-b');
    await mkdir(emptyWorkspace);
    store.setWorkspace(emptyWorkspace);
    await store.list();
    await assert.rejects(access(path.join(emptyWorkspace, 'skills')));
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
});

test('workspace picker is authenticated bridge state and chats are root-bound', async () => {
  const [server, ui, settings, claude] = await Promise.all([
    readFile(path.join(root, 'bridge', 'server.js'), 'utf8'),
    readFile(path.join(root, 'src', 'UI.svelte'), 'utf8'),
    readFile(path.join(root, 'src', 'components', 'Settings.svelte'), 'utf8'),
    readFile(path.join(root, 'bridge', 'claude-provider.js'), 'utf8'),
  ]);

  assert.ok(server.indexOf("message.type === 'workspace.choose'") > server.indexOf('socket.figcodexAuthenticated'));
  assert.ok(server.includes('runtimeWorkspaceRoots: [workspaceRoot]'));
  assert.ok(server.includes('threadWorkspaceRoots'));
  assert.ok(ui.includes("workspacePath: workspace?.path || ''"));
  assert.ok(ui.includes('chat.workspacePath === workspace?.path'));
  assert.ok(settings.includes('Choose folder…'));
  assert.ok(settings.includes("Its <code>skills/</code> folder is merged"));
  assert.ok(claude.includes('this.baseOptions(workspaceRoot)'));
});
