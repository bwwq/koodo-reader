import { buildBookCache, shouldPreCacheBook } from "./bookCache";

declare const test: (name: string, run: () => void | Promise<void>) => void;
declare const expect: (value: unknown) => any;

test("forces source books to be cached without changing PDF behavior", () => {
  expect(shouldPreCacheBook("epub", true, "no")).toBe(true);
  expect(shouldPreCacheBook("epub", false, "yes")).toBe(true);
  expect(shouldPreCacheBook("epub", false, "no")).toBe(false);
  expect(shouldPreCacheBook("pdf", true, "yes")).toBe(false);
});

test("replaces an obsolete cache after a source update", async () => {
  const calls: string[] = [];
  const storage = {
    deleteBook: async (key: string, format: string) => {
      calls.push(`delete:${key}.${format}`);
    },
    addBook: async (key: string, format: string) => {
      calls.push(`add:${key}.${format}`);
    },
  };
  const result = await buildBookCache(
    "book-key",
    new ArrayBuffer(1),
    { preCache: async () => new ArrayBuffer(2) },
    { replace: true, storage }
  );

  expect(result).toBe(true);
  expect(calls).toEqual([
    "delete:cache-book-key.zip",
    "add:cache-book-key.zip",
  ]);
});

test("keeps importing when cache generation fails", async () => {
  const storage = {
    deleteBook: async () => undefined,
    addBook: async () => {
      throw new Error("must not be called");
    },
  };
  const result = await buildBookCache(
    "book-key",
    new ArrayBuffer(1),
    { preCache: async () => "err" },
    { storage }
  );

  expect(result).toBe(false);
});
