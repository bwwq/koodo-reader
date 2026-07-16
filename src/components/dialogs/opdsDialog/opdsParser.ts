import { OPDSEntry, OPDSFeed, OPDSLink } from "./interface";

export const DOWNLOAD_TYPES: Record<string, string> = {
  "application/epub+zip": "epub",
  "application/pdf": "pdf",
  "application/x-mobipocket-ebook": "mobi",
  "application/x-cbz": "cbz",
  "application/x-cbr": "cbr",
  "text/html": "html",
  "application/fb2+zip": "fb2",
  "application/fb2": "fb2",
};

export const ACQUISITION_RELS = [
  "http://opds-spec.org/acquisition",
  "http://opds-spec.org/acquisition/open-access",
  "http://opds-spec.org/acquisition/buy",
  "http://opds-spec.org/acquisition/borrow",
  "http://opds-spec.org/acquisition/sample",
];

function resolveUrl(href: string, baseUrl: string): string {
  if (!href) return "";
  try {
    return new URL(href, baseUrl).href;
  } catch {
    return href;
  }
}

export function isOPDSNavigationLink(link: OPDSLink): boolean {
  return (
    link.type?.includes("application/atom+xml") ||
    link.type?.includes("application/opds+json") ||
    link.type?.includes("text/html") ||
    link.rel === "subsection" ||
    link.rel === "related" ||
    link.rel === "collection" ||
    link.rel === "http://opds-spec.org/subsection"
  );
}

function normalizeSearchTemplate(href: string): string {
  return href
    .replace(/(?:\{|%7B)\?query(?:\}|%7D)/i, "?query={searchTerms}")
    .replace(/(?:\{|%7B)\?q(?:\}|%7D)/i, "?q={searchTerms}");
}

// Query Dublin Core elements across dc: and dcterms: namespaces.
function getDC(entry: Element, localName: string): string {
  return (
    entry.getElementsByTagNameNS(
      "http://purl.org/dc/elements/1.1/",
      localName
    )[0]?.textContent ||
    entry.getElementsByTagNameNS("http://purl.org/dc/terms/", localName)[0]
      ?.textContent ||
    ""
  );
}

export function parseOPDS1Feed(xmlText: string, feedUrl: string): OPDSFeed {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "application/xml");
  if (doc.querySelector("parsererror")) {
    throw new Error("Invalid XML response");
  }

  const feedTitle =
    doc.querySelector("feed > title")?.textContent ||
    doc.querySelector("title")?.textContent ||
    "";

  const feedLinks: OPDSLink[] = Array.from(
    doc.querySelectorAll("feed > link")
  ).map((link) => ({
    href: resolveUrl(link.getAttribute("href") || "", feedUrl),
    type: link.getAttribute("type") || "",
    rel: link.getAttribute("rel") || "",
    title: link.getAttribute("title") || undefined,
  }));

  let searchTemplate = "";
  const searchLink = feedLinks.find(
    (link) =>
      link.rel === "search" ||
      link.type?.includes("opensearch") ||
      link.type?.includes("application/opensearchdescription")
  );
  if (searchLink) searchTemplate = searchLink.href;

  const entries: OPDSEntry[] = Array.from(doc.querySelectorAll("entry")).map(
    (entry) => {
      const entryLinks: OPDSLink[] = Array.from(
        entry.querySelectorAll("link")
      ).map((link) => ({
        href: resolveUrl(link.getAttribute("href") || "", feedUrl),
        type: link.getAttribute("type") || "",
        rel: link.getAttribute("rel") || "",
        title: link.getAttribute("title") || undefined,
      }));

      const hasAcquisitionLink = entryLinks.some((link) =>
        ACQUISITION_RELS.includes(link.rel)
      );
      const hasSupportedDownload = entryLinks.some(
        (link) =>
          ACQUISITION_RELS.includes(link.rel) && Boolean(DOWNLOAD_TYPES[link.type])
      );
      const hasNavigationLink = entryLinks.some(isOPDSNavigationLink);
      const isNavigation =
        hasNavigationLink && !hasAcquisitionLink && !hasSupportedDownload;

      const coverLink = entryLinks.find(
        (link) =>
          link.rel === "http://opds-spec.org/image" ||
          link.rel === "http://opds-spec.org/cover"
      );
      const thumbnailLink =
        entryLinks.find(
          (link) =>
            link.rel === "http://opds-spec.org/image/thumbnail" ||
            link.rel === "http://opds-spec.org/thumbnail"
        ) || coverLink;

      const authors = Array.from(entry.querySelectorAll("author"))
        .map((author) => author.querySelector("name")?.textContent || "")
        .filter(Boolean);

      const categories = Array.from(entry.querySelectorAll("category"))
        .map(
          (category) =>
            category.getAttribute("label") || category.getAttribute("term") || ""
        )
        .filter(Boolean);

      return {
        id: entry.querySelector("id")?.textContent || "",
        title: entry.querySelector("title")?.textContent || "",
        authors,
        summary:
          entry.querySelector("summary")?.textContent ||
          entry.querySelector("content")?.textContent ||
          "",
        coverUrl: coverLink?.href || "",
        thumbnailUrl: thumbnailLink?.href || "",
        links: entryLinks,
        updated: entry.querySelector("updated")?.textContent || "",
        isNavigation,
        publisher: getDC(entry, "publisher"),
        language: getDC(entry, "language"),
        pubDate: getDC(entry, "date") || getDC(entry, "issued"),
        rights: getDC(entry, "rights"),
        categories,
      };
    }
  );

  return {
    title: feedTitle,
    url: feedUrl,
    entries,
    links: feedLinks,
    searchTemplate,
  };
}

