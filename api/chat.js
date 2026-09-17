// =============================================================
// Nutrition chat endpoint. Takes a user message + today's context
// (macros/micros from Cronometer, goals, recent food scans) and
// answers using Claude, with cross-conversation memory backed by
// your Supabase project via Anthropic's memory tool.
//
// Requires these env vars in Vercel:
//   ANTHROPIC_API_KEY     from console.anthropic.com -> API Keys
//   DASHBOARD_SECRET      same secret used by the other endpoints
//   SUPABASE_URL          your Supabase project URL
//   SUPABASE_SERVICE_KEY  Supabase "service_role" key (Settings ->
//                         API in your Supabase project) — NOT the
//                         anon/publishable key already used in the
//                         browser. This one must stay server-side
//                         only, it bypasses row-level security.
//
// Requires this table in Supabase (SQL editor):
//   create table ai_memory (
//     path text primary key,
//     content text not null default '',
//     updated_at timestamptz not null default now()
//   );
//
// Call it as: POST /api/chat?secret=YOUR_SECRET
//   body: {
//     "message": "...",
//     "history": [{ "role": "user"|"assistant", "content": "..." }, ...],
//     "todayContext": {
//       "macros": {...}, "micros": {...}, "goals": {...},
//       "recentScans": [{ "description": "...", "nutrients": {...} }]
//     }
//   }
// Returns: { reply, history }  (history = the full updated array,
//   the frontend should store it and send it back on the next call
//   — reset it to [] whenever the day changes, so it never grows
//   across days; memory across days is handled by the memory tool
//   below, not by the conversation history).
// =============================================================

const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-sonnet-5';
const MAX_TOOL_ITERATIONS = 6;
const MEMORY_ROOT = '/memories';

// ---------- propose_training_objectives tool ----------
// Lets Claude propose a concrete weekly training plan after negotiating
// it conversationally (padel days, recovery, time constraints — the
// same back-and-forth the user described having with a coach before),
// instead of the Training page's one-click "Generate" button being the
// only way to set objectives. The input schema mirrors the plan shape
// api/training.js's normalizePlan() produces (Phase 3 of the multi-
// activity-type generalization — cardio is no longer hardcoded to
// running) so the frontend can save it under the identical
// po_coach_weekly_plan_v1 key with no shape mismatch against what the
// Training page's own "Generate" button writes there.
//
// Unlike api/training.js's mode=plan, this endpoint has no injected
// list of the user's configured activity types to choose from (this
// tool works from the conversation, not from structured recent-history
// context) — so the model just names whichever activity the user
// mentions (defaulting to "Running" if cardio comes up with no
// specific activity named) as free text, and topbar.js's save handler
// resolves that name against the user's ACTUAL configured types before
// writing anything (case-insensitive match; no match -> saved without
// a resolved activityTypeId, so labels/targets still display correctly
// but that slot won't tie into progress-tracking against logged
// activities). Deliberately does NOT auto-create a new activity type
// from a casual chat mention the way Phase 2's WHOOP import does from
// an explicit reviewed list — a stronger confirmation step than a
// conversational aside warrants.
const PROPOSE_OBJECTIVES_TOOL = {
  name: 'propose_training_objectives',
  description:
    'Propose a concrete weekly training plan (strength + cardio) for the user to review. This does ' +
    'NOT save anything by itself — the user sees the proposal in the chat and explicitly chooses to save ' +
    'it or not. Only call this once you have gathered enough from the conversation to give specific ' +
    'numbers (padel/other commitments this week, how recovery has been, time available, which cardio ' +
    'activity/activities they want this week if it matters to them) — do not call it on the first message ' +
    'about training if you do not have that context yet; ask first. Equipment reality: the user currently ' +
    'only has a flat/adjustable bench press setup and ONE dumbbell for strength — no barbell, no rack, no ' +
    'second dumbbell, no machines, so every strength suggestion must be doable with just those two things. ' +
    'Cardio should balance VO2 max (interval/tempo work) and building aerobic capacity (a progressively ' +
    'longer session plus easy volume) — standard periodization, not an ad-hoc guess. Each of the three ' +
    'cardio slots names its own activity (e.g. "Running", "Cycling") — use whatever the user actually ' +
    'mentioned for each slot; if they never specify an activity, default all three to "Running".',
  input_schema: {
    type: 'object',
    properties: {
      strength: {
        type: 'object',
        properties: {
          targetSessions: { type: 'integer', description: 'Number of strength sessions this week' },
          focus: { type: 'string', description: 'Short phrase, e.g. "full-body bench + single-dumbbell supersets"' },
        },
        required: ['targetSessions', 'focus'],
      },
      cardio: {
        type: 'object',
        properties: {
          interval: {
            type: 'object',
            properties: {
              activityName: { type: 'string', description: 'Activity for this slot, e.g. "Running", "Cycling" — default "Running" if unspecified' },
              targetSessions: { type: 'integer' },
              targetMinutes: { type: 'integer' },
              description: { type: 'string', description: 'Concrete session, e.g. "6x3min hard w/ 2min easy recovery"' },
            },
            required: ['activityName', 'targetSessions', 'targetMinutes', 'description'],
          },
          longSession: {
            type: 'object',
            properties: {
              activityName: { type: 'string', description: 'Activity for this slot — default "Running" if unspecified' },
              targetAmount: { type: 'number', description: 'Distance/count target in this activity\'s natural unit' },
              unit: { type: 'string', description: 'The unit targetAmount is in, e.g. "km"' },
              description: { type: 'string' },
            },
            required: ['activityName', 'targetAmount', 'unit', 'description'],
          },
          easyVolume: {
            type: 'object',
            properties: {
              activityName: { type: 'string', description: 'Activity for this slot — default "Running" if unspecified' },
              targetAmount: { type: 'number' },
              unit: { type: 'string' },
              description: { type: 'string' },
            },
            required: ['activityName', 'targetAmount', 'unit', 'description'],
          },
        },
        required: ['interval', 'longSession', 'easyVolume'],
      },
      rationale: { type: 'string', description: '1-3 sentences explaining the plan given what the user told you' },
    },
    required: ['strength', 'cardio', 'rationale'],
  },
};

// ---------- propose_calendar_event tool ----------
// Lets the user ask the chat to schedule something on Google Calendar
// conversationally (matching the old-coach-negotiation spirit
// propose_training_objectives already established) instead of only
// ever using the manual "+ Add event" form in main.html's Calendar
// card. Input schema deliberately mirrors that manual form's own raw
// fields (title/date/startTime/endTime/description) rather than
// Google's {dateTime, timeZone} event shape directly — the model has
// no reliable way to know the user's IANA timezone, but the browser
// does (Intl.DateTimeFormat().resolvedOptions().timeZone), so the
// frontend does the exact same date+time -> {dateTime, timeZone}
// conversion here that it already does for the manual form, and both
// paths end up calling api/google-callback.js's ?action=create with
// an identical body shape.
const PROPOSE_CALENDAR_EVENT_TOOL = {
  name: 'propose_calendar_event',
  description:
    'Propose a specific calendar event (title, date, start/end time) for the user to review. This does ' +
    'NOT create anything by itself — the user sees the proposal in the chat and explicitly chooses to ' +
    'create it or not. Only call this once you have a concrete date and start/end time to propose — ask ' +
    'a brief clarifying question first if the request is too vague (e.g. "sometime this week" with ' +
    'nothing else to go on), but do not ask unnecessary questions if there is already enough to work ' +
    'with. ALWAYS check calendar.upcoming in TODAY\'S DATA for conflicts before proposing a time — never ' +
    'propose a time that overlaps an existing event; if the time the user asked for conflicts, say so and ' +
    'propose a nearby free slot instead of silently ignoring the conflict.',
  input_schema: {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'Event title' },
      description: { type: 'string', description: 'Optional short description' },
      date: { type: 'string', description: 'YYYY-MM-DD, resolved from TODAY\'S DATA\'s current date for relative terms like "tomorrow" or "Friday"' },
      startTime: { type: 'string', description: 'HH:MM, 24-hour, local time' },
      endTime: { type: 'string', description: 'HH:MM, 24-hour, local time' },
    },
    required: ['summary', 'date', 'startTime', 'endTime'],
  },
};

