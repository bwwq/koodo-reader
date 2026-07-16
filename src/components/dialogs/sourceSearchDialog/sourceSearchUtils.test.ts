import { backupPage } from "../../../store/reducers/backupPage";
import { groupSourceResults, toggleSourceSelection } from "./sourceSearchUtils";

declare const test: (name: string, run: () => void) => void;
declare const expect: (value: unknown) => any;

test("merges equal title and author while preserving source variants", () => {
  const groups = groupSourceResults([
    { id: "a", source_id: "one", source_name: "One", source_type: "opds", title: "The Book", authors: ["A. Writer"] },
    { id: "b", source_id: "two", source_name: "Two", source_type: "legado", title: "the book", authors: ["A Writer"] },
  ]);
  expect(groups).toHaveLength(1);
  expect(groups[0].variants.map((item) => item.source_name)).toEqual(["One", "Two"]);
});

test("toggles individual source selection without changing other sources", () => {
  expect(toggleSourceSelection(["one", "two"], "one")).toEqual(["two"]);
  expect(toggleSourceSelection(["two"], "three")).toEqual(["two", "three"]);
});

test("opens the source-search secondary screen from global UI state", () => {
  const state = backupPage(undefined, { type: "HANDLE_SOURCE_SEARCH_DIALOG", payload: true });
  expect(state.isOpenSourceSearchDialog).toBe(true);
});
