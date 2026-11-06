// What stored code gets as globals: the pattern vocabulary, and not the runtime's own
// machinery. These are the exports that turn a string into running code or re-enter the scope.
const RUNTIME_ONLY = ['evaluate', 'evalScope', 'strudelScope', 'repl', 'webaudioRepl'];

export function vocabulary(module) {
  const { ...scope } = module;
  for (const name of RUNTIME_ONLY) delete scope[name];
  return scope;
}
