import { describe, it, expect, vi } from 'vitest';
import { createExportClient, exportFilename } from '../src/export-client.js';

function fakeConnect() {
  const ctx = { posts: [], handler: null, destroyed: false };
  ctx.transport = {
    post: (m) => ctx.posts.push(m),
    onMessage: (h) => { ctx.handler = h; return () => { ctx.handler = null; }; },
    destroy: () => { ctx.destroyed = true; },
  };
  ctx.emit = (d) => ctx.handler?.(d);
  ctx.renders = () => ctx.posts.filter((m) => m.type === 'render');
  return ctx;
}
const track = { id: 'song-1', code: 'c', meta: { bpm: 120 } };

describe('exportFilename', () => {
  it('maps formats to extensions', () => {
    expect(exportFilename('song-1', 'wav')).toBe('song-1.wav');
    expect(exportFilename('song-1', 'mp3')).toBe('song-1.mp3');
    expect(exportFilename('song-1', 'stems')).toBe('song-1.zip');
  });
});

describe('createExportClient', () => {
  it('posts a render after ready and resolves with the blob', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const promise = client.render(track, 'wav');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    expect(f.renders()[0]).toEqual({ type: 'render', id: 'song-1:wav', track, format: 'wav' });
    const blob = new Blob(['x']);
    f.emit({ type: 'done', id: 'song-1:wav', blob });
    await expect(promise).resolves.toBe(blob);
  });

  it('rejects on an error message', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const promise = client.render(track, 'mp3');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    f.emit({ type: 'error', id: 'song-1:mp3', message: 'boom' });
    await expect(promise).rejects.toThrow('boom');
  });

  it('forwards progress to onProgress', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const onProgress = vi.fn();
    const promise = client.render(track, 'stems', { onProgress });
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    f.emit({ type: 'progress', id: 'song-1:stems', done: 1, total: 3 });
    expect(onProgress).toHaveBeenCalledWith({ done: 1, total: 3 });
    f.emit({ type: 'done', id: 'song-1:stems', blob: new Blob(['z']) });
    await promise;
  });

  it('caches the blob: a second render returns it without posting again', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });
    const p1 = client.render(track, 'wav');
    f.emit({ type: 'ready' });
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    const blob = new Blob(['x']);
    f.emit({ type: 'done', id: 'song-1:wav', blob });
    await p1;
    const again = await client.render(track, 'wav');
    expect(again).toBe(blob);
    expect(f.renders().length).toBe(1);
  });
});
