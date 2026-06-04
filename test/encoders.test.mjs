import { describe, it, expect } from 'vitest';
import { encodeWav, encodeMp3 } from '../src/encoders.js';

// 0.1s stereo sine stub, AudioBuffer-like
function stubBuffer(sampleRate = 44100, seconds = 0.1) {
  const length = Math.round(sampleRate * seconds);
  const mk = () => {
    const a = new Float32Array(length);
    for (let i = 0; i < length; i++) a[i] = Math.sin((2 * Math.PI * 440 * i) / sampleRate) * 0.5;
    return a;
  };
  const channels = [mk(), mk()];
  return { numberOfChannels: 2, sampleRate, length, getChannelData: (c) => channels[c] };
}

describe('encodeWav', () => {
  it('produces a valid RIFF/WAVE header with correct sizes', () => {
    const buf = stubBuffer();
    const wav = encodeWav(buf);
    const view = new DataView(wav);
    const tag = (off) => String.fromCharCode(...new Uint8Array(wav, off, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(tag(36)).toBe('data');
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint32(24, true)).toBe(44100); // sample rate
    expect(view.getUint32(40, true)).toBe(buf.length * 2 * 2); // data size
    expect(wav.byteLength).toBe(44 + buf.length * 2 * 2);
  });

  it('clamps samples outside [-1, 1]', () => {
    const loud = stubBuffer();
    loud.getChannelData(0)[0] = 2.0;
    loud.getChannelData(0)[1] = -2.0;
    const view = new DataView(encodeWav(loud));
    expect(view.getInt16(44, true)).toBe(0x7fff); // first frame, ch0
    expect(view.getInt16(48, true)).toBe(-0x8000); // second frame, ch0
  });
});

describe('encodeMp3', () => {
  it('produces non-empty mp3 chunks with a valid frame sync', () => {
    const chunks = encodeMp3(stubBuffer());
    expect(chunks.length).toBeGreaterThan(0);
    const total = chunks.reduce((n, c) => n + c.length, 0);
    expect(total).toBeGreaterThan(500); // 0.1s @192kbps ≈ 2.4KB
    expect(chunks[0][0] & 0xff).toBe(0xff); // MPEG frame sync byte
  });
});
