// Pure helpers for the generation seed pools. No side effects beyond reading JSON.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Load a seed pool. kind = 'stem' | 'track'. */
export function loadSeeds(kind) {
  const file = join(ROOT, 'shared', `${kind}-seeds.json`);
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** True if a signature can attach to a source. */
export function compatible(source, signature) {
  return signature.appliesTo === 'any' || signature.appliesTo === source.appliesTo;
}

/** All valid source × signature pairs for a pool. */
export function composePairs(pool) {
  const pairs = [];
  for (const source of pool.sources) {
    for (const signature of pool.signatures) {
      if (compatible(source, signature)) pairs.push({ source, signature });
    }
  }
  return pairs;
}

/** Wrap a single stem expression into a minimal valid stem program. */
export function wrapStem(code) {
  return `stack(\n  ${code}.gain(0.8)\n)`;
}

/** Wrap a track groove + harmonic engine into a minimal valid track program. */
export function wrapTrack(sourceFrag, signatureFrag) {
  return `stack(\n  ${sourceFrag},\n  ${signatureFrag}\n)`;
}