// ---------- propose_calendar_event_update tool ----------
// Lets the user ask the chat to move/edit a REAL, already-existing
// calendar event conversationally (e.g. "move my walk to 4pm", "push
// my 5pm call to 6pm") — including events "Plan my day" itself already
// created, since once confirmed those are ordinary real Google Calendar
// events indistinguishable from any other (they show up in
// calendar.upcoming exactly the same way). This is what makes
// "adjust my day plan" work without a separate plan-specific
// mechanism: the model just looks at calendar.upcoming for what's
// already there and proposes whichever move/delete/create calls
// achieve what the user asked for, each its own separate proposal.
//
// Real destructive/modifying calendar access (unlike
// propose_calendar_event, which only ever creates something new) — so
// eventId must be a REAL id copied verbatim from calendar.upcoming,
// never invented, and this tool still only ever proposes; nothing is
// changed until the user taps Update event on the card (see
// topbar.js's renderCalendarEventUpdateCard).
const PROPOSE_CALENDAR_EVENT_UPDATE_TOOL = {
  name: 'propose_calendar_event_update',
  description:
    'Propose moving and/or renaming an EXISTING real calendar event (e.g. "move my walk to 4pm", "push my ' +
    '5pm call to 6pm", "rename my 3pm block to Errand") for the user to review. This does NOT change ' +
    'anything by itself — the user sees a before/after card in the chat and explicitly chooses to apply it ' +
    'or not. eventId MUST be copied verbatim from the "id" field of an entry in calendar.upcoming in ' +
    'TODAY\'S DATA — NEVER invent or guess an id. If the user describes an event you cannot find in ' +
    'calendar.upcoming (wrong day, too far out, or just not there), say so and ask them to clarify rather ' +
    'than guessing which one they mean. Always include that same event\'s CURRENT summary/date/start/end as ' +
    'originalSummary/originalDate/originalStartTime/originalEndTime (copied from calendar.upcoming, so the ' +
    'user sees an accurate before/after) — then include ONLY whichever of summary/date/startTime/endTime is ' +
    'actually changing; omit any that stay the same. Only call this once you have a concrete new time/date/ ' +
    'title — ask a brief clarifying question first if the request is vague (e.g. "move it later" with no ' +
    'specific time).',
  input_schema: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The real event id, copied verbatim from calendar.upcoming — never invented' },
      originalSummary: { type: 'string', description: 'The event\'s CURRENT title, from calendar.upcoming' },
      originalDate: { type: 'string', description: 'YYYY-MM-DD, the event\'s CURRENT date, from calendar.upcoming' },
      originalStartTime: { type: 'string', description: 'HH:MM, the event\'s CURRENT start time, from calendar.upcoming' },
      originalEndTime: { type: 'string', description: 'HH:MM, the event\'s CURRENT end time, from calendar.upcoming' },
      summary: { type: 'string', description: 'New title — only include if it is actually changing' },
      date: { type: 'string', description: 'New date YYYY-MM-DD — only include if it is actually changing' },
      startTime: { type: 'string', description: 'New start time HH:MM — only include if it is actually changing' },
      endTime: { type: 'string', description: 'New end time HH:MM — only include if it is actually changing' },
    },
    required: ['eventId', 'originalSummary', 'originalDate', 'originalStartTime', 'originalEndTime'],
  },
};

// ---------- propose_calendar_event_delete tool ----------
// Lets the user ask the chat to cancel a REAL, already-existing
// calendar event conversationally (e.g. "cancel my 5pm call", "delete
// the errand block") — same "real events are just real events" logic
// as the update tool above applies here too (a Plan-my-day-created
// event is deleted exactly the same way as any other). This is the
// single most irreversible tool in this file, so it gets its own
// visually distinct danger-styled confirm button client-side
// (topbar.js's renderCalendarEventDeleteCard) on top of the same
// explicit-confirmation requirement every other propose_* tool has.
const PROPOSE_CALENDAR_EVENT_DELETE_TOOL = {
  name: 'propose_calendar_event_delete',
  description:
    'Propose deleting an EXISTING real calendar event (e.g. "cancel my 5pm call", "delete the errand ' +
    'block") for the user to review. This does NOT delete anything by itself — the user sees the event in ' +
    'a card and explicitly chooses to delete it or not; there is no undo once they do. eventId MUST be ' +
    'copied verbatim from the "id" field of an entry in calendar.upcoming in TODAY\'S DATA — NEVER invent ' +
    'or guess an id. If the user describes an event you cannot find in calendar.upcoming, say so and ask ' +
    'them to clarify rather than guessing which one they mean. Copy summary/date/start/end straight from ' +
    'that same calendar.upcoming entry for display in the confirmation card.',
  input_schema: {
    type: 'object',
    properties: {
      eventId: { type: 'string', description: 'The real event id, copied verbatim from calendar.upcoming — never invented' },
      summary: { type: 'string', description: 'The event\'s current title, from calendar.upcoming, for display' },
      date: { type: 'string', description: 'YYYY-MM-DD, the event\'s current date, from calendar.upcoming, for display' },
      startTime: { type: 'string', description: 'HH:MM, the event\'s current start time, from calendar.upcoming, for display' },
      endTime: { type: 'string', description: 'HH:MM, the event\'s current end time, from calendar.upcoming, for display' },
    },
    required: ['eventId', 'summary', 'date', 'startTime', 'endTime'],
  },
};

// ---------- propose_restriction tool ----------
// Lets the user tell the chat about a temporary training constraint
// ("no running this week", "no padel — knee recovery") ONCE and have
// it apply everywhere instead of repeating it to each feature: saved
// restrictions are fetched and respected by all three training AI
// surfaces (api/training.js's mode=plan and mode=today, plus
// main.html's Plan my day) via the shared active_restrictions table
// (see api/sync-state.js's resource=restrictions). This endpoint only
// proposes — same explicit-confirmation pattern as
// propose_training_objectives/propose_calendar_event, nothing is
// saved until the user taps Save on the card.
const PROPOSE_RESTRICTION_TOOL = {
  name: 'propose_restriction',
  description:
    'Propose a temporary training restriction (e.g. "no running this week", "no padel — recovering from a ' +
    'knee thing") for the user to review. This does NOT save anything by itself — the user sees the ' +
    'proposal in the chat and explicitly chooses to save it or not. Once saved, this week\'s objectives, ' +
    'Today\'s session, and Plan my day will all respect it automatically until it expires or the user ends ' +
    'it early — they do not need to repeat it to each feature separately. Ask clarifying questions first if ' +
    'the request is vague about WHAT is restricted or for HOW LONG (e.g. "no running" — for how many days? ' +
    'just this week? until they say otherwise?) — never guess a duration or scope. Resolve relative dates ' +
    '("this week", "a few days") against TODAY\'S DATA\'s own "date" field, never guess today\'s date.',
  input_schema: {
    type: 'object',
    properties: {
      text: { type: 'string', description: 'Short human-readable summary, e.g. "No running this week" or "No padel — knee recovery"' },
      scope: { type: 'string', description: 'One of: running, strength, padel — only when the restriction clearly maps to one of these. Omit entirely for anything else (a general/other restriction) rather than forcing a bad fit.' },
      starts_on: { type: 'string', description: 'YYYY-MM-DD, usually today' },
      ends_on: { type: 'string', description: 'YYYY-MM-DD, inclusive — the last day the restriction still applies' },
    },
    required: ['text', 'starts_on', 'ends_on'],
  },
};

// ---------- propose_today_session tool ----------
// Lets the user directly override what Training's "Today's session"
// card currently recommends — e.g. "today I want to run 10km instead,
// I have great recovery" — without that request being misread as a
// calendar-scheduling ask (propose_calendar_event) or a weekly-
// objectives change (propose_training_objectives). On confirm, this
// overwrites the exact same localStorage cache
// (po_coach_today_recommendation_v1) gym.html's Training page reads
// from — the same "generate once, cache until tapped" entry Phase 1's
// caching fix introduced — so the card updates without the user
// needing to tap Regenerate, and topbar.js's save handler also
// updates the live DOM directly in case Training is the page
// currently open.
const PROPOSE_TODAY_SESSION_TOOL = {
  name: 'propose_today_session',
  description:
    'Propose a replacement for TODAY\'S specific Training recommendation (the "Today\'s session" card) — ' +
    'e.g. the user says "today I want to run 10km instead", "put Push + 5K in today\'s session", "my knee ' +
    'feels fine now, change today\'s pick to Legs". This is DIFFERENT from propose_calendar_event (which ' +
    'creates a new timed calendar event) and propose_training_objectives (which sets this WEEK\'s targets, ' +
    'not a specific day\'s pick) — use this one specifically when the user wants to change what Training ' +
    'itself currently shows as today\'s recommended session. This does NOT overwrite anything by itself — ' +
    'the user sees the proposal in the chat and explicitly chooses to replace it or not.',
  input_schema: {
    type: 'object',
    properties: {
      recommendation: { type: 'string', description: 'Short label, same style Training itself uses, e.g. "10K run", "Push + 5K run", "Rest" — never a paragraph or a list of exercises' },
      sub: { type: 'string', description: 'Optional short context line shown under the recommendation, e.g. "User-requested — great recovery today"' },
    },
    required: ['recommendation'],
  },
};

