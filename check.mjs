/**
 * Syntax check for the browser ES modules.
 * `node --check file.js` quietly skips files it parses as modules, so each one
 * is copied to a .mjs temp file where the check actually runs.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const files = ['dist/entry3d.js'];
const dir = mkdtempSync(join(tmpdir(), 'entry-check-'));
try {
  for (const file of files) {
    const tmp = join(dir, `${file.replace(/[\\/]/g, '_')}.mjs`);
    copyFileSync(file, tmp);
    execFileSync(process.execPath, ['--check', tmp], { stdio: 'inherit' });
    console.log(`ok  ${file}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
