import {
  getServiceAccessToken,
  getServiceBaseUrl,
  serviceRequest,
  serviceStream,
} from "./service";

export interface BookSourceItem {
  id: string;
  type: "opds" | "legado";
  name: string;
  group?: string;
  url: string;
  enabled: boolean;
  built_in?: boolean;
  searchable: boolean;
}

export interface SourceSearchResult {
  id: string;
  source_id: string;
  source_name: string;
  source_type: "opds" | "legado";
  title: string;
  authors: string[];
  summary?: string;
  cover_url?: string;
  latest_chapter?: string;
  format?: string;
}

export interface SourceSearchEvent {
  type: "source_started" | "source_error" | "source_finished" | "result";
  source_id: string;
  message?: string;
  count?: number;
  result?: SourceSearchResult;
}

export interface BookImportJob {
  id: string;
  status: "queued" | "running" | "ready" | "failed" | "cancelled";
  stage: string;
  current: number;
  total: number;
  error?: string;
  ready: boolean;
  file_name?: string;
  subscription_id?: string;
}

export interface BookImportOptions {
  sourceSubscriptionId?: string;
  replaceBookKey?: string;
  silent?: boolean;
  onImported?: (bookKey: string) => void;
}

export type ImportBookFunction = (
  file: File,
  options?: BookImportOptions
) => Promise<void>;

export interface BookSubscription {
  id: string;
  source_id: string;
  source_name: string;
  title: string;
  last_chapter_count: number;
  last_chapter?: string;
}

export interface BookSubscriptionCheck {
  id: string;
  title: string;
  source_name: string;
  update_available: boolean;
  previous_count: number;
  chapter_count: number;
  latest_chapter?: string;
}

const TRACKED_BOOKS_KEY = "source-book-subscriptions-v1";
const COMPLETED_IMPORTS_KEY = "source-book-imports-completed-v1";
const STORED_BOOK_REVISIONS_KEY = "source-book-file-revisions-v1";

interface StoredBookRefresh {
  buffer: ArrayBuffer;
  revision: string;
}

