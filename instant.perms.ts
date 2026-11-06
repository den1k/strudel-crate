// Docs: https://www.instantdb.com/docs/permissions

import type { InstantRules } from "@instantdb/core";

const rules = {
  // Only the schema (pushed with the admin token) defines attributes. Without this a
  // client could mint new namespaces and attributes, which no entity rule covers.
  attrs: {
    allow: {
      create: "false",
    },
  },
  plays: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  stems: {
    allow: {
      view: "data.isPublic == true || (auth.id != null && auth.id in data.ref('author.user.id'))",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  tracks: {
    allow: {
      view: "data.isPublic == true || (auth.id != null && auth.id in data.ref('author.user.id'))",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  ratings: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  lessons: {
    allow: {
      view: "auth.id != null && auth.id in data.ref('profile.user.id')",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  profiles: {
    allow: {
      view: "true",
      create: "false",
      delete: "false",
      update: "false",
    },
  },
  allowlist: {
    allow: {
      view: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      create: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      delete: "auth.ref('$user.email')[0] == 'kalavox@gmail.com'",
      update: "false",
    },
  },
} satisfies InstantRules;

export default rules;
