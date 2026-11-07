/**
 * A D1 binding whose statements matching `pattern` throw `message`. With the
 * pattern /./, batches fail too. Wrap one in another to fail different
 * statements with different errors.
 */
export function failingDb(db: D1Database, pattern: RegExp, message = "D1 down"): D1Database {
  return new Proxy(db, {
    get(target, prop) {
      if (prop === "prepare") {
        return (sql: string) => {
          if (pattern.test(sql)) {
            throw new Error(message);
          }
          return target.prepare(sql);
        };
      }
      if (prop === "batch" && pattern.source === ".") {
        return () => Promise.reject(new Error(message));
      }
      const value: unknown = Reflect.get(target, prop);
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    },
  });
}
