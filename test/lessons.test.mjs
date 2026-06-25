import { describe, it, expect } from 'vitest';
import { fakeAdmin } from './fake-admin.mjs';
import {
  createLesson, updateLesson, deleteLesson, setNotes,
} from '../server/instant.mjs';

// The fake admin records tx ops (it does not mutate the store), and answers
// queries by equality where. Relation-array where (e.g. 'profile.id') is NOT
// matched by the fake — the real code filters those in JS — so these tests seed
// rows keyed by the equality fields the helpers actually query on (id, slug).

describe('createLesson', () => {
  it('records an upsert linked to the profile with target + timestamps', async () => {
    const db = fakeAdmin({ lessons: [] });
    const out = await createLesson(db, 'prof-1', { text: 'warmer pads', target: 'stems' });
    expect(out).toMatchObject({ text: 'warmer pads', target: 'stems', song: null });
    expect(out.createdAt).toBeTruthy();
    const op = db._txs.at(-1);
    expect(op.ns).toBe('lessons');
    expect(op.update).toMatchObject({ text: 'warmer pads', target: 'stems' });
    expect(op.link).toEqual({ profile: 'prof-1' });
  });
});

describe('updateLesson ownership', () => {
  const seed = () => fakeAdmin({
    lessons: [{ id: 'L1', text: 'old', target: 'tracks', profile: [{ id: 'owner' }] }],
  });

  it('404 when the lesson does not exist', async () => {
    const db = fakeAdmin({ lessons: [] });
    expect(await updateLesson(db, 'owner', 'nope', { text: 'x' })).toBeNull();
  });

  it('forbidden when owned by another profile', async () => {
    const db = seed();
    expect(await updateLesson(db, 'intruder', 'L1', { text: 'x' })).toBe('forbidden');
    expect(db._txs.length).toBe(0); // nothing written
  });

  it('updates when owned by caller', async () => {
    const db = seed();
    const out = await updateLesson(db, 'owner', 'L1', { text: 'new', target: 'stems' });
    expect(out).not.toBe('forbidden');
    const op = db._txs.find((o) => o.ns === 'lessons' && o.id === 'L1');
    expect(op.update).toMatchObject({ text: 'new', target: 'stems' });
    expect(op.update.updatedAt).toBeTruthy();
  });
});

describe('deleteLesson ownership', () => {
  const seed = () => fakeAdmin({
    lessons: [{ id: 'L1', text: 'x', target: 'tracks', profile: [{ id: 'owner' }] }],
  });

  it('404 when missing', async () => {
    expect(await deleteLesson(fakeAdmin({ lessons: [] }), 'owner', 'nope')).toBeNull();
  });
  it('forbidden for non-owner', async () => {
    const db = seed();
    expect(await deleteLesson(db, 'intruder', 'L1')).toBe('forbidden');
    expect(db._txs.length).toBe(0);
  });
  it('deletes for owner', async () => {
    const db = seed();
    expect(await deleteLesson(db, 'owner', 'L1')).toBe(true);
    expect(db._txs.find((o) => o.ns === 'lessons' && o.id === 'L1').delete).toBe(true);
  });
});

describe('setNotes quick-add (song-linked lesson upsert/delete)', () => {
  const trackRow = (extra = {}) => ({
    id: 'T1', slug: 'song-1', notes: '', author: [{ id: 'owner' }], ...extra,
  });

  it('creates a lesson record linked to the song + author when none exists', async () => {
    const db = fakeAdmin({ tracks: [trackRow({ lessonRecord: [] })] });
    const out = await setNotes(db, 'tracks', 'song-1', { lesson: 'layer pads warmer' });
    expect(out.lesson).toBe('layer pads warmer');
    const op = db._txs.find((o) => o.ns === 'lessons');
    expect(op.update).toMatchObject({ text: 'layer pads warmer', target: 'tracks' });
    expect(op.link).toMatchObject({ track: 'T1', profile: 'owner' });
  });

  it('updates the existing record instead of creating a second', async () => {
    const db = fakeAdmin({ tracks: [trackRow({ lessonRecord: [{ id: 'L9', text: 'old' }] })] });
    const out = await setNotes(db, 'tracks', 'song-1', { lesson: 'revised' });
    expect(out.lesson).toBe('revised');
    const op = db._txs.find((o) => o.ns === 'lessons');
    expect(op.id).toBe('L9');
    expect(op.update).toMatchObject({ text: 'revised' });
    expect(op.delete).toBeUndefined();
  });

  it('deletes the record when the lesson is cleared', async () => {
    const db = fakeAdmin({ tracks: [trackRow({ lessonRecord: [{ id: 'L9', text: 'old' }] })] });
    const out = await setNotes(db, 'tracks', 'song-1', { lesson: '   ' });
    expect(out.lesson).toBe('');
    expect(db._txs.find((o) => o.ns === 'lessons' && o.id === 'L9').delete).toBe(true);
  });

  it('falls back to the caller profile when the song has no author (no orphan lesson)', async () => {
    // unowned legacy song edited by an admin — author is absent, so the lesson
    // must still be linked to the caller's profile, never created profile-less.
    const db = fakeAdmin({ tracks: [{ id: 'T1', slug: 'song-1', notes: '', author: [], lessonRecord: [] }] });
    const out = await setNotes(db, 'tracks', 'song-1', { lesson: 'admin lesson' }, 'admin-profile');
    expect(out.lesson).toBe('admin lesson');
    const op = db._txs.find((o) => o.ns === 'lessons');
    expect(op.link).toMatchObject({ track: 'T1', profile: 'admin-profile' });
  });

  it('leaves the lesson record untouched when only notes change', async () => {
    const db = fakeAdmin({ tracks: [trackRow({ lessonRecord: [{ id: 'L9', text: 'keep' }] })] });
    const out = await setNotes(db, 'tracks', 'song-1', { notes: 'just a note' });
    expect(out.notes).toBe('just a note');
    expect(out.lesson).toBe('keep');
    expect(db._txs.some((o) => o.ns === 'lessons')).toBe(false);
  });
});