// ---------- propose_long_term_plan tool ----------
// The Plan feature (plan.html, Phase 1) — lets the user negotiate a
// multi-week goal the way they used to with an AI coach (e.g. "quiero
// subir 3kg en 6 semanas") instead of only ever creating one by hand.
// DIFFERENT from propose_training_objectives above: that sets THIS
// week's specific sessions; this sets a goal that spans several weeks
// and is tracked against real logged data over time (plan.html's own
// progress engine — po_coach_weights/po_coach_v1/po_coach_activities),
// same distinction propose_today_session already has to draw against
// propose_training_objectives for the same reason (multiple training-
// adjacent tools that are easy to conflate).
//
// startDate/weeklyCheckpoints[].weekStartDate are NOT in this schema
// at all — deliberately, same reasoning api/training.js's mode=day-plan
// already established for wakeUpTime (see that file's own comment):
// exact date arithmetic is a poor fit for an LLM to get reliably
// right and a real, previously-hit bug class in this project (a
// "Wake up" event landing at 1:30pm from bad date math), whereas
// picking a sensible NUMBER of weeks and a realistic per-week
// progression is exactly the kind of judgment call worth a model
// call. The model only produces durationWeeks (an integer) and
// weeklyTargets (its own chosen progression, not necessarily linear);
// normalizeProposedLongTermPlan() below computes every real
// weekStartDate/endDate from those with plain deterministic date math,
// anchored at TODAY'S DATA's own "date" — never guessed, never asked
// of the model.
//
// exerciseName/activityName mirror PROPOSE_OBJECTIVES_TOOL's own
// activityName field exactly (free text resolved against the user's
// REAL configured exercises/activity types client-side on save, by
// topbar.js's renderLongTermPlanCard — see that function's own
// comment) — this endpoint has no access to either configured list at
// tool-definition time, same reasoning as PROPOSE_OBJECTIVES_TOOL's
// own header comment.
//
// adjustsPlanId (Phase 3): also reused for a WEEKLY REVIEW's proposed
// adjustment to the user's EXISTING active plan (TODAY'S DATA's own
// plan.active), not just for a brand new goal — set this to
// plan.active.id, copied verbatim, when the user wants to adjust
// future checkpoints rather than start something new. durationWeeks/
// weeklyTargets in that case describe ONLY the remaining weeks from
// today forward (not the whole plan from its original start) —
// topbar.js's save handler keeps every already-elapsed checkpoint
// untouched (a real historical hit/miss record, never rewritten) and
// splices these new ones in after it, renumbered to continue that
// same sequence. Omit entirely for a brand new plan.
const PROPOSE_LONG_TERM_PLAN_TOOL = {
  name: 'propose_long_term_plan',
  description:
    'Propose a multi-week goal (Plan feature) for the user to review — e.g. "quiero subir 3kg en 6 semanas" ' +
    '(gain 3kg in 6 weeks), "get my bench to 80kg by next month", "build up to running 20km a week" — OR, ' +
    'with adjustsPlanId set, propose adjusted future checkpoints for the user\'s EXISTING active plan during a ' +
    'weekly review (see LONG-TERM PLAN REVIEW in your instructions). This is DIFFERENT from ' +
    'propose_training_objectives (which sets only THIS week\'s specific sessions) — use this one for a goal ' +
    'spanning several weeks that should be tracked against real logged data over time, not a single week\'s ' +
    'plan. This does NOT save anything by itself — the user sees the proposal in the chat and explicitly ' +
    'chooses to save it or not. For a NEW plan (adjustsPlanId omitted): ask clarifying questions first if the ' +
    'goal, target number, or timeframe aren\'t clear enough to give concrete numbers — never guess a target ' +
    'value or duration. Ground startValue in TODAY\'S DATA where possible: for weight_gain/weight_loss use ' +
    'gym.latestBodyWeight (its own "weight"/"unit" fields); for running_distance check activities.byType for ' +
    'the matching activity\'s totalDistanceKm/recent entries; for strength_pr, TODAY\'S DATA has no historical ' +
    'best-lift data at all, so ask the user directly for their current number on that exercise unless they ' +
    'already stated it in the conversation. weeklyTargets is YOUR judgment call on a realistic progression ' +
    'toward targetValue — a straight linear ramp is a fine default, but a smarter curve is fine too where more ' +
    'realistic (e.g. weight change rarely happens in perfectly equal weekly increments). IMPORTANT: before ' +
    'proposing a brand new plan, check TODAY\'S DATA\'s plan.active first — if one already exists, do not ' +
    'silently create a second one (only one shows on the Plan page); see LONG-TERM PLAN in your instructions ' +
    'for what to do instead.',
  input_schema: {
    type: 'object',
    properties: {
      adjustsPlanId: { type: 'string', description: 'Set ONLY when adjusting the existing active plan during a review — copy plan.active.id verbatim from TODAY\'S DATA. Omit for a brand new plan.' },
      goalDescription: { type: 'string', description: 'Short human-readable summary, e.g. "Gain 3kg in 6 weeks"' },
      goalType: { type: 'string', enum: ['weight_gain', 'weight_loss', 'strength_pr', 'running_distance', 'other'] },
      targetValue: { type: 'number', description: 'The final target value to reach by the end of the plan' },
      startValue: { type: 'number', description: 'Current/baseline value right now — see this tool\'s own description on where to ground this per goalType. When adjustsPlanId is set, copy the existing plan.active.startValue unchanged (the original baseline never moves).' },
      targetUnit: { type: 'string', description: 'e.g. "kg", "lb", "km", "mi", or "reps" for a bodyweight strength exercise' },
      exerciseName: { type: 'string', description: 'strength_pr ONLY: the exercise name as the user said it, e.g. "Bench Press" — omit for every other goalType' },
      activityName: { type: 'string', description: 'running_distance ONLY: the activity name, e.g. "Running", "Cycling" — omit for every other goalType' },
      durationWeeks: { type: 'integer', description: 'How many weeks from TODAY this covers. For a new plan, the whole plan\'s length. For an adjustment (adjustsPlanId set), only the REMAINING weeks from today forward — never the original plan\'s full length.' },
      weeklyTargets: {
        type: 'array', items: { type: 'number' },
        description: 'Exactly durationWeeks numbers, one per week in order starting from THIS week — the target value to have reached by the END of each week',
      },
      rationale: { type: 'string', description: '1-3 sentences explaining the plan (or, for an adjustment, explaining the change) given what the user told you and their real current stats/progress' },
    },
    required: ['goalDescription', 'goalType', 'targetValue', 'startValue', 'targetUnit', 'durationWeeks', 'weeklyTargets', 'rationale'],
  },
};

// ---------- propose_plan_status_change tool ----------
// Lets the chat end the user's EXISTING active plan (Plan feature) —
// e.g. they want to abandon it, they've finished it early, or they
// want to start a genuinely different goal and first need to retire
// the current one (see LONG-TERM PLAN's own instructions below on
// when to reach for this before proposing a brand new plan.html
// entry). id must be copied verbatim from TODAY'S DATA's own
// plan.active.id — never invented, and never used on any plan not
// currently active (there's nothing else to safely target: past
// plans are already ended, and this endpoint has no way to look one
// up by any other identifier). Posts straight to api/sync-state.js's
// EXISTING resource=plans action="update" (Phase 1) — no server
// changes needed there at all, same reasoning propose_restriction
// already established for reusing that action dispatch as-is.
const PROPOSE_PLAN_STATUS_CHANGE_TOOL = {
  name: 'propose_plan_status_change',
  description:
    'Propose ending the user\'s EXISTING active long-term plan (Plan feature) — marking it completed or ' +
    'abandoned. This does NOT change anything by itself — the user sees the proposal in the chat and ' +
    'explicitly chooses to confirm it or not. id MUST be copied verbatim from TODAY\'S DATA\'s plan.active.id ' +
    '— never invent one, and never call this when TODAY\'S DATA has no plan.active at all (there is nothing ' +
    'to end).',
  input_schema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'plan.active.id from TODAY\'S DATA, copied verbatim' },
      status: { type: 'string', enum: ['completed', 'abandoned'], description: '"completed" if the goal was actually reached/finished, "abandoned" if the user is just stopping it' },
      goalDescription: { type: 'string', description: 'plan.active.goalDescription from TODAY\'S DATA, copied verbatim — shown on the confirmation card so the user can see exactly which plan this affects' },
    },
    required: ['id', 'status', 'goalDescription'],
  },
  // Last tool in the tools array -> caches every tool definition up to
  // and including this one (see the prompt-caching note in the handler
  // below). Tool definitions never change between requests, so this is
  // a pure win with no behavior difference.
  cache_control: { type: 'ephemeral' },
};

