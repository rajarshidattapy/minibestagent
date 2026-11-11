/**
 * Turns the date references people actually type - "on 3 November", "last
 * Tuesday", "yesterday", "on Monday" - into concrete day ranges.
 *
 * This is what makes "what did I ask you on 3 November?" answerable: the
 * range is resolved here, server-side, and the matching turns are pulled out
 * of the store and handed to the model. Leaving the model to work out which
 * day "last Tuesday" was, over a transcript it cannot see, is where this
 * kind of question usually fails.
 *
 * Everything is computed in the server's local timezone.
 */

export type DateRange = {
  /** The words that produced this range, for the recall header. */
  label: string;
  /** Inclusive start, at 00:00 local. */
  from: Date;
  /** Exclusive end, at 00:00 local the following day. */
  to: Date;
};

const MONTHS = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];

const WEEKDAYS = [
  "sunday",
  "monday",
  "tuesday",
  "wednesday",
  "thursday",
  "friday",
  "saturday",
];

const DAY_MS = 86_400_000;

function startOfDay(date: Date): Date {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function dayRange(start: Date, days = 1): Pick<DateRange, "from" | "to"> {
  const from = startOfDay(start);
  return { from, to: new Date(from.getTime() + days * DAY_MS) };
}

/** Month index for a full or abbreviated name, or -1. */
function monthIndex(name: string): number {
  const needle = name.toLowerCase();
  return MONTHS.findIndex((m) => m === needle || m.slice(0, 3) === needle.slice(0, 3));
}

/**
 * The most recent occurrence of a calendar day, looking backwards.
 * "3 November" in January means last November, not a date ten months away.
 */
function mostRecentMonthDay(month: number, day: number, now: Date): Date {
  const thisYear = new Date(now.getFullYear(), month, day);
  if (thisYear.getTime() <= startOfDay(now).getTime()) return thisYear;
  return new Date(now.getFullYear() - 1, month, day);
}

/**
 * The most recent occurrence of a weekday.
 * `strictlyBefore` is what separates "last Tuesday" (a week ago, when today
 * is Tuesday) from a bare "Tuesday" (which can mean today).
 */
function mostRecentWeekday(weekday: number, now: Date, strictlyBefore: boolean): Date {
  const today = startOfDay(now);
  let delta = (today.getDay() - weekday + 7) % 7;
  if (delta === 0 && strictlyBefore) delta = 7;
  return new Date(today.getTime() - delta * DAY_MS);
}

/**
 * Find every date reference in a message. Multiple references are fine -
 * "between Monday and Wednesday" yields both.
 */
export function resolveDateReferences(text: string, now: Date = new Date()): DateRange[] {
  const found: DateRange[] = [];
  const seen = new Set<string>();

  const add = (label: string, range: Pick<DateRange, "from" | "to">) => {
    const key = `${range.from.getTime()}:${range.to.getTime()}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ label, ...range });
  };

  const haystack = text.toLowerCase();

  // ISO dates: 2026-11-03
  for (const match of haystack.matchAll(/\b(\d{4})-(\d{2})-(\d{2})\b/g)) {
    const [, year, month, day] = match;
    const date = new Date(Number(year), Number(month) - 1, Number(day));
    if (!Number.isNaN(date.getTime())) add(match[0], dayRange(date));
  }

  // "3 November", "3rd Nov", "November 3", "Nov 3rd" - with an optional year.
  const monthNames = MONTHS.map((m) => `${m.slice(0, 3)}[a-z]*`).join("|");
  const dayFirst = new RegExp(
    `\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthNames})\\b(?:\\s+(\\d{4}))?`,
    "g",
  );
  const monthFirst = new RegExp(
    `\\b(${monthNames})\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?`,
    "g",
  );

  for (const match of haystack.matchAll(dayFirst)) {
    const month = monthIndex(match[2]);
    const day = Number(match[1]);
    if (month < 0 || day < 1 || day > 31) continue;
    const date = match[3]
      ? new Date(Number(match[3]), month, day)
      : mostRecentMonthDay(month, day, now);
    add(match[0], dayRange(date));
  }

  for (const match of haystack.matchAll(monthFirst)) {
    const month = monthIndex(match[1]);
    const day = Number(match[2]);
    if (month < 0 || day < 1 || day > 31) continue;
    const date = match[3]
      ? new Date(Number(match[3]), month, day)
      : mostRecentMonthDay(month, day, now);
    add(match[0], dayRange(date));
  }

  // Weekdays, with or without a "last"/"this"/"on" qualifier.
  const weekdayNames = WEEKDAYS.join("|");
  const weekdayPattern = new RegExp(`\\b(last|this|past|on)?\\s*(${weekdayNames})\\b`, "g");
  for (const match of haystack.matchAll(weekdayPattern)) {
    const weekday = WEEKDAYS.indexOf(match[2]);
    const qualifier = match[1];
    // "last Tuesday" on a Tuesday means a week ago, not today.
    const strictlyBefore = qualifier === "last" || qualifier === "past";
    add(match[0].trim(), dayRange(mostRecentWeekday(weekday, now, strictlyBefore)));
  }

  // Plain relative words.
  if (/\b(today|this morning|this afternoon|this evening|earlier today)\b/.test(haystack)) {
    add("today", dayRange(now));
  }
  if (/\b(yesterday|last night)\b/.test(haystack)) {
    add("yesterday", dayRange(new Date(now.getTime() - DAY_MS)));
  }
  if (/\bday before yesterday\b/.test(haystack)) {
    add("the day before yesterday", dayRange(new Date(now.getTime() - 2 * DAY_MS)));
  }

  // "3 days ago", "two weeks ago"
  const WORD_NUMBERS: Record<string, number> = {
    a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
    six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  };
  for (const match of haystack.matchAll(
    /\b(\d{1,3}|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+ago\b/g,
  )) {
    const count = WORD_NUMBERS[match[1]] ?? Number(match[1]);
    if (!Number.isFinite(count) || count <= 0) continue;
    const unitDays = match[2] === "week" ? 7 : match[2] === "month" ? 30 : 1;
    const start = new Date(now.getTime() - count * unitDays * DAY_MS);
    // For weeks and months, cover the whole period rather than a single day:
    // "two weeks ago" is a neighbourhood, not an instant.
    add(match[0], match[2] === "day" ? dayRange(start) : dayRange(start, unitDays));
  }

  // "last week" / "this week", as whole Monday-Sunday blocks.
  if (/\blast week\b/.test(haystack)) {
    const monday = mostRecentWeekday(1, now, false);
    add("last week", dayRange(new Date(monday.getTime() - 7 * DAY_MS), 7));
  }
  if (/\bthis week\b/.test(haystack)) {
    add("this week", dayRange(mostRecentWeekday(1, now, false), 7));
  }

  return found;
}

/** True when the message is asking about the past at all. */
export function mentionsThePast(text: string): boolean {
  return (
    resolveDateReferences(text).length > 0 ||
    /\b(earlier|before|previously|last time|you said|you told me|we discussed|we talked about|i asked|still (correct|true|right|accurate|valid)|since then|has (it|that|any of (them|these|those))? ?changed|any(thing)? change[ds]?|update[ds]?)\b/i.test(
      text,
    )
  );
}

/** "3 November 2026" - for labelling recalled material. */
export function formatDay(date: Date): string {
  return date.toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
