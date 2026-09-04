// `.agents/skills` and `.claude/skills` are committed as symlinks to `skills/`
// so both providers read one canonical skill package set. Windows git checks
// those out as plain text files unless Developer Mode is on, which silently
// breaks skill discovery, so recreate them here after install.
//
// Junctions are used instead of symlinks on Windows because they need no
// elevation. They require an absolute target.
import { lstat, mkdir, readlink, realpath, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SKILLS_DIR = path.join(ROOT, 'skills');
const LINKS = [
  path.join(ROOT, '.agents', 'skills'),
  path.join(ROOT, '.claude', 'skills'),
];

const isWindows = process.platform === 'win32';

async function alreadyLinked(linkPath) {
  const info = await lstat(linkPath).catch(() => null);
  if (!info?.isSymbolicLink()) return false;
  const target = await readlink(linkPath).catch(() => '');
  if (!target) return false;
  const resolved = path.resolve(path.dirname(linkPath), target);
  return await realpath(resolved).catch(() => '') === await realpath(SKILLS_DIR).catch(() => null);
}

async function link(linkPath) {
  if (await alreadyLinked(linkPath)) return 'ok';
  await mkdir(path.dirname(linkPath), { recursive: true });
  // Clears both a stale link and the plain text file Windows git leaves behind.
  await rm(linkPath, { recursive: true, force: true });
  if (isWindows) await symlink(SKILLS_DIR, linkPath, 'junction');
  else await symlink(path.relative(path.dirname(linkPath), SKILLS_DIR), linkPath);
  return 'created';
}

let failed = false;
for (const linkPath of LINKS) {
  const relative = path.relative(ROOT, linkPath);
  try {
    const result = await link(linkPath);
    if (result === 'created') console.log(`Linked ${relative} -> skills/`);
  } catch (error) {
    failed = true;
    console.warn(`Could not link ${relative}: ${error.message}`);
  }
}

if (failed) {
  console.warn('Skill discovery through .agents/skills and .claude/skills may not work.');
  console.warn('Run `npm run skills:link` again, or create the links manually.');
}
