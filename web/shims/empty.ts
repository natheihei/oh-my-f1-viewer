/**
 * Stands in for a Node module nothing calls in the browser. Importing it is fine, and so is reading any
 * name from it. Calling one of those names says which.
 */
function stub(name: string): unknown {
  const target = function () {} as unknown as Record<string | symbol, unknown>;
  return new Proxy(target, {
    get(_t, key) {
      if (key === '__esModule') return false;
      if (key === 'then' || typeof key === 'symbol') return undefined;
      if (key === 'default') return stub(name);
      if (key === 'prototype') return {};
      return stub(`${name}.${String(key)}`);
    },
    apply() {
      throw new Error(`${name} is not available in the browser`);
    },
    construct() {
      throw new Error(`${name} is not available in the browser`);
    },
  });
}

export function emptyModule(name: string): unknown {
  return stub(name);
}
