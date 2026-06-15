import { Mp3Encoder } from '@breezystack/lamejs';

const toInt16 = (f32) => {
  const i16 = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]));
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return i16;
};

// PCM RIFF/WAVE from an AudioBuffer-like. bitDepth 16 (default) or 24.
// (@strudel/webaudio has a 16-bit encoder but keeps it private — webaudio.mjs:120.)
export function encodeWav(buffer, bitDepth = 16) {
  const { numberOfChannels, sampleRate, length } = buffer;
  const channels = Array.from({ length: numberOfChannels }, (_, c) => buffer.getChannelData(c));
  const bytesPerSample = bitDepth / 8;
  const blockAlign = numberOfChannels * bytesPerSample;
  const dataSize = length * blockAlign;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  const writeStr = (off, s) => [...s].forEach((ch, i) => view.setUint8(off + i, ch.charCodeAt(0)));
  writeStr(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeStr(8, 'WAVE');
  writeStr(12, 'fmt ');
  view.setUint32(16, 16, true); // fmt chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, numberOfChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true); // byte rate
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, bitDepth, true);
  writeStr(36, 'data');
  view.setUint32(40, dataSize, true);
  let off = 44;
  for (let i = 0; i < length; i++) {
    for (let c = 0; c < numberOfChannels; c++) {
      const s = Math.max(-1, Math.min(1, channels[c][i]));
      if (bitDepth === 16) {
        view.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
        off += 2;
      } else {
        // 24-bit: no DataView.setInt24, so write 3 bytes little-endian two's-complement
        let v = Math.round(s < 0 ? s * 0x800000 : s * 0x7fffff);
        if (v < 0) v += 0x1000000;
        view.setUint8(off, v & 0xff);
        view.setUint8(off + 1, (v >> 8) & 0xff);
        view.setUint8(off + 2, (v >> 16) & 0xff);
        off += 3;
      }
    }
  }
  return out;
}

// MP3 192kbps via lamejs. Returns an array of Int8Array chunks (Blob-ready).
export function encodeMp3(buffer, kbps = 192) {
  const stereo = buffer.numberOfChannels > 1;
  const encoder = new Mp3Encoder(stereo ? 2 : 1, buffer.sampleRate, kbps);
  const left = toInt16(buffer.getChannelData(0));
  const right = stereo ? toInt16(buffer.getChannelData(1)) : left;
  const chunks = [];
  const BLOCK = 1152; // one MPEG frame of samples
  for (let i = 0; i < left.length; i += BLOCK) {
    const chunk = encoder.encodeBuffer(left.subarray(i, i + BLOCK), right.subarray(i, i + BLOCK));
    if (chunk.length) chunks.push(chunk);
  }
  const tail = encoder.flush();
  if (tail.length) chunks.push(tail);
  return chunks;
}
