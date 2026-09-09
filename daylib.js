// =============================================================
// Shared day-boundary utility — the ONE place "what calendar day is
// this moment" gets computed for the whole app.
//
// This project has fixed the UTC-vs-local-calendar-day bug class
// independently at least three times: gym.html's wtDateKey()/
// wtParseKey(), main.html's Calendar card localMidnightOffset(), and
// main.html/health.html's hardcoded 6am "active date" helpers
// (getActiveDateString()/getActiveDate(), used for Goals and Daily
// Stack). This file generalizes that same underlying idea — read a
// Date's LOCAL calendar fields directly rather than round-tripping
// through a bare "YYYY-MM-DD" string (which JS parses as UTC
// midnight) — into one configurable formula: a user-set "day end
// time" (for people who sleep past midnight) plus an explicit IANA
// timezone (so an overridden zone works even if the browser's own
// guess is wrong, e.g. while traveling).
//
// Loaded as a module (<script type="module" src="daylib.js">) so it
// works two ways with no bundler:
//   - In the browser, this also sets window.DayLib, since every
//     other script in this project (cronometer-lib.js, sync.js,
//     topbar.js) is a plain classic script that expects a global.
//   - Later, a Vercel function can `import { effectiveDateKey } from
//     '../daylib.js'` directly — Vercel's Node runtime supports
//     native ESM imports with no build step, same as the browser.
//
// Config shape (see DEFAULT_PROFILE): { dayEndTime: "HH:MM" (24h),
// timezone: "auto" | an IANA zone name, categoryWeights: {...} }.
// categoryWeights lives here too (not just day-end/timezone) because
// it's the same "General Settings" object as a whole — this module
// just happens to be the one that reads dayEndTime/timezone out of
// it; other code (main.html's score engine) reads categoryWeights
// out of the same loaded object instead of caching it separately.
//
// IMPORTANT DEFAULT-SAFETY PROPERTY: dayEndTime "00:00" makes the
// "before day-end" branch below never fire (a wall-clock hour is
// never < 0), so effectiveDateKey() returns exactly the plain
// calendar date — bit-for-bit what every existing dateKey()/
// wtDateKey() in this project already returns today. Migrating a
// file to call this instead is a no-op until the user actually
// changes the day-end time away from midnight.
// =============================================================

const PROFILE_KEY = 'dashboard:general_settings';

// NOTE: the build request specified defaults "35/20/20/10/10" for
// Habits/Training/Nutrition/Water/Daily Stack — that sums to 95, not
// 100, which the same request also requires. Bumped Habits to 40 here
// (leaving Training/Nutrition/Water/Daily Stack exactly as specified)
// since Habits is already described as the highest-weighted category;
// flagged explicitly rather than silently shipping a 95-total default.
export const DEFAULT_PROFILE = {
  dayEndTime: '00:00',
  timezone: 'auto',
  categoryWeights: { habits: 40, training: 20, nutrition: 20, water: 10, dailyStack: 10 },
};

export function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (raw) {
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') {
        return Object.assign({}, DEFAULT_PROFILE, p, {
          categoryWeights: Object.assign({}, DEFAULT_PROFILE.categoryWeights, p.categoryWeights || {}),
        });
      }
    }
  } catch (e) {}
  return JSON.parse(JSON.stringify(DEFAULT_PROFILE));
}

export function saveProfile(profile) {
  try { localStorage.setItem(PROFILE_KEY, JSON.stringify(profile)); } catch (e) {}
}

export function resolveTimeZone(profile) {
  const p = profile || loadProfile();
  if (p.timezone && p.timezone !== 'auto') return p.timezone;
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'; } catch (e) { return 'UTC'; }
}

// Wall-clock {year,month,day,hour,minute} of `date` AS OBSERVED in
// `timeZone` — deliberately NOT the machine's own local timezone, so
// an overridden profile.timezone actually changes the answer.
function wallClockParts(date, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = {};
  fmt.formatToParts(date).forEach((part) => { if (part.type !== 'literal') parts[part.type] = part.value; });
  return {
    year: Number(parts.year), month: Number(parts.month), day: Number(parts.day),
    hour: parts.hour === '24' ? 0 : Number(parts.hour), // some locales render midnight as "24" rather than "00"
    minute: Number(parts.minute),
  };
}

function pad2(n) { return String(n).padStart(2, '0'); }
function partsToKey(p) { return p.year + '-' + pad2(p.month) + '-' + pad2(p.day); }

// Pure calendar-day arithmetic on already-extracted {year,month,day}
// parts, via Date.UTC. This is NOT the classic "new Date(bareDateKey)"
// trap — that trap comes from parsing a STRING as UTC midnight and
// then reading back LOCAL fields, which disagree by a day west of
// UTC. Here both the construction (Date.UTC) and the read
// (getUTC*) are UTC, so they always agree with each other regardless
// of the machine's own timezone, and month/year rollover (e.g. Jan 1
// minus a day) is handled correctly by the Date object itself.
function shiftDayParts(p, deltaDays) {
  const d = new Date(Date.UTC(p.year, p.month - 1, p.day));
  d.setUTCDate(d.getUTCDate() + deltaDays);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

// The core function. `date` defaults to now; `profile` defaults to
// the saved General Settings (or DEFAULT_PROFILE). Returns "YYYY-MM-DD".
export function effectiveDateKey(date, profile) {
  const p = profile || loadProfile();
  const tz = resolveTimeZone(p);
  const now = date || new Date();
  const parts = wallClockParts(now, tz);

  const [endH, endM] = String(p.dayEndTime || '00:00').split(':').map(Number);
  const beforeDayEnd = parts.hour < endH || (parts.hour === endH && parts.minute < endM);

  const effectiveParts = beforeDayEnd ? shiftDayParts(parts, -1) : parts;
  return partsToKey(effectiveParts);
}

// Convenience for callers that need an actual Date object back (e.g.
// for day-of-week arithmetic) — mirrors gym.html's wtParseKey()
// exactly: local calendar fields, not a timezone-aware reconstruction.
// A "YYYY-MM-DD" key is just a calendar date at this point, and every
// existing caller of the equivalent per-file helpers only ever uses
// it for local day-of-week/date-math, so this intentionally does not
// carry the configured timezone through a second time.
export function parseDateKey(key) {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
}

if (typeof window !== 'undefined') {
  window.DayLib = { DEFAULT_PROFILE, loadProfile, saveProfile, resolveTimeZone, effectiveDateKey, parseDateKey };
}