const getStoredBookRevisions = (): Record<string, string> => {
  try {
    const value = JSON.parse(
      localStorage.getItem(STORED_BOOK_REVISIONS_KEY) || "{}"
    );
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

export const markStoredBookRevision = (bookKey: string, revision: string) => {
  if (!bookKey || !revision) return;
  const revisions = getStoredBookRevisions();
  revisions[bookKey] = revision;
  localStorage.setItem(STORED_BOOK_REVISIONS_KEY, JSON.stringify(revisions));
};

export const getTrackedSourceBooks = (): Record<string, string> => {
  try {
    const value = JSON.parse(localStorage.getItem(TRACKED_BOOKS_KEY) || "{}");
    return value && typeof value === "object" ? value : {};
  } catch {
    return {};
  }
};

export const trackSourceBook = (subscriptionId: string, bookKey: string) => {
  if (!subscriptionId || !bookKey) return;
  const tracked = getTrackedSourceBooks();
  tracked[subscriptionId] = bookKey;
  localStorage.setItem(TRACKED_BOOKS_KEY, JSON.stringify(tracked));
};

export const untrackSourceBook = (subscriptionId: string) => {
  const tracked = getTrackedSourceBooks();
  delete tracked[subscriptionId];
  localStorage.setItem(TRACKED_BOOKS_KEY, JSON.stringify(tracked));
};

export const getCompletedBookImports = (): string[] => {
  try {
    const value = JSON.parse(
      localStorage.getItem(COMPLETED_IMPORTS_KEY) || "[]"
    );
    return Array.isArray(value)
      ? value.filter((id) => typeof id === "string")
      : [];
  } catch {
    return [];
  }
};

export const markBookImportCompleted = (jobId: string) => {
  if (!jobId) return;
  const completed = getCompletedBookImports();
  if (!completed.includes(jobId)) completed.push(jobId);
  localStorage.setItem(
    COMPLETED_IMPORTS_KEY,
    JSON.stringify(completed.slice(-100))
  );
};

export const listBookSources = () =>
  serviceRequest<BookSourceItem[]>("/v1/book-sources");

export const importBookSourceContent = (content: string) =>
  serviceRequest<{ imported: number }>("/v1/book-sources/import", {
    method: "POST",
    body: content,
  });

export const importBookSourceURL = (url: string) =>
  serviceRequest<{ imported: number }>("/v1/book-sources/import", {
    method: "POST",
    body: JSON.stringify({ url }),
  });

export const importOPDSSource = (catalog: {
  name: string;
  url: string;
  username?: string;
  password?: string;
}) =>
  serviceRequest<{ imported: number }>("/v1/book-sources/import", {
    method: "POST",
    body: JSON.stringify({ type: "opds", ...catalog }),
  });

export const updateBookSource = (
  id: string,
  patch: { name?: string; group?: string; enabled?: boolean }
) =>
  serviceRequest<null>(`/v1/book-sources/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });

export const deleteBookSource = (id: string) =>
  serviceRequest<null>(`/v1/book-sources/${encodeURIComponent(id)}`, {
    method: "DELETE",
  });

export const searchBookSources = (
  keyword: string,
  sourceIds: string[],
  page: number,
  onEvent: (event: SourceSearchEvent) => void
) =>
  serviceStream(
    "/v1/book-sources/search",
    { keyword, source_ids: sourceIds, page },
    (data) => onEvent(JSON.parse(data))
  );

export const createBookImport = (resultId: string) =>
  serviceRequest<BookImportJob>("/v1/book-imports", {
    method: "POST",
    body: JSON.stringify({ result_id: resultId }),
  });

export const listBookImports = () =>
  serviceRequest<BookImportJob[]>("/v1/book-imports");

export const listBookSubscriptions = () =>
  serviceRequest<BookSubscription[]>("/v1/book-subscriptions");

export const checkBookSubscription = (subscriptionId: string) =>
  serviceRequest<BookSubscriptionCheck>(
    `/v1/book-subscriptions/${encodeURIComponent(subscriptionId)}/check`,
    { method: "POST", body: "{}" }
  );

export const createBookSubscriptionImport = (subscriptionId: string) =>
  serviceRequest<BookImportJob>(
    `/v1/book-subscriptions/${encodeURIComponent(subscriptionId)}/import`,
    { method: "POST", body: "{}" }
  );

export const watchBookImport = (
  jobId: string,
  onEvent: (job: BookImportJob) => void
) =>
  serviceStream(
    `/v1/book-imports/${encodeURIComponent(jobId)}/events`,
    {},
    (data) => onEvent(JSON.parse(data))
  );

export const cancelBookImport = (jobId: string) =>
  serviceRequest<null>(`/v1/book-imports/${encodeURIComponent(jobId)}`, {
    method: "DELETE",
  });

export const getBookImportFormat = (file: File): string => {
  const match = file.name.toLowerCase().match(/\.([a-z0-9]+)$/);
  return match?.[1] || "epub";
};

export const claimBookImport = (
  jobId: string,
  bookKey: string,
  format: string
) =>
  serviceRequest<{ book_key: string; format: string; size: number }>(
    `/v1/book-imports/${encodeURIComponent(jobId)}/claim`,
    {
      method: "POST",
      body: JSON.stringify({ book_key: bookKey, format }),
    }
  );

export const downloadBookImport = async (jobId: string): Promise<File> => {
  const baseUrl = getServiceBaseUrl();
  const token = await getServiceAccessToken();
  const response = await fetch(
    `${baseUrl}/v1/book-imports/${encodeURIComponent(jobId)}/file`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const disposition = response.headers.get("content-disposition") || "";
  const match = disposition.match(/filename="?([^";]+)"?/i);
  const fileName = match?.[1] || "book.epub";
  return new File([await response.blob()], decodeURIComponent(fileName), {
    type: response.headers.get("content-type") || "application/epub+zip",
  });
};

export const downloadStoredSourceBook = async (
  bookKey: string,
  format: string
): Promise<ArrayBuffer> => {
  const baseUrl = getServiceBaseUrl();
  const token = await getServiceAccessToken();
  if (!baseUrl || !token) throw new Error("在线服务登录已失效");
  const response = await fetch(
    `${baseUrl}/v1/book-files/${encodeURIComponent(bookKey)}?format=${encodeURIComponent(format)}`,
    { headers: { Authorization: `Bearer ${token}` } }
  );
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.arrayBuffer();
};

export const refreshStoredSourceBookIfChanged = async (
  bookKey: string,
  format: string
): Promise<StoredBookRefresh | null> => {
  const baseUrl = getServiceBaseUrl();
  const token = await getServiceAccessToken();
  if (!baseUrl || !token) return null;
  const url = `${baseUrl}/v1/book-files/${encodeURIComponent(bookKey)}?format=${encodeURIComponent(format)}`;
  const headers = { Authorization: `Bearer ${token}` };
  const metadata = await fetch(url, { method: "HEAD", headers });
  if (!metadata.ok) return null;
  const revision =
    metadata.headers.get("etag") ||
    `${metadata.headers.get("last-modified") || ""}:${metadata.headers.get("content-length") || ""}`;
  if (!revision || getStoredBookRevisions()[bookKey] === revision) return null;
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return { buffer: await response.arrayBuffer(), revision };
};
