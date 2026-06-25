// src/email.js — normalize/validate an email for the allowlist UI. Pure; no DOM.
const RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function normalizeEmail(raw) {
  const e = (raw || '').trim().toLowerCase();
  return RE.test(e) ? e : null;
}