function toStringValue(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  if (value && typeof value === "object" && "name" in value) {
    return toStringValue((value as { name?: unknown }).name);
  }
  return "";
}

function toStringList(value: unknown): string[] {
  const values = Array.isArray(value) ? value : value ? [value] : [];
  return values.map(toStringValue).filter(Boolean);
}

function parseJSONLink(value: any, baseUrl: string): OPDSLink {
  const rel = Array.isArray(value?.rel) ? value.rel[0] : value?.rel;
  return {
    href: resolveUrl(toStringValue(value?.href), baseUrl),
    type: toStringValue(value?.type),
    rel: toStringValue(rel),
    title: toStringValue(value?.title) || undefined,
    templated: Boolean(value?.templated),
  };
}

function parseJSONPublication(value: any, feedUrl: string): OPDSEntry {
  const metadata = value?.metadata || {};
  const links = (Array.isArray(value?.links) ? value.links : []).map(
    (link: any) => parseJSONLink(link, feedUrl)
  );
  const images = (Array.isArray(value?.images) ? value.images : []).map(
    (image: any) => parseJSONLink(image, feedUrl)
  );
  const cover =
    images.find((image: OPDSLink) => image.rel === "cover") || images[0];
  const thumbnail =
    images.find((image: OPDSLink) => image.rel === "thumbnail") ||
    images.find((image: any) => image !== cover) ||
    cover;
  const categories = toStringList(metadata.subject).concat(
    toStringList(metadata.category)
  );

  return {
    id: toStringValue(metadata.identifier) || toStringValue(value?.href),
    title: toStringValue(metadata.title),
    authors: toStringList(metadata.author),
    summary:
      toStringValue(metadata.description) || toStringValue(metadata.subtitle),
    coverUrl: cover?.href || "",
    thumbnailUrl: thumbnail?.href || "",
    links,
    updated:
      toStringValue(metadata.modified) || toStringValue(metadata.published),
    isNavigation: false,
    publisher: toStringList(metadata.publisher).join(", "),
    language: toStringList(metadata.language).join(", "),
    pubDate: toStringValue(metadata.published),
    rights: toStringValue(metadata.rights),
    categories: Array.from(new Set(categories)),
  };
}

function parseJSONNavigation(value: any, feedUrl: string): OPDSEntry {
  const link = parseJSONLink(value, feedUrl);
  return {
    id: link.href,
    title: toStringValue(value?.title) || link.title || link.href,
    authors: [],
    summary: toStringValue(value?.description),
    coverUrl: "",
    thumbnailUrl: "",
    links: [link],
    updated: "",
    isNavigation: true,
    publisher: "",
    language: "",
    pubDate: "",
    rights: "",
    categories: [],
  };
}

export function parseOPDS2Feed(jsonText: string, feedUrl: string): OPDSFeed {
  let doc: any;
  try {
    doc = JSON.parse(jsonText);
  } catch {
    throw new Error("Invalid JSON response");
  }

  const feedLinks = (Array.isArray(doc?.links) ? doc.links : []).map(
    (link: any) => parseJSONLink(link, feedUrl)
  );
  const searchLink = feedLinks.find((link: OPDSLink) => link.rel === "search");
  const entries: OPDSEntry[] = [];

  for (const item of Array.isArray(doc?.navigation) ? doc.navigation : []) {
    entries.push(parseJSONNavigation(item, feedUrl));
  }
  for (const publication of Array.isArray(doc?.publications)
    ? doc.publications
    : []) {
    entries.push(parseJSONPublication(publication, feedUrl));
  }
  for (const group of Array.isArray(doc?.groups) ? doc.groups : []) {
    const groupLink = (Array.isArray(group?.links) ? group.links : [])[0];
    if (groupLink) {
      entries.push(
        parseJSONNavigation(
          {
            ...groupLink,
            title:
              toStringValue(group?.metadata?.title) ||
              toStringValue(groupLink?.title),
          },
          feedUrl
        )
      );
    }
    for (const publication of Array.isArray(group?.publications)
      ? group.publications
      : []) {
      entries.push(parseJSONPublication(publication, feedUrl));
    }
  }

  const seen = new Set<string>();
  const uniqueEntries = entries.filter((entry) => {
    const key = `${entry.isNavigation ? "nav" : "book"}:${entry.id || entry.title}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    title: toStringValue(doc?.metadata?.title),
    url: feedUrl,
    entries: uniqueEntries,
    links: feedLinks,
    searchTemplate: searchLink
      ? normalizeSearchTemplate(searchLink.href)
      : "",
  };
}

export function parseOPDSResponse(
  text: string,
  feedUrl: string,
  contentType = ""
): OPDSFeed {
  if (
    contentType.toLowerCase().includes("json") ||
    text.trimStart().startsWith("{")
  ) {
    return parseOPDS2Feed(text, feedUrl);
  }
  return parseOPDS1Feed(text, feedUrl);
}
