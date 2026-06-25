// instant.schema.ts
// Crate's data model. tracks & stems are identical content entities; profiles
// hold an artist name and link to a $user. The human-readable id lives in `slug`
// (the Instant entity id is a UUID). meta is the nested { bpm, genre, ... } object.
import { i } from '@instantdb/core';

const itemFields = {
  slug: i.string().unique().indexed(), // human id, e.g. "2026-06-03-seed-01"
  title: i.string(),
  prompt: i.string(),
  batch: i.string().indexed(),
  description: i.string(),
  code: i.string(),
  meta: i.json(), // { bpm, genre, mood, key, instruments: string[], energy }
  createdAt: i.string().indexed(), // ISO 8601 — sorts chronologically lexicographically
  isPublic: i.boolean().indexed(),
  versionOf: i.string().indexed().optional(), // root slug for v2+, absent for v1
  notes: i.string().optional(), // per-item notes
  // NOTE: the legacy per-song `lesson` string was migrated to the first-class
  // `lessons` entity (profile-linked, optional song link) and removed here.
  playCount: i.number().optional(), // total plays across everyone; absent ⇒ 0
  ratingSum: i.number().optional(),   // sum of all users' ratings; absent ⇒ 0
  ratingCount: i.number().optional(), // number of users who rated; absent ⇒ 0
  remixOf: i.string().indexed().optional(), // source root slug when this item is a remix
  jobId: i.string().indexed().optional(), // runner job that created this row; for per-job attribution + progress
};

const _schema = i.schema({
  entities: {
    $users: i.entity({
      email: i.string().unique().indexed().optional(),
    }),
    profiles: i.entity({
      artistName: i.string().indexed(),
      createdAt: i.string().indexed(),
    }),
    tracks: i.entity({ ...itemFields }),
    stems: i.entity({ ...itemFields }),
    // User-level guidance that steers future generations. First-class records
    // (profile-linked, optional source-song link). `target` selects which
    // generations a lesson applies to; the digest filters on it.
    lessons: i.entity({
      text: i.string(),                 // lesson content
      target: i.string().indexed(),     // 'tracks' | 'stems'
      createdAt: i.string().indexed(),  // ISO 8601
      updatedAt: i.string(),            // ISO 8601
    }),
    plays: i.entity({
      namespace: i.string(),       // 'tracks' | 'stems'
      slug: i.string().indexed(),  // which version was played
      count: i.number(),           // this profile's play count for this item
      lastPlayedAt: i.string(),    // ISO 8601
    }),
    ratings: i.entity({
      namespace: i.string(),       // 'tracks' | 'stems'
      slug: i.string().indexed(),  // which item was rated
      value: i.number(),           // 1-5
      updatedAt: i.string(),       // ISO 8601
    }),
    allowlist: i.entity({
      email: i.string().unique().indexed(),  // lowercased
      addedAt: i.string().indexed(),          // ISO 8601
      addedBy: i.string(),                    // admin email, light audit trail
    }),
  },
  links: {
    tracksAuthor: {
      forward: { on: 'tracks', has: 'one', label: 'author' },
      reverse: { on: 'profiles', has: 'many', label: 'tracks' },
    },
    stemsAuthor: {
      forward: { on: 'stems', has: 'one', label: 'author' },
      reverse: { on: 'profiles', has: 'many', label: 'stems' },
    },
    playsProfile: {
      forward: { on: 'plays', has: 'one', label: 'profile', onDelete: 'cascade' },
      reverse: { on: 'profiles', has: 'many', label: 'plays' },
    },
    ratingsProfile: {
      forward: { on: 'ratings', has: 'one', label: 'profile', onDelete: 'cascade' },
      reverse: { on: 'profiles', has: 'many', label: 'ratings' },
    },
    userProfile: {
      forward: { on: 'profiles', has: 'one', label: 'user', onDelete: 'cascade' },
      reverse: { on: '$users', has: 'one', label: 'profile' },
    },
    lessonsProfile: {
      forward: { on: 'lessons', has: 'one', label: 'profile', onDelete: 'cascade' },
      reverse: { on: 'profiles', has: 'many', label: 'lessons' },
    },
    // Optional provenance: the song a lesson was captured on. Reverse label is
    // `lessonRecord` (not `lesson`) to avoid colliding with the legacy `lesson`
    // string attribute during migration. A song has at most one lesson record.
    lessonsTrack: {
      forward: { on: 'lessons', has: 'one', label: 'track' },
      reverse: { on: 'tracks', has: 'one', label: 'lessonRecord' },
    },
    lessonsStem: {
      forward: { on: 'lessons', has: 'one', label: 'stem' },
      reverse: { on: 'stems', has: 'one', label: 'lessonRecord' },
    },
  },
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
