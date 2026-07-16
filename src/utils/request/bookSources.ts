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
}

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
