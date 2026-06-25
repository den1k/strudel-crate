// Docs: https://www.instantdb.com/docs/permissions

import type { InstantRules } from "@instantdb/core";

const rules = {
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
} satisfies InstantRules;

export default rules;
