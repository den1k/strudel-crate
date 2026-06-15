// test/notifications.test.mjs
import { describe, it, expect } from 'vitest';
import { deepLink, unreadCount, newlyFinished, notificationText } from '../src/notifications.js';

const job = (id, extra = {}) => ({
  id, type: 'generate-stems', prompt: 'pads', collection: 'stems',
  status: 'done', batch: '2026-06-15-pads', newItems: ['2026-06-15-pads-01'], ...extra,
});

describe('deepLink', () => {
  it('links stems jobs to /stems with the batch', () => {
    expect(deepLink(job('a'))).toBe('/stems?batch=2026-06-15-pads');
  });
  it('links tracks jobs to / with the batch', () => {
    expect(deepLink(job('a', { collection: 'tracks' }))).toBe('/?batch=2026-06-15-pads');
  });
  it('falls back to the collection page when batch is null', () => {
    expect(deepLink(job('a', { batch: null }))).toBe('/stems');
  });
});

describe('newlyFinished', () => {
  it('returns jobs whose finished status differs from the previous snapshot', () => {
    const prev = new Map([['a', 'running'], ['b', 'done']]);
    const jobs = [job('a', { status: 'done' }), job('b', { status: 'done' }), job('c', { status: 'running' })];
    expect(newlyFinished(prev, jobs).map((j) => j.id)).toEqual(['a']);
  });
});

describe('unreadCount', () => {
  it('counts finished jobs newer than lastSeenId (list is newest-first)', () => {
    const jobs = [job('c'), job('b'), job('a')];
    expect(unreadCount(jobs, 'a')).toBe(2);
  });
  it('counts all when nothing seen yet', () => {
    const jobs = [job('c'), job('b')];
    expect(unreadCount(jobs, null)).toBe(2);
  });
  it('ignores unfinished jobs', () => {
    const jobs = [job('c', { status: 'running' }), job('b')];
    expect(unreadCount(jobs, null)).toBe(1);
  });
});

describe('notificationText', () => {
  it('summarizes a successful stems job', () => {
    expect(notificationText(job('a'))).toEqual({ title: '1 stems ready', body: 'pads' });
  });
  it('labels failures', () => {
    expect(notificationText(job('a', { status: 'failed' }))).toEqual({ title: 'Generation failed', body: 'pads' });
  });
});