// Same defensive normalization api/training.js's normalizePlan() applies
// to Claude's other training-plan output — duplicated rather than
// imported (this repo's established pattern for small per-file config,
// see e.g. the NUTRIENTS list shared between api/food-scan.js and
// health.html), since these are separate serverless functions with no
// shared-module setup. Guarantees the frontend always gets the exact
// shape it expects regardless of how closely the model followed the
// input_schema.
function numOr(v, fallback) {
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}
// activityTypeId is intentionally absent here — this endpoint has no
// access to the user's configured activity types (see the tool's own
// header comment), so it can only carry the free-text activityName the
// model produced. topbar.js's save handler resolves that name against
// the real configured list before writing po_coach_weekly_plan_v1.
function normalizeCardioSlot(raw, defaultAmountField, defaultAmount) {
  const s = raw || {};
  const out = {
    activityName: typeof s.activityName === 'string' && s.activityName.trim() ? s.activityName.trim().slice(0, 60) : 'Running',
    description: typeof s.description === 'string' ? s.description.slice(0, 300) : '',
  };
  if (defaultAmountField === 'sessions') {
    out.targetSessions = Math.max(0, Math.round(numOr(s.targetSessions, 1)));
    out.targetMinutes = Math.max(0, Math.round(numOr(s.targetMinutes, 25)));
  } else {
    out.targetAmount = Math.max(0, numOr(s.targetAmount, defaultAmount));
    out.unit = typeof s.unit === 'string' && s.unit.trim() ? s.unit.trim().slice(0, 20) : 'km';
  }
  return out;
}
function normalizeProposedPlan(raw) {
  const r = raw || {};
  const strength = r.strength || {};
  const cardio = r.cardio || {};
  return {
    strength: {
      targetSessions: Math.max(1, Math.round(numOr(strength.targetSessions, 3))),
      focus: typeof strength.focus === 'string' ? strength.focus.slice(0, 200) : '',
    },
    cardio: {
      interval: normalizeCardioSlot(cardio.interval, 'sessions'),
      longSession: normalizeCardioSlot(cardio.longSession, 'amount', 8),
      easyVolume: normalizeCardioSlot(cardio.easyVolume, 'amount', 10),
    },
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

// Defensive normalization for propose_calendar_event, same spirit as
// normalizeProposedPlan above — guarantees the frontend always gets
// the exact {summary, description, date, startTime, endTime} shape it
// expects (matching main.html's manual "+ Add event" form fields
// exactly) regardless of how closely the model followed the schema.
function normalizeProposedEvent(raw) {
  const r = raw || {};
  return {
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 200) : '',
    description: typeof r.description === 'string' ? r.description.slice(0, 1000) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 10) : '',
    startTime: typeof r.startTime === 'string' ? r.startTime.slice(0, 5) : '',
    endTime: typeof r.endTime === 'string' ? r.endTime.slice(0, 5) : '',
  };
}

// Defensive normalization for propose_calendar_event_update — eventId
// has NO fallback (unlike every string field elsewhere in this file,
// which default to '' on a bad model response): an update with no
// target id is meaningless and must never reach the client looking
// like a valid proposal, so the handler below checks for an empty
// eventId and drops the proposal entirely rather than showing a card
// that can't actually apply to anything.
function normalizeProposedEventUpdate(raw) {
  const r = raw || {};
  return {
    eventId: typeof r.eventId === 'string' ? r.eventId.slice(0, 500) : '',
    originalSummary: typeof r.originalSummary === 'string' ? r.originalSummary.slice(0, 200) : '',
    originalDate: typeof r.originalDate === 'string' ? r.originalDate.slice(0, 10) : '',
    originalStartTime: typeof r.originalStartTime === 'string' ? r.originalStartTime.slice(0, 5) : '',
    originalEndTime: typeof r.originalEndTime === 'string' ? r.originalEndTime.slice(0, 5) : '',
    // These four are only ever populated by the model when actually
    // changing — '' here (not falling back to the original) so the
    // client can tell "unchanged" apart from "explicitly set to the
    // same value" and only sends the fields that actually changed.
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 200) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 10) : '',
    startTime: typeof r.startTime === 'string' ? r.startTime.slice(0, 5) : '',
    endTime: typeof r.endTime === 'string' ? r.endTime.slice(0, 5) : '',
  };
}

// Defensive normalization for propose_calendar_event_delete — same
// no-fallback treatment for eventId as the update tool above, for the
// same reason (a deletion with no target id must never reach the
// client as an apparently-valid card).
function normalizeProposedEventDelete(raw) {
  const r = raw || {};
  return {
    eventId: typeof r.eventId === 'string' ? r.eventId.slice(0, 500) : '',
    summary: typeof r.summary === 'string' ? r.summary.slice(0, 200) : '',
    date: typeof r.date === 'string' ? r.date.slice(0, 10) : '',
    startTime: typeof r.startTime === 'string' ? r.startTime.slice(0, 5) : '',
    endTime: typeof r.endTime === 'string' ? r.endTime.slice(0, 5) : '',
  };
}

// Defensive normalization for propose_restriction, same spirit as the
// two above — guarantees the frontend always gets the exact
// {text, scope, starts_on, ends_on} shape api/sync-state.js's
// resource=restrictions POST (action:"create") expects.
function normalizeProposedRestriction(raw) {
  const r = raw || {};
  const scope = typeof r.scope === 'string' ? r.scope.trim().toLowerCase().slice(0, 50) : '';
  return {
    text: typeof r.text === 'string' ? r.text.slice(0, 300) : '',
    scope: scope || null,
    starts_on: typeof r.starts_on === 'string' ? r.starts_on.slice(0, 10) : '',
    ends_on: typeof r.ends_on === 'string' ? r.ends_on.slice(0, 10) : '',
  };
}

// Defensive normalization for propose_today_session, same spirit as
// the three above — guarantees the frontend always gets the exact
// {recommendation, sub} shape topbar.js's save handler expects when
// writing gym.html's po_coach_today_recommendation_v1 cache entry.
function normalizeProposedTodaySession(raw) {
  const r = raw || {};
  return {
    recommendation: typeof r.recommendation === 'string' ? r.recommendation.slice(0, 200) : '',
    sub: typeof r.sub === 'string' ? r.sub.slice(0, 200) : '',
  };
}

const LONG_TERM_PLAN_GOAL_TYPES = ['weight_gain', 'weight_loss', 'strength_pr', 'running_distance', 'other'];
// Plain deterministic date-key arithmetic, UTC-anchored so a day never
// silently shifts from a local-timezone DST edge (this endpoint has no
// concept of the user's timezone anyway — todayDateKey below is
// already a plain YYYY-MM-DD the client computed correctly once).
// Small local copy rather than importing a shared helper — this
// project's established per-file convention (see e.g. api/training.js's
// own subtractMinutesFromTime), and this is the only file in api/ that
// needs date-key, not time-of-day, arithmetic.
function addDaysToDateKey(dateKeyStr, n) {
  const [y, m, d] = dateKeyStr.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  return dt.toISOString().slice(0, 10);
}
// Defensive normalization for propose_long_term_plan (Plan feature,
// plan.html Phase 1) — guarantees the frontend always gets EXACTLY the
// shape api/sync-state.js's resource=plans action="create" expects
// (see that file's own header comment), computed here rather than
// trusting the model with real date arithmetic (see
// PROPOSE_LONG_TERM_PLAN_TOOL's own header comment on why). Reuses
// Phase 1's schema field-for-field — startValue and
// exerciseName/activityName (the latter two resolved into
// goalExerciseName/goalActivityTypeId client-side by topbar.js's
// renderLongTermPlanCard, same free-text-then-resolve pattern
// normalizeCardioSlot's activityName already established) — so a plan
// saved from here renders on plan.html with zero changes needed there.
function normalizeProposedLongTermPlan(raw, todayDateKey) {
  const r = raw || {};
  const goalType = LONG_TERM_PLAN_GOAL_TYPES.includes(r.goalType) ? r.goalType : 'other';
  const startDate = (typeof todayDateKey === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(todayDateKey))
    ? todayDateKey
    : new Date().toISOString().slice(0, 10); // only if todayContext.date was somehow missing — see this fn's own comment
  const durationWeeks = Math.max(1, Math.min(52, Math.round(numOr(r.durationWeeks, 6))));
  const targetValue = numOr(r.targetValue, 0);
  const startValue = numOr(r.startValue, 0);
  const rawTargets = Array.isArray(r.weeklyTargets) ? r.weeklyTargets : [];
  // Guarantee exactly durationWeeks checkpoints even if the model's
  // array came back a different length or with a gap — pad any
  // missing entry with a linear interpolation toward targetValue
  // rather than dropping the whole proposal, matching this file's
  // established "always hand the frontend a renderable shape"
  // convention (see normalizeCardioSlot's own defaults).
  const weeklyCheckpoints = [];
  for (let i = 0; i < durationWeeks; i++) {
    const linearFallback = startValue + (targetValue - startValue) * ((i + 1) / durationWeeks);
    const val = numOr(rawTargets[i], linearFallback);
    weeklyCheckpoints.push({
      weekNumber: i + 1,
      weekStartDate: addDaysToDateKey(startDate, i * 7),
      targetValue: Math.round(val * 100) / 100,
    });
  }
  return {
    // '' (not null) when absent, same as exerciseName/activityName
    // below — topbar.js's renderLongTermPlanCard treats a falsy
    // adjustsPlanId as "this is a brand new plan".
    adjustsPlanId: typeof r.adjustsPlanId === 'string' ? r.adjustsPlanId.trim().slice(0, 100) : '',
    goalDescription: typeof r.goalDescription === 'string' ? r.goalDescription.slice(0, 300) : '',
    goalType,
    targetValue,
    startValue,
    targetUnit: typeof r.targetUnit === 'string' && r.targetUnit.trim() ? r.targetUnit.trim().slice(0, 20) : 'kg',
    // Free text, NOT yet resolved to a real id/name — see this
    // function's own header comment. '' (not null) when absent so the
    // client can treat "no exercise/activity mentioned" uniformly with
    // every other optional string field in this file.
    exerciseName: typeof r.exerciseName === 'string' ? r.exerciseName.trim().slice(0, 100) : '',
    activityName: typeof r.activityName === 'string' ? r.activityName.trim().slice(0, 100) : '',
    startDate,
    endDate: addDaysToDateKey(startDate, durationWeeks * 7 - 1),
    weeklyCheckpoints,
    rationale: typeof r.rationale === 'string' ? r.rationale.slice(0, 600) : '',
  };
}

