// scripts/lib/code-policy.mjs
// Static gate on Strudel code before it is executed or stored. Track code is plain JS
// that runs in this process at save time and on the crate origin at play time, where
// the visitor's session lives, so it must stay a pattern expression. Works on the AST
// (same parser and options as @strudel/transpiler): text in comments and mini-notation
// strings can't false-positive, and string-built property names can't slip through.
//
// This raises the bar on what a steered agent can store. It is not a sandbox; the real
// isolation would be evaluating code on a separate origin.
import { parse } from 'acorn';

// Free identifiers that reach the host, the page, the network or code generation.
const FORBIDDEN_IDENTIFIERS = new Set([
  'globalThis', 'global', 'window', 'self', 'top', 'parent', 'frames', 'opener',
  'document', 'location', 'history', 'navigator', 'origin',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection',
  'Worker', 'SharedWorker', 'ServiceWorker', 'importScripts', 'postMessage',
  'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'WebAssembly',
  'setTimeout', 'setInterval', 'setImmediate', 'queueMicrotask', 'requestAnimationFrame',
  'Reflect', 'Proxy', 'Object', 'Symbol', 'arguments',
  'process', 'require', 'module', 'exports', 'Buffer', '__dirname', '__filename',
]);

// Property names that walk from any value back to Function.
const FORBIDDEN_PROPERTIES = new Set([
  'constructor', 'prototype', '__proto__',
  '__defineGetter__', '__defineSetter__', '__lookupGetter__', '__lookupSetter__',
]);

const fail = (error) => ({ ok: false, error });
const denied = (why) => (why ? fail(`code policy: ${why}`) : { ok: true });

// Depth-first; returns the first violation or null.
function violation(node) {
  if (Array.isArray(node)) {
    for (const child of node) {
      const v = violation(child);
      if (v) return v;
    }
    return null;
  }
  if (!node || typeof node.type !== 'string') return null;

  switch (node.type) {
    case 'ThisExpression': return '`this` is not allowed';
    case 'ImportExpression': case 'ImportDeclaration': case 'ExportNamedDeclaration':
    case 'ExportDefaultDeclaration': case 'ExportAllDeclaration': case 'MetaProperty':
      return 'modules are not allowed';
    case 'Identifier':
      return FORBIDDEN_IDENTIFIERS.has(node.name) ? `\`${node.name}\` is not allowed` : null;
    case 'MemberExpression': {
      if (!node.computed) {
        if (FORBIDDEN_PROPERTIES.has(node.property.name)) return `\`.${node.property.name}\` is not allowed`;
        return violation(node.object); // a plain property name isn't a free identifier
      }
      const v = computedKeyViolation(node.property);
      return v ?? violation(node.object);
    }
    case 'Property': {
      if (node.computed) {
        const v = computedKeyViolation(node.key);
        if (v) return v;
      } else {
        const name = node.key.name ?? node.key.value;
        if (FORBIDDEN_PROPERTIES.has(name)) return `\`${name}\` is not allowed`;
      }
      return violation(node.value);
    }
    case 'MethodDefinition': case 'PropertyDefinition':
      return violation(node.value);
    default:
  }
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const value = node[key];
    if (value && typeof value === 'object') {
      const v = violation(value);
      if (v) return v;
    }
  }
  return null;
}

// A computed key must be a literal, or a name could be assembled at runtime.
function computedKeyViolation(key) {
  if (key.type !== 'Literal') {
    // Numeric indexing by expression can't be told apart from a built string.
    return 'computed property access must use a literal key';
  }
  return FORBIDDEN_PROPERTIES.has(String(key.value)) ? `\`${key.value}\` is not allowed` : null;
}

export function checkCodePolicy(code) {
  let ast;
  try {
    ast = parse(code, { ecmaVersion: 2022, allowAwaitOutsideFunction: true });
  } catch (err) {
    return fail(`evaluation failed: ${err.message}`);
  }
  return denied(violation(ast.body));
}
