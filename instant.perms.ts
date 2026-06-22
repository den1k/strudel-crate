// instant.perms.ts
// Public reads (or owner-only for non-public items). ALL writes are server-side
// via the admin SDK, which bypasses these rules — so client create/update/delete
// are intentionally "false". profiles are publicly viewable so artist names show
// to logged-out visitors (playback is public).
const ownerOrPublic =
  "data.isPublic == true || (auth.id != null && auth.id in data.ref('author.user.id'))";

const rules = {
  tracks: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
  },
  stems: {
    allow: { view: ownerOrPublic, create: 'false', update: 'false', delete: 'false' },
  },
  profiles: {
    allow: { view: 'true', create: 'false', update: 'false', delete: 'false' },
  },
  plays: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: 'false',
      update: 'false',
      delete: 'false',
    },
  },
};

export default rules;
