// Whether this module is the script node was started with. Compares real paths: a job runs
// scripts through symlinks in its own working directory, and node resolves import.meta.url
// through them but not process.argv[1].
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl) {
  if (!process.argv[1]) return false;
  try {
    return realpathSync(process.argv[1]) === fileURLToPath(moduleUrl);
  } catch {
    return false;
  }
}
