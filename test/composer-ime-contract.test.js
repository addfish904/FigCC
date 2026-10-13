import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('composer does not send Enter while an IME composition is active', async () => {
  const composer = await readFile(path.join(root, 'src', 'components', 'Composer.svelte'), 'utf8');
  const keydownHandler = composer.match(/function handleKeydown\(e: KeyboardEvent\) \{([\s\S]*?)\n  \}/)?.[1] || '';

  assert.match(composer, /oncompositionstart=\{\(\) => isComposing = true\}/);
  assert.match(composer, /oncompositionend=\{\(\) => isComposing = false\}/);
  assert.match(keydownHandler, /if \(e\.isComposing \|\| isComposing\) return;/);
  assert.ok(
    keydownHandler.indexOf('e.isComposing') < keydownHandler.indexOf("e.key === 'Enter'"),
    'composition guard must run before Enter handling'
  );
});
