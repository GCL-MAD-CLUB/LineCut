export type SearchMode = "filter" | "highlight";
export type SearchRule =
  | "contains"
  | "containsAll"
  | "containsWords"
  | "doesNotContain"
  | "startsWith"
  | "endsWith"
  | "isEmpty"
  | "isNotEmpty";

export function canHighlightSearchRule(rule: SearchRule) {
  return rule !== "doesNotContain" && rule !== "isEmpty" && rule !== "isNotEmpty";
}

function searchTerms(query: string) {
  const normalized = query.trim().toLocaleLowerCase();
  return normalized ? (normalized.match(/[\p{L}\p{N}_]+/gu) ?? [normalized]) : [];
}

function termPattern(term: string, wholeWord: boolean) {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(
    wholeWord ? `(?<![\\p{L}\\p{N}_])${escaped}(?![\\p{L}\\p{N}_])` : escaped,
    "giu",
  );
}

export function matchesTextSearch(values: readonly string[], query: string, rule: SearchRule) {
  const populated = values.map((value) => value.trim().toLocaleLowerCase()).filter(Boolean);
  if (rule === "isEmpty") return populated.length === 0;
  if (rule === "isNotEmpty") return populated.length > 0;
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return true;
  const text = populated.join(" ");
  const terms = searchTerms(query);
  switch (rule) {
    case "contains":
      return terms.some((term) => text.includes(term));
    case "containsAll":
      return terms.every((term) => text.includes(term));
    case "containsWords":
      return terms.every((term) => termPattern(term, true).test(text));
    case "doesNotContain":
      return terms.every((term) => !text.includes(term));
    case "startsWith":
      return populated.some((value) => value.startsWith(normalized));
    case "endsWith":
      return populated.some((value) => value.endsWith(normalized));
  }
}

export interface SearchRange {
  start: number;
  end: number;
}

/** Ranges refer to the original text, so casing and Unicode offsets are preserved. */
export function textSearchRanges(
  text: string,
  query: string,
  rule: SearchRule,
  fields: readonly SearchRange[] = [{ start: 0, end: text.length }],
): SearchRange[] {
  if (!query.trim() || !canHighlightSearchRule(rule)) return [];
  const ranges: SearchRange[] = [];
  if (rule === "startsWith" || rule === "endsWith") {
    for (const field of fields) {
      const value = text.slice(field.start, field.end);
      for (const match of value.matchAll(termPattern(query.trim(), false))) {
        const start = match.index;
        const end = start + match[0].length;
        if (rule === "startsWith" ? !value.slice(0, start).trim() : !value.slice(end).trim()) {
          ranges.push({ start: field.start + start, end: field.start + end });
        }
      }
    }
  } else {
    for (const term of searchTerms(query)) {
      for (const match of text.matchAll(termPattern(term, rule === "containsWords"))) {
        ranges.push({ start: match.index, end: match.index + match[0].length });
      }
    }
  }
  const merged: SearchRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || b.end - a.end)) {
    const previous = merged.at(-1);
    if (previous && range.start <= previous.end) previous.end = Math.max(previous.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** Navigate in display order, wrapping at either end, including from a nonmatching row. */
export function nextSearchMatchIndex(
  matchingIndices: readonly number[],
  currentIndex: number,
  direction: -1 | 1,
) {
  if (!matchingIndices.length) return -1;
  if (direction === 1) {
    return matchingIndices.find((index) => index > currentIndex) ?? matchingIndices[0];
  }
  for (let index = matchingIndices.length - 1; index >= 0; index--) {
    if (matchingIndices[index] < currentIndex) return matchingIndices[index];
  }
  return matchingIndices.at(-1)!;
}
