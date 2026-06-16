// scripts/list-slugs.mjs <tracks|stems>
// Print every slug in a namespace, one per line (for the skills' duplicate-batch
// check: `node scripts/list-slugs.mjs tracks | grep <batch>`).
import { adminDb, itemSlugs } from './lib/instant.mjs';

const ns = process.argv[2] === 'stems' ? 'stems' : 'tracks';
for (const slug of [...(await itemSlugs(adminDb, ns))].sort()) console.log(slug);
