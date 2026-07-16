import { SourceSearchResult } from "../../../utils/request/bookSources";

export interface ResultGroup {
  key: string;
  title: string;
  authors: string[];
  variants: SourceSearchResult[];
}

export function normalizeSourceText(value: string) {
  return value.toLocaleLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

export function groupSourceResults(results: SourceSearchResult[]): ResultGroup[] {
  const groups = new Map<string, ResultGroup>();
  for (const result of results) {
    const key = `${normalizeSourceText(result.title)}::${normalizeSourceText(
      result.authors.join(" ")
    )}`;
    const current = groups.get(key);
    if (current) current.variants.push(result);
    else
      groups.set(key, {
        key,
        title: result.title,
        authors: result.authors,
        variants: [result],
      });
  }
  return Array.from(groups.values());
}

export function toggleSourceSelection(selected: string[], id: string): string[] {
  return selected.includes(id)
    ? selected.filter((item) => item !== id)
    : [...selected, id];
}
