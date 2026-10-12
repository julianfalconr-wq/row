// Custom ESLint rule — flags a top-level `const`/`let` referenced
// before its own declaration line, specifically when that reference
// executes EAGERLY (at the top level of a <script> block, or inside a
// chain of immediately-invoked function expressions) rather than
// deferred inside an ordinary function body that's only called later.
//
// Stock ESLint `no-use-before-define` does not distinguish these two
// cases at all: it flags a function body reading a later-declared
// const just as loudly as a genuine eager top-level read, even though
// the former is completely safe (the function is only ever CALLED
// after that const's declaration line has already run) and is an
// extremely common, intentional pattern throughout gym.html (helpers
// defined early in the file freely reference consts/functions
// declared later, as long as nothing actually INVOKES them before the
// full script has finished its first top-to-bottom pass). Enabling
// the stock rule file-wide would flood the output with hundreds of
// such false positives and make the real signal unusable.
//
// This narrower rule exists because the exact shape it targets — a
// NEW top-level `const` reading another top-level `const`/object
// declared later in the SAME enclosing (possibly IIFE-wrapped) scope
// — has caused three real production regressions in gym.html, each
// throwing "Cannot access 'X' before initialization" at page-load
// time and silently aborting the rest of that <script> block's
// execution (unwiring every click handler below it) with no visible
// error to the user. See commits 7214bbc and 909ddbd/02ba72e.
function isIIFE(fn) {
  return fn.parent && fn.parent.type === 'CallExpression' && fn.parent.callee === fn;
}
function isInsideDeferredFunction(node) {
  let curr = node.parent;
  while (curr) {
    if (curr.type === 'FunctionDeclaration') return true; // hoisted + only ever called later -- deferred by construction
    if (curr.type === 'FunctionExpression' || curr.type === 'ArrowFunctionExpression') {
      if (!isIIFE(curr)) return true; // a plain function/arrow expression, called elsewhere, later
      // else: an IIFE -- its body runs immediately, right here, so it's
      // transparent to this check; keep walking up through it.
    }
    curr = curr.parent;
  }
  return false;
}

module.exports = {
  meta: {
    type: 'problem',
    docs: { description: 'disallow an eagerly-executed reference to a top-level const/let before its own declaration (the exact shape behind 3 real gym.html regressions)' },
  },
  create(context) {
    return {
      'Program:exit'() {
        const scopeManager = context.sourceCode.scopeManager;
        const seen = new Set();
        function visitScope(scope) {
          scope.variables.forEach((variable) => {
            const def = variable.defs[0];
            if (!def || def.type !== 'Variable') return;
            const kind = def.parent && def.parent.kind;
            if (kind !== 'const' && kind !== 'let') return;
            const declEnd = def.node.range[1];
            variable.references.forEach((ref) => {
              if (ref.init) return; // the declaration's own initializer, not a use of it
              const id = ref.identifier;
              if (id.range[0] >= declEnd) return; // used at/after the declaration -- fine
              if (isInsideDeferredFunction(id)) return; // deferred -- not this rule's concern
              const key = id.range[0] + ':' + id.range[1];
              if (seen.has(key)) return;
              seen.add(key);
              context.report({
                node: id,
                message:
                  "'{{name}}' (top-level {{kind}}) is read eagerly before its own declaration runs — this throws a real ReferenceError at page-load time, not just a lint nit.",
                data: { name: variable.name, kind },
              });
            });
          });
          scope.childScopes.forEach(visitScope);
        }
        visitScope(scopeManager.globalScope);
      },
    };
  },
};
