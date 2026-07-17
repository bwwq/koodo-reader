import { buildBookCache, shouldPreCacheBook } from "./bookCache";

describe("book cache", () => {
  it("forces source books to be cached without changing normal PDF behavior", () => {
    expect(shouldPreCacheBook("epub", true, "no")).toBe(true);
    expect(shouldPreCacheBook("epub", false, "yes")).toBe(true);
    expect(shouldPreCacheBook("epub", false, "no")).toBe(false);
    expect(shouldPreCacheBook("pdf", true, "yes")).toBe(false);
  });

  it("replaces an obsolete cache after a source update", async () => {
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

  it("does not fail the book import when cache generation fails", async () => {
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
});
