// scripts/lib/code-policy.mjs
// Static gate on Strudel code before it is executed or stored, so it stays a pattern
// expression. Works on the AST (same parser and options as @strudel/transpiler): text in
// comments and mini-notation strings can't false-positive, and string-built property names
// can't slip through.
//
// This raises the bar on what a steered agent can store. It is a denylist, not the boundary:
// the boundaries are the opaque frame at play time and the worker sandbox at save time
// (no code generation from strings, nothing writable that lasts, nothing outside its tree).
import { parse } from 'acorn';

// Free identifiers that reach the host, the page, the network or code generation.
const FORBIDDEN_IDENTIFIERS = new Set([
  'globalThis', 'global', 'window', 'self', 'top', 'parent', 'frames', 'opener',
  'document', 'location', 'history', 'navigator', 'origin',
  'localStorage', 'sessionStorage', 'indexedDB', 'caches', 'cookieStore',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'EventSource', 'RTCPeerConnection', 'webkitRTCPeerConnection',
  'Worker', 'SharedWorker', 'ServiceWorker', 'importScripts', 'postMessage',
  'eval', 'Function', 'AsyncFunction', 'GeneratorFunction', 'WebAssembly',
  'evaluate', 'evalScope', 'strudelScope', 'repl', 'webaudioRepl', // Strudel's own way from a string to code
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
    case 'MethodDefinition': case 'PropertyDefinition': {
      const v = node.computed ? computedKeyViolation(node.key) : null;
      return v ?? violation(node.value);
    }
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

const PARSE_OPTIONS = { ecmaVersion: 2022, allowAwaitOutsideFunction: true };

// Top-level `samples(...)` statements, as the parser sees them: text that merely looks like
// one inside a comment or a string isn't a statement, and isn't ever run.
export function samplesStatements(code) {
  return parse(code, PARSE_OPTIONS).body.filter((n) => n.type === 'ExpressionStatement'
    && n.expression.type === 'CallExpression' && n.expression.callee.name === 'samples')
    .map((n) => ({ start: n.start, end: n.end, call: code.slice(n.expression.start, n.expression.end) }));
}

// A saved row is public, and a row's prose has to live somewhere in its code. Bounds, not a bar:
// these limit how much a steered agent can publish, at about twice the most any live row holds
// (comments 1286, strings 2839). Pattern code in identifiers stays limited only by code length.
const MAX_COMMENT_CHARS = 3000;
const MAX_STRING_CHARS = 8000;

function stringChars(node) {
  if (Array.isArray(node)) return node.reduce((sum, child) => sum + stringChars(child), 0);
  if (!node || typeof node !== 'object') return 0;
  if (node.type === 'Literal') return typeof node.value === 'string' ? node.value.length : 0;
  if (node.type === 'TemplateElement') return node.value.raw.length;
  return Object.values(node).reduce((sum, child) => sum + stringChars(child), 0);
}

export function checkCodeVolume(code) {
  const comments = [];
  let ast;
  try {
    ast = parse(code, { ...PARSE_OPTIONS, onComment: comments });
  } catch (err) {
    return fail(`evaluation failed: ${err.message}`);
  }
  if (comments.reduce((sum, c) => sum + c.value.length, 0) > MAX_COMMENT_CHARS) return fail(`too many comments: at most ${MAX_COMMENT_CHARS} characters`);
  if (stringChars(ast.body) > MAX_STRING_CHARS) return fail(`too much text in strings: at most ${MAX_STRING_CHARS} characters`);
  return { ok: true };
}

export function checkCodePolicy(code) {
  let ast;
  try {
    ast = parse(code, PARSE_OPTIONS);
  } catch (err) {
    return fail(`evaluation failed: ${err.message}`);
  }
  return denied(violation(ast.body));
}
