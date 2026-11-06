// Inside a generation job the save/read scripts hold no credentials: they forward to the
// job broker (server/job-broker.mjs), keeping their CLI output the same for the skills.
import http from 'node:http';
import { readFile, unlink } from 'node:fs/promises';

export const inJob = () => Boolean(process.env.CRATE_BROKER_URL);

export function brokerCall(op, body = {}) {
  const url = new URL(`/op/${op}`, process.env.CRATE_BROKER_URL);
  const data = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${process.env.CRATE_BROKER_TOKEN}`,
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(data),
      },
    }, (res) => {
      let out = '';
      res.setEncoding('utf8');
      res.on('data', (d) => { out += d; });
      res.on('end', () => {
        try { resolve(JSON.parse(out)); } catch { reject(new Error(`broker answered ${res.statusCode}`)); }
      });
    });
    req.on('error', reject);
    req.end(data);
  });
}

// Shared by save-track, save-stem and save-palette. Same PASS/FAIL lines as a local save.
export async function saveThroughBroker(op, file, { field = 'item', key = 'id' } = {}) {
  let value;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (err) {
    console.log(`FAIL ${file} — unreadable JSON: ${err.message}`);
    return 1;
  }
  const label = value?.[key] ?? file;
  const res = await brokerCall(op, { [field]: value });
  for (const w of res.warnings ?? []) console.error(`WARN ${label} — ${w}`);
  if (!res.ok) {
    console.log(`FAIL ${label} — ${res.error}`);
    return 1;
  }
  try { await unlink(file); } catch { /* best effort */ }
  console.log(`PASS ${label}${res.voices ? ` (${res.voices.length} voices)` : ''}`);
  return 0;
}