// Defensive normalization for propose_plan_status_change — id has NO
// fallback (same treatment as propose_calendar_event_update/delete's
// own eventId above): an update with no real target id is meaningless
// and must never reach the client looking like a valid proposal.
function normalizeProposedPlanStatusChange(raw) {
  const r = raw || {};
  const status = (r.status === 'completed' || r.status === 'abandoned') ? r.status : '';
  return {
    id: typeof r.id === 'string' ? r.id.trim().slice(0, 100) : '',
    status,
    goalDescription: typeof r.goalDescription === 'string' ? r.goalDescription.slice(0, 300) : '',
  };
}

// ---------- Supabase-backed memory store ----------

function supabaseHeaders() {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return {
    apikey: key,
    Authorization: `Bearer ${key}`,
    'Content-Type': 'application/json',
  };
}

function supabaseUrl(path) {
  return `${process.env.SUPABASE_URL}/rest/v1/${path}`;
}

async function dbGet(path) {
  const res = await fetch(supabaseUrl(`ai_memory?path=eq.${encodeURIComponent(path)}&select=path,content,updated_at`), {
    headers: supabaseHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) && rows[0] ? rows[0] : null;
}

async function dbListByPrefix(prefix) {
  const like = encodeURIComponent(prefix.endsWith('/') ? prefix + '%' : prefix + '/%');
  const res = await fetch(supabaseUrl(`ai_memory?path=like.${like}&select=path,content`), {
    headers: supabaseHeaders(),
  });
  const rows = await res.json();
  return Array.isArray(rows) ? rows : [];
}

async function dbUpsert(path, content) {
  await fetch(supabaseUrl('ai_memory?on_conflict=path'), {
    method: 'POST',
    headers: { ...supabaseHeaders(), Prefer: 'resolution=merge-duplicates' },
    body: JSON.stringify([{ path, content, updated_at: new Date().toISOString() }]),
  });
}

async function dbDelete(pathOrPrefix, recursive) {
  const filter = recursive
    ? `path=like.${encodeURIComponent(pathOrPrefix + '%')}`
    : `path=eq.${encodeURIComponent(pathOrPrefix)}`;
  await fetch(supabaseUrl(`ai_memory?${filter}`), { method: 'DELETE', headers: supabaseHeaders() });
}

// ---------- Path safety ----------

function normalizePath(p) {
  if (typeof p !== 'string' || !p.startsWith(MEMORY_ROOT)) return null;
  if (p.includes('..') || p.includes('%2e%2e')) return null;
  return p.replace(/\/+/g, '/').replace(/\/$/, '') || MEMORY_ROOT;
}

function humanSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'K';
  return (bytes / (1024 * 1024)).toFixed(1) + 'M';
}

// ---------- Memory tool command handlers ----------

async function handleMemoryCommand(input) {
  const { command } = input;

  if (command === 'view') {
    const path = normalizePath(input.path);
    if (!path) return { content: `The path ${input.path} does not exist. Please provide a valid path.`, is_error: true };

    if (path === MEMORY_ROOT || (await dbListByPrefix(path)).length > 0) {
      // Treat as directory: list children.
      const rows = await dbListByPrefix(path === MEMORY_ROOT ? '' : path);
      const fileRow = await dbGet(path);
      if (!fileRow && rows.length === 0 && path !== MEMORY_ROOT) {
        return { content: `The path ${path} does not exist. Please provide a valid path.`, is_error: true };
      }
      const lines = [`Here're the files and directories up to 2 levels deep in ${path}, excluding hidden items and node_modules:`];
      lines.push(`${humanSize(0)}\t${path}`);
      const seen = new Set();
      for (const row of rows) {
        const rel = row.path.slice(path.length === MEMORY_ROOT.length ? MEMORY_ROOT.length : path.length).replace(/^\//, '');
        const first = rel.split('/')[0];
        if (!first || seen.has(first)) continue;
        seen.add(first);
        lines.push(`${humanSize(row.content ? row.content.length : 0)}\t${path}/${first}`);
      }
      return { content: lines.join('\n') };
    }

    const row = await dbGet(path);
    if (!row) return { content: `The path ${path} does not exist. Please provide a valid path.`, is_error: true };
    let text = row.content || '';
    let lines = text.split('\n');
    if (Array.isArray(input.view_range)) {
      const [startLine, endLine] = input.view_range;
      const end = endLine === -1 ? lines.length : endLine;
      lines = lines.slice(Math.max(0, startLine - 1), end);
      var offset = startLine;
    } else {
      var offset = 1;
    }
    const numbered = lines.map((l, i) => `${String(i + offset).padStart(6, ' ')}\t${l}`).join('\n');
    return { content: `Here's the content of ${path} with line numbers:\n${numbered}` };
  }

  if (command === 'create') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    await dbUpsert(path, input.file_text || '');
    return { content: `File created successfully at: ${path}` };
  }

  if (command === 'str_replace') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    const row = await dbGet(path);
    if (!row) return { content: `Error: The path ${path} does not exist. Please provide a valid path.`, is_error: true };
    const occurrences = row.content.split(input.old_str).length - 1;
    if (occurrences === 0) {
      return { content: `No replacement was performed, old_str \`${input.old_str}\` did not appear verbatim in ${path}.`, is_error: true };
    }
    if (occurrences > 1) {
      return { content: `No replacement was performed. Multiple occurrences of old_str \`${input.old_str}\` found in ${path}. Please ensure it is unique`, is_error: true };
    }
    const newContent = row.content.replace(input.old_str, input.new_str || '');
    await dbUpsert(path, newContent);
    const snippet = newContent.split('\n').slice(0, 20).map((l, i) => `${String(i + 1).padStart(6, ' ')}\t${l}`).join('\n');
    return { content: `The memory file has been edited.\n${snippet}` };
  }

  if (command === 'insert') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    const row = await dbGet(path);
    if (!row) return { content: `Error: The path ${path} does not exist`, is_error: true };
    const lines = row.content.split('\n');
    const insertLine = input.insert_line;
    if (insertLine < 0 || insertLine > lines.length) {
      return { content: `Error: Invalid insert_line parameter: ${insertLine}. It should be within the range of lines of the file: [0, ${lines.length}]`, is_error: true };
    }
    lines.splice(insertLine, 0, (input.insert_text || '').replace(/\n$/, ''));
    await dbUpsert(path, lines.join('\n'));
    return { content: `The file ${path} has been edited.` };
  }

  if (command === 'delete') {
    const path = normalizePath(input.path);
    if (!path) return { content: `Invalid path: ${input.path}`, is_error: true };
    if (path === MEMORY_ROOT) return { content: `Error: cannot delete the memory root directory`, is_error: true };
    const row = await dbGet(path);
    const children = await dbListByPrefix(path);
    if (!row && children.length === 0) return { content: `Error: The path ${path} does not exist`, is_error: true };
    await dbDelete(path, true);
    if (row) await dbDelete(path, false);
    return { content: `Successfully deleted ${path}` };
  }

  if (command === 'rename') {
    const oldPath = normalizePath(input.old_path);
    const newPath = normalizePath(input.new_path);
    if (!oldPath || !newPath) return { content: `Invalid path`, is_error: true };
    if (oldPath === MEMORY_ROOT) return { content: `Error: cannot rename the memory root directory`, is_error: true };
    const row = await dbGet(oldPath);
    if (!row) return { content: `Error: The path ${oldPath} does not exist`, is_error: true };
    const existing = await dbGet(newPath);
    if (existing) return { content: `Error: The destination ${newPath} already exists`, is_error: true };
    await dbUpsert(newPath, row.content);
    await dbDelete(oldPath, false);
    return { content: `Successfully renamed ${oldPath} to ${newPath}` };
  }

  return { content: `Unknown memory command: ${command}`, is_error: true };
}

// ---------- System prompt ----------

