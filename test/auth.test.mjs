// test/auth.test.mjs — exercises the real token+allowlist gate, not a stub.
import { describe, it, expect } from 'vitest';
import { buildRequireAuth, buildResolveUser, buildRequireUser } from '../server/auth.mjs';

const mkRes = () => {
  const res = {};
  res.status = (code) => { res.statusCode = code; return res; };
  res.json = (body) => { res.body = body; return res; };
  return res;
};

// Run the middleware once; resolves whichever happens first: next() or a response.
const run = (mw, req) => new Promise((resolve) => {
  const res = mkRes();
  const next = () => resolve({ res, nexted: true });
  Promise.resolve(mw(req, res, next)).then(() => resolve({ res, nexted: false }));
});

const fakeAdmin = (verifyToken) => ({ auth: { verifyToken } });
// async allow-checker stub matching the real provider's contract
const mkAllow = (list) => async (e) => list.map((s) => s.toLowerCase()).includes((e || '').toLowerCase());
const isAllowed = mkAllow(['kalavox@gmail.com']);

describe('buildRequireAuth', () => {
  it('returns undefined (routes open) when adminDb is missing', () => {
    expect(buildRequireAuth({ adminDb: null, isAllowed })).toBeUndefined();
  });

  it('401s when no Authorization header is present', async () => {
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => ({})), isAllowed });
    const { res, nexted } = await run(mw, { headers: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('401s when the header is not a Bearer token', async () => {
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => ({})), isAllowed });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Basic abc' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });

  it('calls next and sets req.user for a valid, allowlisted token', async () => {
    const user = { id: 'u1', email: 'kalavox@gmail.com' };
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => user), isAllowed });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toEqual(user);
  });

  it('matches the allowlist case-insensitively', async () => {
    const user = { id: 'u1', email: 'KalaVox@Gmail.com' };
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => user), isAllowed });
    const { nexted } = await run(mw, { headers: { authorization: 'Bearer good' } });
    expect(nexted).toBe(true);
  });

  it('403s a valid token whose email is not on the allowlist', async () => {
    const user = { id: 'u2', email: 'stranger@example.com' };
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => user), isAllowed });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Bearer good' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('403s when the verified user has no email', async () => {
    const mw = buildRequireAuth({ adminDb: fakeAdmin(async () => ({ id: 'u3' })), isAllowed });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Bearer good' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(403);
  });

  it('401s when verifyToken throws (invalid/expired session)', async () => {
    const mw = buildRequireAuth({
      adminDb: fakeAdmin(async () => { throw new Error('bad token'); }),
      isAllowed,
    });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Bearer expired' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});

describe('buildResolveUser', () => {
  it('returns a pass-through when adminDb is missing', async () => {
    const mw = buildResolveUser({ adminDb: null, isAllowed });
    const req = { headers: {} };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds anonymously when no token is present', async () => {
    const mw = buildResolveUser({ adminDb: fakeAdmin(async () => ({})), isAllowed });
    const req = { headers: {} };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('attaches req.user for a valid allowlisted token', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => ({ id: 'u1', email: 'kalavox@gmail.com' })),
      isAllowed,
    });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toMatchObject({ id: 'u1' });
  });

  it('proceeds anonymously for a non-allowlisted email', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => ({ id: 'u9', email: 'stranger@x.com' })),
      isAllowed,
    });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });

  it('proceeds anonymously when the token is invalid', async () => {
    const mw = buildResolveUser({
      adminDb: fakeAdmin(async () => { throw new Error('bad'); }),
      isAllowed,
    });
    const req = { headers: { authorization: 'Bearer bad' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toBeUndefined();
  });
});

describe('buildRequireUser', () => {
  it('returns undefined when adminDb is missing', () => {
    expect(buildRequireUser({ adminDb: null })).toBeUndefined();
  });
  it('401s with no Authorization header', async () => {
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => ({})) });
    const { res, nexted } = await run(mw, { headers: {} });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
  it('attaches req.user for ANY valid token (no allowlist)', async () => {
    const user = { id: 'u9', email: 'stranger@example.com' };
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => user) });
    const req = { headers: { authorization: 'Bearer good' } };
    const { nexted } = await run(mw, req);
    expect(nexted).toBe(true);
    expect(req.user).toEqual(user);
  });
  it('401s on an invalid token', async () => {
    const mw = buildRequireUser({ adminDb: fakeAdmin(async () => { throw new Error('bad'); }) });
    const { res, nexted } = await run(mw, { headers: { authorization: 'Bearer bad' } });
    expect(nexted).toBe(false);
    expect(res.statusCode).toBe(401);
  });
});
