// scripts/list-slugs.mjs <tracks|stems>
// Print every slug in a namespace, one per line (for the skills' duplicate-batch
// check: `node scripts/list-slugs.mjs tracks | grep <batch>`).
import { brokerCall, inJob } from './lib/job-client.mjs';

const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
if (inJob()) {
  const res = await brokerCall('list-slugs');
  if (!res.ok) { console.error(res.error); process.exit(1); }
  for (const slug of res.slugs) console.log(slug);
} else {
  const { adminDb, itemSlugs } = await import('./lib/instant.mjs');
  for (const slug of [...(await itemSlugs(adminDb, ns))].sort()) console.log(slug);
}