// Split into a STATIC part (identical on every call, regardless of
// todayContext) and a DYNAMIC part (today's actual numbers) so the
// request can cache_control the static part separately — see the
// "system" array built in the handler below. Order matters for
// caching: cacheable content must come first in the prefix, so the
// static instructions are block 1 and todayContext is block 2, not
// interleaved the way the single-string version used to read.
function buildStaticSystemPrompt() {
  return (
    'You are a nutrition and health assistant embedded in the user\'s personal dashboard (Row). ' +
    'Give practical, specific advice based on the data provided below (after these instructions). ' +
    'Keep answers concise and actionable. You are not a doctor; for medical concerns, suggest they ' +
    'consult a professional.\n\n' +
    'DATA FRESHNESS: nutrition (Cronometer) and whoop in TODAY\'S DATA can both be STALE — each source ' +
    'only has whatever it last actually synced, and if the user hasn\'t synced/worn the device today that ' +
    'can silently be several days old. nutrition.daysStale and whoop.daysStale tell you exactly how old ' +
    '(0 = genuinely today\'s data, 1 = yesterday\'s, etc.; null means no data at all — never treat null as ' +
    '0). NEVER refer to stale data as "today\'s" meals, recovery, or sleep without saying so — if ' +
    'daysStale is 1 or more, explicitly flag it (e.g. "your last synced nutrition data is from 3 days ago, ' +
    'so I can\'t see today\'s actual meals — want me to use that anyway, or should you sync first?") ' +
    'instead of silently presenting it as current. This matters most when the question assumes freshness ' +
    '("what did I eat today", "how\'s my recovery this morning") — for a question that doesn\'t hinge on ' +
    'it being today specifically, a brief note of the actual date it\'s from is enough.\n\n' +
    'QUESTIONS ABOUT A DIFFERENT DAY: when the user asks about a date other than today (a future day like ' +
    '"should I run 21km Wednesday", or a past one), do NOT lead your answer with today\'s specific WHOOP ' +
    'recovery/HRV/sleep/strain numbers as if they predict or describe that other day — a future day\'s ' +
    'recovery is fundamentally unknowable in advance, and presenting today\'s numbers first reads as if ' +
    'they answer the question when they don\'t. Structure the answer around what actually IS knowable in ' +
    'advance instead: training history and volume progression (activities.byType — longest/total distance ' +
    'and recent sessions for the relevant activity, gym.recentWorkouts for strength), general risk factors ' +
    '(e.g. jumping in distance too fast relative to recent volume), and how the plan should adapt based on ' +
    'how they feel closer to that day. If today\'s WHOOP/recovery trend is genuinely useful context (e.g. a ' +
    'multi-day pattern of low recovery suggesting they should build in a decision point before committing), ' +
    'mention it explicitly as CURRENT baseline/trend context — never as if it tells you how Wednesday itself ' +
    'will go. This is separate from the DATA FRESHNESS point above: that one is about whether today\'s data ' +
    'is actually from today; this one is about not applying today\'s data to a DIFFERENT day at all.\n\n' +
    'MEMORY TOOL — use it sparingly, not as a routine first step. Only VIEW/check memory when the ' +
    'conversation itself gives you a reason to — the user references something from a past ' +
    'conversation, asks whether you remember something, or you are about to give advice that would ' +
    'genuinely benefit from a preference they may have told you before. Do not open or list memory ' +
    'on ordinary questions just to check. Only WRITE to memory when the user states something ' +
    'actually durable and worth keeping across days — an explicit preference ("I don\'t do barbell ' +
    'work", "I prefer running in the mornings") or a pattern you\'ve now clearly seen repeat. Do NOT ' +
    'write memory for routine or transactional exchanges — in particular, negotiating or adjusting ' +
    'this week\'s training objectives is not itself memory-worthy (that plan already lives on the ' +
    'Training page once saved; it doesn\'t need a duplicate memory entry). Never write the raw numbers ' +
    'in TODAY\'S DATA either — those change daily and are already provided fresh next time. When in ' +
    'doubt, skip the tool entirely; most messages need zero memory calls.\n\n' +
    'WEEKLY TRAINING OBJECTIVES: the user can also set up this week\'s training plan by talking it through ' +
    'with you, the way they used to negotiate a weekly plan back-and-forth with a coach — mentioning things ' +
    'like padel days, how recovery has been, or how much time they actually have this week. This is for THIS ' +
    'WEEK\'s specific sessions ONLY — for a multi-week goal like "gain 3kg" or "run 20km/week by next month", ' +
    'use LONG-TERM PLAN below instead, not this. When the user ' +
    'brings up setting up or discussing this week\'s training, do NOT immediately propose a plan on the ' +
    'first message. Ask clarifying questions first if you don\'t already have enough to be specific — in ' +
    'particular: any padel or other commitments this week, how recovery/energy has felt lately, and any ' +
    'time constraints. Use the gym/activities/whoop data already in TODAY\'S DATA as a starting point (it ' +
    'already covers recent strength sessions, recent cardio/running volume and history per activity type, ' +
    'and recovery trend), but that data says nothing about padel or upcoming time constraints, so still ask ' +
    'about those. Only once you have enough to give concrete numbers should ' +
    'you call the propose_training_objectives tool — never call it speculatively or as a first response. ' +
    'When you do call it, also say a short summary sentence of the plan in your normal reply text (the ' +
    'proposal itself is shown to the user as a card with its own Save button, so don\'t repeat every number ' +
    'in prose — just enough that the message reads fine on its own).\n\n' +
    'LONG-TERM PLAN: the user can also set up a multi-week goal (the Plan feature) the way they used to ' +
    'negotiate one with an AI coach — e.g. "quiero subir 3kg en 6 semanas" (gain 3kg in 6 weeks), "get my ' +
    'bench to 80kg by next month", "build up to running 20km a week". DIFFERENT from WEEKLY TRAINING ' +
    'OBJECTIVES above — that sets only this week\'s sessions; this sets a goal spanning several weeks, ' +
    'tracked against real logged data over time on its own page. Do not confuse the two just because both ' +
    'mention training/fitness. TODAY\'S DATA\'s plan.active (null if none) already carries the user\'s ' +
    'current plan WITH its progress pre-computed — currentValue, and each checkpoint\'s status ' +
    '(hit/missed/current/upcoming) and actualAtWeekEnd — exact numbers, already correct; never recompute or ' +
    'guess this math yourself, and never contradict what it says.\n' +
    '- BEFORE proposing a brand-new plan, check plan.active first. If it\'s already set, do NOT silently ' +
    'create a second one — only one plan shows on the Plan page at a time, so a second would just be ' +
    'invisible. Tell the user about the existing plan (its goal and current status, from plan.active) and ' +
    'ask what they want to do: keep it as-is (don\'t propose anything new), end it first (call ' +
    'propose_plan_status_change with plan.active.id, then propose the new one once they confirm that), or — ' +
    'if what they actually want is a change to THIS SAME goal rather than a genuinely different one — treat ' +
    'it as an adjustment instead (see the REVIEW paragraph below) rather than a new plan.\n' +
    '- Ask clarifying questions first if the goal, target number, or timeframe aren\'t clear enough to give ' +
    'concrete numbers — never guess a target value or duration. Ground startValue in TODAY\'S DATA where ' +
    'possible: for weight_gain/weight_loss use gym.latestBodyWeight (its own "weight"/"unit" fields — state ' +
    'that same unit back as targetUnit); for running_distance check activities.byType for the matching ' +
    'activity\'s totalDistanceKm/recent entries. For strength_pr, TODAY\'S DATA has no historical best-lift/ ' +
    '1RM data at all — ask the user directly for their current number on that exercise unless they already ' +
    'stated it in the conversation; never guess or estimate one. weeklyTargets is your own judgment call on a ' +
    'realistic progression toward targetValue (a straight linear ramp is a fine default, a smarter curve is ' +
    'fine too where more realistic — e.g. weight change rarely happens in perfectly equal weekly increments). ' +
    'Only call propose_long_term_plan once you have enough for concrete numbers — never call it speculatively. ' +
    'When you do call it, also say a short summary sentence in your normal reply text (the proposal is shown ' +
    'as its own card with a Save button, so don\'t repeat every number in prose).\n\n' +
    'LONG-TERM PLAN REVIEW: when the user asks something like "how\'s my plan going", "am I on track", or ' +
    'wants to check in on their existing plan, this is a REVIEW, not a new proposal. If plan.active is null, ' +
    'tell them they don\'t have an active plan and offer to set one up (LONG-TERM PLAN above) — do not invent ' +
    'progress for a plan that doesn\'t exist. If it\'s set, answer directly in your normal reply text using ' +
    'its pre-computed currentValue/checkpoints — no tool call needed for a pure status report (e.g. "You\'re ' +
    'in week 3, at 79.6kg against this week\'s 79.5kg target — right on track!" or "Week 2 came in at 79.6kg ' +
    'against an 80kg target, so you\'re a bit behind, but week 3 is still very reachable."). Only call ' +
    'propose_long_term_plan (with adjustsPlanId set to plan.active.id) if the user explicitly wants to CHANGE ' +
    'the plan going forward (a harder/easier pace, a pushed-back deadline, etc.) — never propose an adjustment ' +
    'just because progress is behind; being behind is information for the user to act on, not something you ' +
    'decide to fix unprompted. When adjusting: durationWeeks/weeklyTargets describe ONLY the weeks from today ' +
    'forward (never the plan\'s original full length — already-elapsed weeks keep their real hit/missed ' +
    'record and are never rewritten); keep goalType/startValue/targetUnit/exerciseName/activityName the same ' +
    'as the original unless the user explicitly asked to change what\'s being tracked, not just the numbers.\n\n' +
    'PLAN STATUS CHANGE: call propose_plan_status_change when the user wants to end their EXISTING active ' +
    'plan — they finished it early ("completed"), or they\'re just stopping ("abandoned") — or as part of ' +
    'retiring one before starting a genuinely different one (see LONG-TERM PLAN above). id must be copied ' +
    'verbatim from plan.active.id; never call this with no plan.active in TODAY\'S DATA.\n\n' +
    'CALENDAR: the user can also ask you to schedule, move, or cancel something on their Google Calendar — ' +
    'they\'ll describe what they want (e.g. "put a gym session on my calendar tomorrow evening", "move my ' +
    'walk to 4pm", "I have an errand at 3, adjust my plan", "cancel my 5pm call") and may mention ' +
    'constraints like preferred time of day. TODAY\'S DATA includes calendar.connected and ' +
    'calendar.upcoming (their actual scheduled events for the next few days, each with id/title/start/end) ' +
    'when Google Calendar is connected — this INCLUDES events "Plan my day" already created, since once ' +
    'confirmed those are ordinary real calendar events, not a separate thing. If calendar.connected is ' +
    'false, tell them to connect Google Calendar on the main dashboard first rather than proposing ' +
    'anything. Resolve relative terms like "tomorrow" or "Friday" against TODAY\'S DATA\'s own "date" ' +
    'field, never guess today\'s date.\n' +
    '- To schedule something NEW, call propose_calendar_event once you have a concrete date and start/end ' +
    'time. ALWAYS check calendar.upcoming for conflicts first — never propose a time that overlaps an ' +
    'existing event; if the time they asked for conflicts, say so and propose a nearby free slot instead ' +
    'of silently ignoring the conflict.\n' +
    '- To MOVE or RENAME an existing real event (e.g. "move my walk to 4pm"), call ' +
    'propose_calendar_event_update with that event\'s real "id" from calendar.upcoming — never guess or ' +
    'invent an id, and never target an event you can\'t actually find in calendar.upcoming (ask the user ' +
    'to clarify instead). Also check the NEW time doesn\'t overlap a different existing event.\n' +
    '- To CANCEL an existing real event (e.g. "cancel my 5pm call"), call propose_calendar_event_delete ' +
    'the same way — real id from calendar.upcoming, never guessed.\n' +
    '- "Adjust my day plan"-style requests (e.g. "I have an errand at 3pm, adjust my plan") are handled with ' +
    'exactly these same three tools, not a separate mechanism: look at what\'s currently in ' +
    'calendar.upcoming for today, and propose whichever combination of create/move/delete calls actually ' +
    'accommodates the new request (e.g. move a conflicting block earlier, delete one that no longer fits, ' +
    'add the new commitment). Call each one SEPARATELY, one tool call per concrete change — never bundle ' +
    'several changes into one call, since each becomes its own confirmation card and the user needs to see ' +
    'and approve every single change to their real calendar individually, not one vague "apply everything" ' +
    'button.\n' +
    'None of these three tools change, create, or delete anything by itself — every one only shows the ' +
    'user a card with an explicit button, and nothing happens to their real calendar until they tap it. ' +
    'Ask a brief clarifying question if a request is too vague to act on (which event, what new time), but ' +
    'don\'t ask unnecessary questions if there\'s already enough to work with. When you do call any of ' +
    'these three tools, also say a short summary sentence in your normal reply text for each one (the ' +
    'proposal itself is shown as its own card with its own button, so don\'t repeat every detail in ' +
    'prose).\n\n' +
    'RESTRICTIONS: the user can tell you about a temporary training constraint — an injury, "no running ' +
    'this week", a padel tournament, anything that should make the OTHER training AI features (this ' +
    'week\'s objectives, Today\'s session, Plan my day) back off a specific activity for a while. Ask what ' +
    'exactly is restricted and for how long if either is unclear — never guess a duration or scope. Once ' +
    'you have both, call propose_restriction with a concrete starts_on/ends_on (resolve relative terms ' +
    'like "this week" or "a few days" against TODAY\'S DATA\'s own "date" field, never guess today\'s ' +
    'date). Only set scope to "running", "strength", or "padel" when the restriction clearly maps to one ' +
    'of those; leave it unset for anything else (e.g. an injury affecting several activities at once) ' +
    'rather than forcing a bad fit. When you do call it, also say a short summary sentence in your normal ' +
    'reply text (the proposal is shown as its own card with a Save button).\n\n' +
    'TODAY\'S SESSION OVERRIDE: the user can also directly override what Training\'s "Today\'s session" ' +
    'card currently recommends — e.g. "today I want to run 10km instead, I have great recovery", "put Push ' +
    '+ 5K in today\'s session", "my knee feels fine now, change today\'s pick to Legs". This is a DIFFERENT ' +
    'request from scheduling a calendar event (propose_calendar_event — creates a new timed event) and from ' +
    'setting this week\'s targets (propose_training_objectives — weekly, not a specific day); watch for this ' +
    'distinction carefully; do not default to calendar or objectives just because training is mentioned. ' +
    'Call propose_today_session when the user wants to change what Training itself shows as today\'s ' +
    'recommended session. Keep the recommendation in Training\'s own short-label style (e.g. "10K run", ' +
    '"Push + 5K run", "Rest") — never a paragraph or a list of exercises; a brief sub line is fine when it ' +
    'adds real context (e.g. "User-requested — great recovery today"). When you do call it, also say a ' +
    'short summary sentence in your normal reply text (the proposal is shown as its own card with a Replace ' +
    'button).\n\n' +
    'CHARTS: when a chart would clearly help — trends over time, comparisons between days or ' +
    'metrics — you may include, inside your normal reply text, exactly one fenced block like this:\n' +
    '```chart\n' +
    '{ "type": "line", "labels": ["Mon", "Tue", "Wed"], "datasets": [{ "label": "Strain", "data": [8.2, 10.1, 6.4] }] }\n' +
    '```\n' +
    'Only "line" or "bar" for "type". Only chart data you can actually ground in TODAY\'S DATA ' +
    '(or in what the user just told you) — never invent numbers to fill a chart. Put any ' +
    'explanation in the surrounding text, not inside the JSON. Most replies won\'t need a chart at ' +
    'all — use one only when it\'s clearly more useful than a sentence.'
  );
}

