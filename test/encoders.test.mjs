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

describe('encodeWav 24-bit', () => {
  it('writes a 24-bit PCM header with correct sizes', () => {
    const buf = stubBuffer(); // 0.1s stereo @ 44100
    const view = new DataView(encodeWav(buf, 24));
    const tag = (off) => String.fromCharCode(...new Uint8Array(view.buffer, off, 4));
    expect(tag(0)).toBe('RIFF');
    expect(tag(8)).toBe('WAVE');
    expect(view.getUint16(22, true)).toBe(2); // channels
    expect(view.getUint16(34, true)).toBe(24); // bits per sample
    expect(view.getUint16(32, true)).toBe(2 * 3); // blockAlign = channels * 3 bytes
    expect(view.getUint32(40, true)).toBe(buf.length * 2 * 3); // data size
    expect(view.byteLength).toBe(44 + buf.length * 2 * 3);
  });

  it('encodes full-scale samples as 24-bit two\'s-complement little-endian', () => {
    const buf = stubBuffer();
    buf.getChannelData(0)[0] = 1.0; // +full scale
    buf.getChannelData(0)[1] = -1.0; // -full scale (second frame, ch0)
    const view = new DataView(encodeWav(buf, 24));
    // frame 0, ch0 at offset 44: +full scale ≈ 0x7FFFFF
    expect(view.getUint8(44) | (view.getUint8(45) << 8) | (view.getUint8(46) << 16)).toBe(0x7fffff);
    // frame 1, ch0 at offset 44 + blockAlign(6): -full scale = 0x800000
    const o = 44 + 6;
    expect(view.getUint8(o) | (view.getUint8(o + 1) << 8) | (view.getUint8(o + 2) << 16)).toBe(0x800000);
  });

  it('still defaults to 16-bit', () => {
    const view = new DataView(encodeWav(stubBuffer()));
    expect(view.getUint16(34, true)).toBe(16);
  });
});
