import { describe, it, expect } from 'vitest';
import { saveListState, loadListState } from '../src/list-state.js';

// In-memory storage stub so these run in node with no DOM.
const makeStorage = () => ({
  store: {},
  getItem(k) { return k in this.store ? this.store[k] : null; },
  setItem(k, v) { this.store[k] = String(v); },
  removeItem(k) { delete this.store[k]; },
});

const sample = () => ({
  batch: '2026-06-20',
  filter: 'top',
  selectedByFamily: [['fam-a', 'fam-a-v2'], ['fam-b', 'fam-b-v3']],
  scrollY: 1234,
});

describe('saveListState / loadListState', () => {
  it('round-trips a snapshot save -> load', () => {
    const storage = makeStorage();
    const snap = sample();
    saveListState('tracks', snap, storage);
    expect(loadListState('tracks', storage)).toEqual(snap);
  });

  it('isolates namespaces by storage key (tracks vs stems)', () => {
    const storage = makeStorage();
    const snap = sample();
    saveListState('tracks', snap, storage);
    // nothing saved under stems yet
    expect(loadListState('stems', storage)).toBe(null);
    // and the keys are distinct
    const stemsSnap = { ...snap, scrollY: 99 };
    saveListState('stems', stemsSnap, storage);
    expect(loadListState('tracks', storage)).toEqual(snap);
    expect(loadListState('stems', storage)).toEqual(stemsSnap);
  });

  it('returns null for a missing key', () => {
    const storage = makeStorage();
    expect(loadListState('tracks', storage)).toBe(null);
  });

  it('returns null on malformed JSON (never throws)', () => {
    const storage = makeStorage();
    storage.setItem('crate:list:tracks', 'not-json{');
    expect(loadListState('tracks', storage)).toBe(null);
  });

  it('preserves selectedByFamily entries through the round-trip', () => {
    const storage = makeStorage();
    const snap = sample();
    saveListState('tracks', snap, storage);
    const loaded = loadListState('tracks', storage);
    expect(loaded.selectedByFamily).toEqual([
      ['fam-a', 'fam-a-v2'],
      ['fam-b', 'fam-b-v3'],
    ]);
    // entries are usable to rebuild a Map
    const map = new Map(loaded.selectedByFamily);
    expect(map.get('fam-a')).toBe('fam-a-v2');
  });
});
