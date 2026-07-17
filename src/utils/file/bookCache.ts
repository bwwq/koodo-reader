export interface CacheStorage {
  addBook: (
    key: string,
    format: string,
    buffer: ArrayBuffer
  ) => Promise<unknown>;
  deleteBook: (key: string, format: string) => Promise<unknown> | unknown;
}

interface BuildBookCacheOptions {
  replace?: boolean;
  storage: CacheStorage;
}

export const shouldPreCacheBook = (
  format: string,
  forcePrecache: boolean,
  readerSetting: string
) =>
  format.toLowerCase() !== "pdf" &&
  (forcePrecache || readerSetting === "yes");

export const buildBookCache = async (
  bookKey: string,
  buffer: ArrayBuffer,
  rendition: { preCache: (content: ArrayBuffer) => Promise<any> },
  options: BuildBookCacheOptions
): Promise<boolean> => {
  const { storage } = options;
  try {
    if (options.replace) {
      await storage.deleteBook("cache-" + bookKey, "zip");
    }
    const cache = await rendition.preCache(buffer);
    if (!cache || cache === "err") return false;
    await storage.addBook("cache-" + bookKey, "zip", cache);
    return true;
  } catch (error) {
    console.warn("pre-cache book failed", bookKey, error);
    return false;
  }
};
