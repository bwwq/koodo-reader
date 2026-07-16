import {
  isOPDSNavigationLink,
  parseOPDS1Feed,
  parseOPDS2Feed,
  parseOPDSResponse,
} from "./opdsParser";

declare const test: (name: string, run: () => void) => void;
declare const expect: (value: unknown) => any;

test("parses OPDS 1 navigation and acquisition entries", () => {
  const feed = parseOPDS1Feed(
    `<?xml version="1.0"?>
    <feed xmlns="http://www.w3.org/2005/Atom">
      <title>Open books</title>
      <entry>
        <id>new</id><title>New books</title>
        <link rel="subsection" href="/new.atom" type="application/atom+xml" />
      </entry>
      <entry>
        <id>book-1</id><title>Book One</title><author><name>Author One</name></author>
        <link rel="http://opds-spec.org/acquisition/open-access" href="/book.epub" type="application/epub+zip" />
      </entry>
    </feed>`,
    "https://catalog.example/opds"
  );

  expect(feed.title).toBe("Open books");
  expect(feed.entries).toHaveLength(2);
  expect(feed.entries[0].isNavigation).toBe(true);
  expect(feed.entries[0].links[0].href).toBe(
    "https://catalog.example/new.atom"
  );
  expect(feed.entries[1].isNavigation).toBe(false);
  expect(feed.entries[1].authors).toEqual(["Author One"]);
});

test("parses OPDS 2 catalogs, groups, metadata, and URI-template search", () => {
  const feed = parseOPDS2Feed(
    JSON.stringify({
      metadata: { title: "Archive" },
      links: [
        {
          href: "/search{?query}&type=search",
          type: "application/opds+json",
          rel: "search",
          templated: true,
        },
      ],
      navigation: [
        {
          href: "/ebooks",
          title: "eBooks",
          type: "application/opds+json",
          rel: "collection",
        },
      ],
      groups: [
        {
          metadata: { title: "Public Domain" },
          links: [
            {
              href: "/public-domain",
              type: "application/opds+json",
              rel: "self",
            },
          ],
          publications: [
            {
              metadata: {
                identifier: "book-2",
                title: "Book Two",
                author: [{ name: "Author Two" }],
                language: ["en"],
                publisher: { name: "Open Press" },
                published: "2026-01-01",
                subject: [{ name: "History" }],
              },
              links: [
                {
                  href: "/book.pdf",
                  type: "application/pdf",
                  rel: "http://opds-spec.org/acquisition/open-access",
                },
              ],
              images: [
                { href: "/cover.jpg", type: "image/jpeg", rel: "cover" },
              ],
            },
          ],
        },
      ],
    }),
    "https://archive.example/opds"
  );

  expect(feed.title).toBe("Archive");
  expect(feed.searchTemplate).toBe(
    "https://archive.example/search?query={searchTerms}&type=search"
  );
  expect(feed.entries.map((entry) => entry.title)).toEqual([
    "eBooks",
    "Public Domain",
    "Book Two",
  ]);
  expect(isOPDSNavigationLink(feed.entries[0].links[0])).toBe(true);
  expect(feed.entries[2]).toMatchObject({
    authors: ["Author Two"],
    language: "en",
    publisher: "Open Press",
    categories: ["History"],
    coverUrl: "https://archive.example/cover.jpg",
  });
  expect(feed.entries[2].links[0].href).toBe(
    "https://archive.example/book.pdf"
  );
});

test("auto-detects OPDS 2 JSON responses", () => {
  const feed = parseOPDSResponse(
    '{"metadata":{"title":"JSON catalog"}}',
    "https://catalog.example/opds",
    "application/opds+json"
  );
  expect(feed.title).toBe("JSON catalog");
});
