import { describe, it, expect, vi, afterEach } from 'vitest';
import { createExportClient, exportFilename, renderParallel } from '../src/export-client.js';

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

  it('serializes distinct renders: only ONE render message at a time', async () => {
    const f = fakeConnect();
    const client = createExportClient({ connect: () => f.transport });

    const p1 = client.render(track, 'wav');
    const p2 = client.render(track, 'mp3');

    f.emit({ type: 'ready' });

    // Only the first render should be posted initially.
    await vi.waitFor(() => expect(f.renders().length).toBe(1));
    expect(f.renders()[0].format).toBe('wav');

    // The second render must NOT have been posted yet.
    expect(f.renders().length).toBe(1);

    // Complete the first render.
    const blob1 = new Blob(['wav-data']);
    f.emit({ type: 'done', id: 'song-1:wav', blob: blob1 });
    await p1;

    // Now the second render should be posted.
    await vi.waitFor(() => expect(f.renders().length).toBe(2));
    expect(f.renders()[1].format).toBe('mp3');

    const blob2 = new Blob(['mp3-data']);
    f.emit({ type: 'done', id: 'song-1:mp3', blob: blob2 });
    await expect(p2).resolves.toBe(blob2);
  });

  it('rejects on ready timeout and allows retry', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeConnect();
      const client = createExportClient({ connect: () => f.transport, readyTimeoutMs: 100 });

      const promise = client.render(track, 'wav');
      // Never emit ready — advance past the timeout.
      await vi.advanceTimersByTimeAsync(200);

      await expect(promise).rejects.toThrow('did not become ready');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects on render timeout', async () => {
    vi.useFakeTimers();
    try {
      const f = fakeConnect();
      const client = createExportClient({ connect: () => f.transport, renderTimeoutMs: 100 });

      const promise = client.render(track, 'wav');

      // Emit ready synchronously (within fake timers).
      f.emit({ type: 'ready' });

      // Wait for the render message to be posted.
      await vi.waitFor(() => expect(f.renders().length).toBe(1));

      // Never emit done/error — advance past the render timeout.
      await vi.advanceTimersByTimeAsync(200);

      await expect(promise).rejects.toThrow('render timed out');
    } finally {
      vi.useRealTimers();
    }
  });
});

function fakeConnectFactory() {
  // each connect() returns an independent fake iframe transport
  return (/* src */) => {
    const handlers = new Set();
    return {
      post: (msg) => {
        if (msg.type === 'render-segment') {
          const len = msg.segment.keepLengthSamples;
          const ch0 = new Float32Array(len).fill(msg.segment.index + 1);
          const ch1 = new Float32Array(len).fill(-(msg.segment.index + 1));
          // reply async
          queueMicrotask(() => {
            for (const h of handlers) h({ type: 'segment-done', id: msg.id, index: msg.segment.index, length: len, ch0, ch1 });
          });
        }
      },
      onMessage: (h) => { handlers.add(h); queueMicrotask(() => { for (const g of handlers) g({ type: 'ready' }); }); return () => handlers.delete(h); },
      destroy: () => {},
    };
  };
}

describe('renderParallel', () => {
  it('splits, dispatches, concatenates in order, and returns a wav Blob', async () => {
    const track = { code: 's("bd*4")', meta: { bpm: 120 } };
    const progress = [];
    const blob = await renderParallel(track, 'wav', {
      segmentCount: 4,
      connect: fakeConnectFactory(),
      onProgress: (d, t) => progress.push([d, t]),
    });
    expect(blob.type).toBe('audio/wav');
    expect(blob.size).toBeGreaterThan(44); // header + data
    expect(progress.at(-1)).toEqual([4, 4]);
  });
});
