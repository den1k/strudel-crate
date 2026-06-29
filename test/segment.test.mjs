import { describe, it, expect } from 'vitest';
import { segmentPlan, concatSegmentPCM } from '../src/segment.js';

const SR = 44100;

describe('segmentPlan', () => {
  it('tiles kept regions to exactly totalSamples with no gap or overlap', () => {
    const spec = { cps: 0.55, cycles: 64, seconds: 64 / 0.55 };
    const plan = segmentPlan(spec, 4, 4, SR);
    expect(plan.segments).toHaveLength(4);
    const keptSum = plan.segments.reduce((s, seg) => s + seg.keepLengthSamples, 0);
    expect(keptSum).toBe(plan.totalSamples);
    // first segment has no warm-up (starts at t=0)
    expect(plan.segments[0].keepOffsetSamples).toBe(0);
    expect(plan.segments[0].renderStartSec).toBe(0);
    // a later segment carries warm-up: render region is longer than kept region
    const mid = plan.segments[2];
    expect(mid.renderLengthSamples).toBeGreaterThan(mid.keepLengthSamples);
    expect(mid.keepOffsetSamples).toBe(mid.renderLengthSamples - mid.keepLengthSamples);
  });

  it('warm-up is capped at the track start (no negative render start)', () => {
    const spec = { cps: 2, cycles: 8, seconds: 4 }; // short cycles → warm-up would underflow
    const plan = segmentPlan(spec, 4, 4, SR);
    for (const seg of plan.segments) expect(seg.renderStartSec).toBeGreaterThanOrEqual(0);
  });

  it('never produces more segments than cycles, and clamps to >=1', () => {
    const spec = { cps: 1, cycles: 3, seconds: 3 };
    expect(segmentPlan(spec, 8, 4, SR).segments.length).toBeLessThanOrEqual(3);
    expect(segmentPlan(spec, 1, 4, SR).segments).toHaveLength(1);
  });
});

describe('concatSegmentPCM', () => {
  it('stitches parts in order into one AudioBuffer-like of totalSamples', () => {
    const plan = { sampleRate: SR, totalSamples: 5, segments: [] };
    const parts = [
      { channels: [Float32Array.from([1, 2]), Float32Array.from([-1, -2])] },
      { channels: [Float32Array.from([3, 4, 5]), Float32Array.from([-3, -4, -5])] },
    ];
    const buf = concatSegmentPCM(parts, plan);
    expect(buf.numberOfChannels).toBe(2);
    expect(buf.length).toBe(5);
    expect(Array.from(buf.getChannelData(0))).toEqual([1, 2, 3, 4, 5]);
    expect(Array.from(buf.getChannelData(1))).toEqual([-1, -2, -3, -4, -5]);
  });
});
