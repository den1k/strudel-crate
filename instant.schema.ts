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
  rating: i.number().optional(), // 1-5 or absent
  notes: i.string().optional(), // per-item notes
  lesson: i.string().optional(), // cross-batch lesson
  playCount: i.number().optional(), // total plays across everyone; absent ⇒ 0
  ratingSum: i.number().optional(),   // sum of all users' ratings; absent ⇒ 0
  ratingCount: i.number().optional(), // number of users who rated; absent ⇒ 0
  remixOf: i.string().indexed().optional(), // source root slug when this item is a remix
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
  },
});

type _AppSchema = typeof _schema;
interface AppSchema extends _AppSchema {}
const schema: AppSchema = _schema;

export type { AppSchema };
export default schema;
