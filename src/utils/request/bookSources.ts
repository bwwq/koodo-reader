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
