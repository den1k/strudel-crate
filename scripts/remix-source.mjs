// scripts/remix-source.mjs <tracks|stems> <slug>
// Print the source item + a fresh newId for the /remix skill, as JSON.
import { isMain } from './lib/is-main.mjs';

export function nextRemixId(sourceSlug, existingSlugs) {
  for (let n = 1; n < 100; n++) {
    const candidate = `${sourceSlug}-remix-${String(n).padStart(2, '0')}`;
    if (!existingSlugs.includes(candidate)) return candidate;
  }
  throw new Error('too many remixes');
}

if (isMain(import.meta.url)) {
  const { inJob, brokerCall } = await import('./lib/job-client.mjs');
  if (inJob()) {
    const res = await brokerCall('remix-source', { slug: process.argv[3] });
    if (!res.ok) { console.error(res.error); process.exit(1); }
    console.log(JSON.stringify(res.source, null, 2));
    process.exit(0);
  }
  const { adminDb } = await import('./lib/instant.mjs');
  const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
  const slug = process.argv[3];
  const res = await adminDb.query({ [ns]: { $: { where: { slug } } } });
  const item = res[ns][0];
  if (!item) { console.error(`source not found: ${ns}/${slug}`); process.exit(1); }
  const all = await adminDb.query({ [ns]: {} });
  const newId = nextRemixId(slug, all[ns].map((r) => r.slug));
  console.log(JSON.stringify({
    root: item.versionOf ?? item.slug,
    newId, namespace: ns,
    title: item.title, batch: item.batch, prompt: item.prompt,
    code: item.code, meta: item.meta,
  }, null, 2));
}
