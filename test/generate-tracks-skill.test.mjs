import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const skill = readFileSync(
  fileURLToPath(new URL('../.claude/skills/generate-tracks/SKILL.md', import.meta.url)),
  'utf8',
);

describe('generate-tracks skill model tiering', () => {
  it('dispatches Stage-2 compose agents on Sonnet', () => {
    expect(skill).toContain('model: sonnet');
  });
  it('keeps Stage-1 kit design on the inherited Opus model', () => {
    // Stage 1 must NOT push compose onto Sonnet; it inherits the orchestrator
    // model. We assert the explicit inherit note exists.
    expect(skill).toMatch(/Stage 1[\s\S]*inherit[\s\S]*Opus|no model override[\s\S]*Opus/i);
  });
});
