// test/fake-admin.mjs
// Minimal stand-in for @instantdb/admin used in tests. Records transactions and
// answers queries from a seeded in-memory store. Supports equality where,
// nested 'user.id' where, and { slug: { $in: [...] } }.
function matchWhere(row, where) {
  return Object.entries(where).every(([key, cond]) => {
    const val = key === 'user.id' ? row.user?.id : row[key];
    if (cond && typeof cond === 'object' && Array.isArray(cond.$in)) return cond.$in.includes(val);
    return val === cond;
  });
}

export function fakeAdmin(initial = {}) {
  const store = JSON.parse(JSON.stringify(initial)); // { profiles:[], tracks:[], stems:[] }
  const txs = []; // recorded ops: { ns, id, update?, link?, delete? }

  const chainFor = (ns, entId) => {
    const op = { ns, id: entId };
    const record = () => { if (!txs.includes(op)) txs.push(op); };
    const chain = {
      update(data) { op.update = data; record(); return chain; },
      link(links) { op.link = links; record(); return chain; },
      delete() { op.delete = true; record(); return chain; },
    };
    return chain;
  };

  return {
    _store: store,
    _txs: txs,
    tx: new Proxy({}, {
      get: (_t, ns) => new Proxy({}, { get: (_t2, entId) => chainFor(ns, entId) }),
    }),
    async query(q) {
      const out = {};
      for (const ns of Object.keys(q)) {
        let rows = store[ns] ?? [];
        const where = q[ns].$?.where;
        out[ns] = where ? rows.filter((r) => matchWhere(r, where)) : rows.slice();
      }
      return out;
    },
    async transact() { /* ops already recorded via the chain */ },
  };
}
