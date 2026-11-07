/**
 * A D1 binding whose statements matching `pattern` throw `message`, when
 * they're prepared. "everything" fails every statement and every batch.
 * Wrap one in another to fail different statements with different errors.
 */
export function failingDb(db: D1Database, pattern: RegExp | "everything", message = "D1 down"): D1Database {
  if (pattern instanceof RegExp && (pattern.global || pattern.sticky)) {
    // test() with these flags is stateful: it would fail every other match.
    throw new Error("failingDb: use a pattern without the g or y flag");
  }
  const fails = (sql: string) => pattern === "everything" || pattern.test(sql);
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (fails(sql)) {
            throw new Error(message);
          }
          return target.prepare(sql);
        };
      }
      if (prop === "batch" && pattern === "everything") {
        return () => Promise.reject(new Error(message));
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