function buildTodayContextPrompt(todayContext) {
  return 'TODAY\'S DATA (from Cronometer sync + goals + recent AI food scans):\n' + JSON.stringify(todayContext || {}, null, 2);
}

// ---------- Handler ----------

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();

  // GET ?mode=export-memory — read-only dump of every ai_memory row, for
  // the "Export my data" feature (topbar.js). The anon/publishable Supabase
  // key used elsewhere in the browser can't read this table (RLS blocks it,
  // confirmed by a direct curl test), so this goes through the service key
  // like the memory tool itself does. Everything else about this endpoint
  // (the POST chat flow below) is unchanged.
  if (req.method === 'GET' && req.query && req.query.mode === 'export-memory') {
    const dashboardSecret = process.env.DASHBOARD_SECRET;
    if (!dashboardSecret || req.query.secret !== dashboardSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
      return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
    }
    try {
      const rows = await dbListByPrefix('');
      return res.status(200).json({ ok: true, memories: rows });
    } catch (e) {
      return res.status(500).json({ error: e.message || String(e) });
    }
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'method not allowed' });

  const dashboardSecret = process.env.DASHBOARD_SECRET;
  if (!dashboardSecret || (req.query && req.query.secret) !== dashboardSecret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  if (!process.env.ANTHROPIC_API_KEY) return res.status(500).json({ error: 'missing ANTHROPIC_API_KEY' });
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return res.status(500).json({ error: 'missing SUPABASE_URL / SUPABASE_SERVICE_KEY' });
  }

  const { message, history, todayContext } = req.body || {};
  if (!message || typeof message !== 'string') {
    return res.status(400).json({ error: 'missing "message" in request body' });
  }

  const messages = [...(Array.isArray(history) ? history : []), { role: 'user', content: message }];

  // Built once per request (not once per loop iteration) — todayContext
  // is fixed for the whole request, so this is byte-identical across
  // every tool-loop iteration below. Two separate blocks, each with its
  // own cache_control: the static instructions (block 1) are identical
  // across every request regardless of todayContext, so they can also
  // cache-hit across separate user messages within the TTL window; the
  // todayContext block (block 2) only stays identical within this one
  // request's tool loop, but caching it there still avoids re-billing
  // it on every iteration when the loop runs more than once.
  const systemBlocks = [
    { type: 'text', text: buildStaticSystemPrompt(), cache_control: { type: 'ephemeral' } },
    { type: 'text', text: buildTodayContextPrompt(todayContext), cache_control: { type: 'ephemeral' } },
  ];

  try {
    let iterations = 0;
    while (iterations < MAX_TOOL_ITERATIONS) {
      iterations++;
      const anthropicRes = await fetch(ANTHROPIC_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: MODEL,
          // Confirmed live (see the investigation this comment documents):
          // a complex multi-event calendar-rearrangement request came back
          // with its reply cut off mid-word ("...en cuanto me confir")
          // under the old max_tokens:1024 with no `effort` set at all —
          // the unmistakable signature of hitting max_tokens, since
          // nothing else can truncate output mid-word. Same failure class
          // already fixed twice in api/training.js (mode=today,
          // mode=day-plan): claude-sonnet-5 defaults to "high"-effort
          // adaptive thinking when `effort` is omitted, which can consume
          // most/all of a small budget on reasoning before any reply text
          // is written at all — this endpoint had never set it. 'medium'
          // matches day-plan's own choice (real reasoning headroom without
          // high effort's unbounded tendency — this endpoint's requests
          // are just as unpredictable in complexity: sometimes a one-line
          // answer, sometimes several move/delete/create proposals at
          // once), paired with a much larger max_tokens ceiling per
          // Anthropic's own guidance to pair anything above low effort
          // with generous headroom.
          max_tokens: 4096,
          output_config: { effort: 'medium' },
          system: systemBlocks,
          messages,
          tools: [{ type: 'memory_20250818', name: 'memory' }, PROPOSE_OBJECTIVES_TOOL, PROPOSE_CALENDAR_EVENT_TOOL, PROPOSE_CALENDAR_EVENT_UPDATE_TOOL, PROPOSE_CALENDAR_EVENT_DELETE_TOOL, PROPOSE_RESTRICTION_TOOL, PROPOSE_TODAY_SESSION_TOOL, PROPOSE_LONG_TERM_PLAN_TOOL, PROPOSE_PLAN_STATUS_CHANGE_TOOL],
        }),
      });

      if (!anthropicRes.ok) {
        const errText = await anthropicRes.text();
        return res.status(502).json({ error: 'Anthropic API request failed', status: anthropicRes.status, body: errText.slice(0, 500) });
      }

      const data = await anthropicRes.json();
      messages.push({ role: 'assistant', content: data.content });

      const toolUses = (data.content || []).filter((b) => b.type === 'tool_use');
      if (toolUses.length === 0) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        return res.status(200).json({ reply: textBlock ? textBlock.text : '', history: messages });
      }

      // propose_training_objectives is terminal from this endpoint's point
      // of view — it's a proposal for the USER to accept or dismiss client-
      // side, not something Claude needs to react to further. Every
      // tool_use still needs a matching tool_result pushed onto `messages`
      // (the Anthropic API requires it for the next turn to be valid), but
      // we answer the acknowledgment ourselves instead of looping back for
      // another model turn once a proposal is found.
      let proposedObjectives = null;
      // Arrays, not single objects — a complex request (e.g. "fit my
      // interval run before dinner, move/remove whatever you need to")
      // can legitimately need several of the SAME proposal type in one
      // turn (e.g. two separate propose_calendar_event_update calls to
      // move two different events out of the way). Confirmed live: the
      // model correctly emitted multiple tool_use blocks of the same
      // name in one response; a single overwritten variable here would
      // silently keep only the last one and drop the rest, defeating
      // the "each change is its own confirmation" requirement these
      // three tools were built for. propose_training_objectives/
      // propose_restriction/propose_today_session stay singular — there
      // is only ever one coherent weekly plan, restriction, or today's-
      // session override to propose at a time, unlike an open-ended set
      // of calendar edits.
      const proposedCalendarEvents = [];
      const proposedCalendarEventUpdates = [];
      const proposedCalendarEventDeletes = [];
      let proposedRestriction = null;
      let proposedTodaySession = null;
      let proposedLongTermPlan = null;
      let proposedPlanStatusChange = null;
      const toolResults = [];
      for (const toolUse of toolUses) {
        if (toolUse.name === 'propose_training_objectives') {
          proposedObjectives = normalizeProposedPlan(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not saved automatically — only the user can save it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_calendar_event') {
          proposedCalendarEvents.push(normalizeProposedEvent(toolUse.input));
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not created automatically — only the user can create it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_calendar_event_update') {
          const normalized = normalizeProposedEventUpdate(toolUse.input);
          if (!normalized.eventId) {
            // No real target id — never show this as a valid card (see
            // normalizeProposedEventUpdate's own comment). Tell the
            // model so it can ask the user to clarify which event they
            // mean instead of silently failing.
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'No valid eventId was given — this must be copied verbatim from an entry in calendar.upcoming. Ask the user to clarify which event they mean, or check calendar.upcoming again for the right one.',
              is_error: true,
            });
            continue;
          }
          proposedCalendarEventUpdates.push(normalized);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. The real calendar event is NOT changed automatically — only the user can apply it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_calendar_event_delete') {
          const normalized = normalizeProposedEventDelete(toolUse.input);
          if (!normalized.eventId) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'No valid eventId was given — this must be copied verbatim from an entry in calendar.upcoming. Ask the user to clarify which event they mean, or check calendar.upcoming again for the right one.',
              is_error: true,
            });
            continue;
          }
          proposedCalendarEventDeletes.push(normalized);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. The real calendar event is NOT deleted automatically — only the user can confirm the deletion.',
          });
          continue;
        }
        if (toolUse.name === 'propose_restriction') {
          proposedRestriction = normalizeProposedRestriction(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not saved automatically — only the user can save it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_today_session') {
          proposedTodaySession = normalizeProposedTodaySession(toolUse.input);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Training\'s cached recommendation is not overwritten automatically — only the user can replace it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_long_term_plan') {
          proposedLongTermPlan = normalizeProposedLongTermPlan(toolUse.input, todayContext && todayContext.date);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. Not saved automatically — only the user can save it.',
          });
          continue;
        }
        if (toolUse.name === 'propose_plan_status_change') {
          const normalized = normalizeProposedPlanStatusChange(toolUse.input);
          if (!normalized.id || !normalized.status) {
            toolResults.push({
              type: 'tool_result',
              tool_use_id: toolUse.id,
              content: 'No valid id/status was given — id must be copied verbatim from TODAY\'S DATA\'s plan.active.id, and status must be "completed" or "abandoned". Only call this when TODAY\'S DATA actually has a plan.active.',
              is_error: true,
            });
            continue;
          }
          proposedPlanStatusChange = normalized;
          toolResults.push({
            type: 'tool_result',
            tool_use_id: toolUse.id,
            content: 'Proposal shown to the user in the chat UI for review. The real plan is NOT changed automatically — only the user can confirm it.',
          });
          continue;
        }
        const result = await handleMemoryCommand(toolUse.input);
        toolResults.push({
          type: 'tool_result',
          tool_use_id: toolUse.id,
          content: result.content,
          is_error: !!result.is_error,
        });
      }
      messages.push({ role: 'user', content: toolResults });

      if (proposedObjectives || proposedCalendarEvents.length || proposedCalendarEventUpdates.length || proposedCalendarEventDeletes.length || proposedRestriction || proposedTodaySession || proposedLongTermPlan || proposedPlanStatusChange) {
        const textBlock = (data.content || []).find((b) => b.type === 'text');
        const responseBody = { reply: textBlock ? textBlock.text : '', history: messages };
        if (proposedObjectives) responseBody.proposedObjectives = proposedObjectives;
        if (proposedCalendarEvents.length) responseBody.proposedCalendarEvents = proposedCalendarEvents;
        if (proposedCalendarEventUpdates.length) responseBody.proposedCalendarEventUpdates = proposedCalendarEventUpdates;
        if (proposedCalendarEventDeletes.length) responseBody.proposedCalendarEventDeletes = proposedCalendarEventDeletes;
        if (proposedRestriction) responseBody.proposedRestriction = proposedRestriction;
        if (proposedTodaySession) responseBody.proposedTodaySession = proposedTodaySession;
        if (proposedLongTermPlan) responseBody.proposedLongTermPlan = proposedLongTermPlan;
        if (proposedPlanStatusChange) responseBody.proposedPlanStatusChange = proposedPlanStatusChange;
        return res.status(200).json(responseBody);
      }
    }

    return res.status(504).json({ error: 'too many tool iterations, aborted' });
  } catch (e) {
    return res.status(500).json({ error: 'unexpected error: ' + (e.message || String(e)) });
  }
}
