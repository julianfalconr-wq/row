// =============================================================
// Shared scoring logic for Today's Score / habits — the ONE place
// manualHabitFraction, weeklyCap/zeroTolerance handling, the Training
// category (Strength+Cardio averaging, the WHOOP All-Out override),
// and the other auto-sourced categories get computed for the whole
// app.
//
// Consolidated from three previously-independent copies in main.html,
// habits.html, and trends.html, after that duplication caused three
// real bugs in one session: a fix landing in one or two copies but
// not the third (most recently, the backwards No Fap/No Porn
// weeklyCap/zeroTolerance scoring bug — fixed in main.html and
// habits.html, but silently still broken in trends.html's historical
// charts until this consolidation caught it). A fourth, lower-stakes
// instance was caught during the consolidation itself: trends.html's
// own normalizeHabit() still had the old "Number(h.dailyGoal) || 1"
// bug (a Quit habit's real dailyGoal:0 getting silently reset to 1 on
// every config reload) — already harmless in practice by the time
// this was found, since the weeklyCap/zeroTolerance fix above stopped
// consulting dailyGoal for Quit habits at all, but a real divergence
// nonetheless.
//
// Every function body below is main.html's own verbatim implementation
// (the fullest, most recently fixed of the three copies — includes
// label/detail/reason fields habits.html and trends.html simply don't
// read, which is harmless) — habits.html and trends.html now call into
// this file instead of keeping their own leaner copies.
//
// PLAIN CLASSIC SCRIPT ON PURPOSE (not deferred, not a module) —
// same reasoning as daylib.js's own header comment: a classic script,
// loaded without `defer` and positioned right after daylib.js (which
// this file depends on for date math) in every consumer's <head>,
// sets window.ScoreLib synchronously before any inline <script> block
// runs, regardless of whether that block is DOMContentLoaded-wrapped
// (main.html/habits.html/trends.html all are, for this logic) or bare
// synchronous inline code. Watch for the same load-order class of bug
// already caught multiple times in this project (daylib.js itself,
// RowIcons) — this file must be loaded (and daylib.js loaded before
// it) before any script that calls into window.ScoreLib.
//
// SCOPE — deliberately excluded from this file despite living beside
// this logic in the three pages:
//   - Network I/O (fetchHabitConfig, fetchDailyHabitsRange, WHOOP/
//     Cronometer fetches) stays page-local, same boundary DayLib/
//     CronoLib already draw — this file is pure, side-effect-free
//     scoring logic operating on already-fetched data.
//   - computeWhoopStrainToday (the live "today" WHOOP day-strain
//     fetch feeding combineTrainingFraction's All-Out override) also
//     stayed page-local rather than moving here: main.html's and
//     trends.html's copies turned out to have a genuine, pre-existing
//     behavioral difference (trends.html attempts a token refresh
//     before fetching; main.html doesn't) tied to each page's own
//     WHOOP-refresh helpers — silently picking one to "consolidate"
//     to would have changed real behavior, which this refactor must
//     not do. combineTrainingFraction itself (the pure decision logic
//     once a strain reading IS available) lives here as normal; only
//     the fetch-and-refresh mechanics stayed put.
// =============================================================
(function () {
  'use strict';

  // ---------- private date helpers (self-contained — does not rely
  // on the host page defining its own copies, avoiding a new
  // load-order dependency beyond DayLib itself) ----------
  function addDaysKey(dateKeyStr, n) {
    const d = DayLib.parseDateKey(dateKeyStr);
    d.setDate(d.getDate() + n);
    return DayLib.plainDateKey(d);
  }
  // 400-day guard is a pure safety backstop against a caller passing a
  // reversed/absurd range — every real caller of this internally
  // (weekOccurrenceCount, scoreManualHabitsForDate's own callers) only
  // ever passes a single week's worth of dates, so this is never
  // actually hit in practice regardless of the exact guard value.
  function datesFromTo(fromKey, toKey) {
    const out = [];
    let k = fromKey;
    let guard = 0;
    while (k <= toKey && guard++ < 400) { out.push(k); k = addDaysKey(k, 1); }
    return out;
  }
  function mondayBasedDayIndex(dateKeyStr) {
    const day = DayLib.parseDateKey(dateKeyStr).getDay();
    return day === 0 ? 6 : day - 1;
  }

  // ---------- habit config ----------
  function defaultHabitConfig() {
    return {
      habits: [
        { id: 'sleep_wake',   name: 'Slept early & woke early',    points: 10, buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 2, unit: 'times', advanced: null },
        { id: 'brush_teeth',  name: 'Brush teeth (AM + PM)',       points: 4,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 2, unit: 'times', advanced: null },
        { id: 'productivity', name: '1h focused productivity',     points: 8,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: null },
        { id: 'screen_time',  name: 'Screen time under 6h',        points: 8,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: null },
        { id: 'plan_day',     name: 'Plan the day',                points: 5,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: null },
        { id: 'walk_dog',     name: 'Walk the dog (AM + PM)',      points: 6,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 2, unit: 'times', advanced: null },
        { id: 'no_phone_30',  name: 'No phone first 30 min',       points: 6,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: null },
        { id: 'no_porn',      name: 'No porn',                     points: 15, buildOrQuit: 'quit',  frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: { zeroTolerance: true } },
        { id: 'no_fap',       name: 'No fap',                      points: 15, buildOrQuit: 'quit',  frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: { weeklyCap: { allowedPerWeek: 2, weeklyPenalty: 15, dailyPenalty: 5 } } },
        { id: 'read',         name: 'Read',                        points: 4,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 1, unit: 'times', advanced: null },
        { id: 'stretch',      name: 'Stretching (morning + night)',points: 6,  buildOrQuit: 'build', frequency: { type: 'daily' }, dailyGoal: 2, unit: 'times', advanced: null },
      ],
    };
  }

  // Defensive adapter: the user's real habit_config has already been
  // migrated to the new shape in Supabase via a one-time script (same
  // mapping as below), but this stays as a permanent safety net rather
  // than a one-time-only shim — e.g. a stale cached copy from before
  // the migration, or a future save that somehow only sets some
  // fields. Detects new-vs-old shape by presence of dailyGoal/
  // buildOrQuit/advanced (new) vs. a bare "type" string (old).
  function normalizeHabit(h) {
    h = h || {};
    if (h.dailyGoal != null || h.buildOrQuit || h.advanced !== undefined) {
      return {
        id: h.id,
        name: h.name || h.label || '',
        points: Number(h.points) || 0,
        buildOrQuit: h.buildOrQuit === 'quit' ? 'quit' : 'build',
        frequency: h.frequency || { type: 'daily' },
        // NOT "Number(h.dailyGoal) || 1" — a Quit habit can legitimately
        // be saved with dailyGoal 0 (abstain completely), and 0 is
        // falsy, so that fallback would silently revert it back to 1
        // every time the config reloads through this "safety net" path.
        dailyGoal: Number.isFinite(Number(h.dailyGoal)) ? Number(h.dailyGoal) : 1,
        unit: typeof h.unit === 'string' ? h.unit : 'times',
        advanced: h.advanced || null,
      };
    }
    // Old shape (type: manual_binary/manual_count2/manual_numeric/
    // zero_tolerance/weekly_cap/auto_threshold) — same mapping the
    // one-time production migration used.
    const base = { id: h.id, name: h.label || '', points: Number(h.points) || 0, frequency: { type: 'daily' } };
    if (h.type === 'manual_count2') return { ...base, buildOrQuit: 'build', dailyGoal: 2, unit: 'times', advanced: null };
    if (h.type === 'manual_numeric') return { ...base, buildOrQuit: 'build', dailyGoal: Number(h.goal) || 1, unit: (h.unit != null ? h.unit : ''), advanced: null };
    if (h.type === 'zero_tolerance') return { ...base, buildOrQuit: 'quit', dailyGoal: 1, unit: 'times', advanced: { zeroTolerance: true } };
    if (h.type === 'weekly_cap') return { ...base, buildOrQuit: 'quit', dailyGoal: 1, unit: 'times', advanced: { weeklyCap: { allowedPerWeek: h.weeklyCap, weeklyPenalty: h.weeklyPenaltyPoints, dailyPenalty: h.perExtraDayPenaltyPoints } } };
    if (h.type === 'auto_threshold') return { ...base, buildOrQuit: 'build', dailyGoal: 1, unit: 'times', advanced: { autoThreshold: { source: h.source, operator: h.operator, value: h.threshold } } };
    return { ...base, buildOrQuit: 'build', dailyGoal: 1, unit: 'times', advanced: null }; // manual_binary or unrecognized
  }

  // ---------- manual habit scoring ----------
  function manualHabitFraction(habit, entryVal) {
    return Math.max(0, Math.min(1, (Number(entryVal) || 0) / (Number(habit.dailyGoal) || 1)));
  }
  function compareThreshold(value, operator, threshold) {
    const v = Number(value), t = Number(threshold);
    switch (operator) {
      case '>': return v > t;
      case '<=': return v <= t;
      case '<': return v < t;
      case '==': return v === t;
      default: return v >= t; // '>=' and any unrecognized operator
    }
  }
  function weekOccurrenceCount(habit, entriesByDate, fromKey, toKey) {
    let n = 0;
    datesFromTo(fromKey, toKey).forEach((k) => {
      const e = entriesByDate[k] && entriesByDate[k][habit.id];
      if (e && e.na !== true && Number(e.value) > 0) n++;
    });
    return n;
  }
  function scoreManualHabitsForDate(habitConfig, entriesByDate, dateActiveKey, weekMondayActiveKey, autoSources) {
    const entry = entriesByDate[dateActiveKey] || null;
    let earned = 0, possible = 0;
    const breakdown = [];
    const flags = [];
    (habitConfig.habits || []).forEach((h) => {
      const advanced = h.advanced || null;
      if (advanced && advanced.autoThreshold) {
        const cfg = advanced.autoThreshold;
        const src = (autoSources && autoSources[cfg.source]) || { available: false };
        if (!src.available) { breakdown.push({ id: h.id, label: h.name, points: h.points, status: 'unlogged' }); return; }
        const met = compareThreshold(src.value, cfg.operator, cfg.value);
        const pts = met ? h.points : 0;
        earned += pts; possible += h.points;
        breakdown.push({ id: h.id, label: h.name, points: h.points, earnedPts: pts, status: met ? 'ok' : 'zero', detail: Math.round(src.value) + ' ' + (cfg.operator || '>=') + ' ' + (cfg.value || 0) });
        return;
      }
      const e = entry && entry[h.id];
      if (!e) { breakdown.push({ id: h.id, label: h.name, points: h.points, status: 'unlogged' }); return; }
      if (e.na === true) { breakdown.push({ id: h.id, label: h.name, points: h.points, status: 'na' }); return; }

      if (advanced && advanced.weeklyCap) {
        const cfg = advanced.weeklyCap;
        possible += h.points;
        // Same reasoning as weekOccurrenceCount above — a raw value
        // check, not manualHabitFraction/dailyGoal, which is meaningless
        // for this combination and previously inverted the scoring.
        if (Number(e.value) <= 0) { // abstained today
          earned += h.points;
          breakdown.push({ id: h.id, label: h.name, points: h.points, earnedPts: h.points, status: 'ok' });
        } else {
          const countThroughToday = weekOccurrenceCount(h, entriesByDate, weekMondayActiveKey, dateActiveKey);
          const over = Math.max(0, countThroughToday - (cfg.allowedPerWeek || 0));
          const pts = Math.max(0, h.points - over * (cfg.dailyPenalty || 0));
          earned += pts;
          breakdown.push({ id: h.id, label: h.name, points: h.points, earnedPts: pts, status: pts <= 0 ? 'zero' : 'partial', overCap: countThroughToday > (cfg.allowedPerWeek || 0) });
        }
        return;
      }

      // Same class of bug as weeklyCap above, found while regression-
      // testing that fix: zeroTolerance is ALSO a Quit-type rule ("any
      // occurrence at all is a violation"), so it needs the same direct
      // Number(e.value) > 0 check instead of manualHabitFraction/
      // dailyGoal — a "fraction" of a goal is meaningless here too, and
      // scoring gradually (frac * points) is doubly wrong on top of
      // that, since zero tolerance means a violation is a FULL loss of
      // points that day, not a partial one. Confirmed live: logging 0
      // (abstained) was being flagged as the violation and scored 0
      // points, while logging 1 (an actual violation) scored full
      // points — the exact mirror of the weeklyCap bug.
      if (advanced && advanced.zeroTolerance) {
        possible += h.points;
        const violated = Number(e.value) > 0;
        const pts = violated ? 0 : h.points;
        earned += pts;
        if (violated) flags.push(h.name);
        breakdown.push({ id: h.id, label: h.name, points: h.points, earnedPts: pts, status: violated ? 'zero_tolerance_violation' : 'ok' });
        return;
      }

      const frac = manualHabitFraction(h, e.value);
      const pts = frac * h.points;
      earned += pts; possible += h.points;
      breakdown.push({ id: h.id, label: h.name, points: h.points, earnedPts: pts, status: pts >= h.points ? 'ok' : (pts <= 0 ? 'zero' : 'partial') });
    });
    return { earned, possible, breakdown, flags };
  }

  // ---------- Strength / Cardio / Training ----------
  function todaySplitFor(pcState, dateKeyStr) {
    try {
      const rot = pcState.splitRotation;
      if (!rot || !rot.length) return { name: '—' };
      const a = DayLib.parseDateKey(pcState.splitAnchor.date);
      const t = DayLib.parseDateKey(dateKeyStr);
      a.setHours(0, 0, 0, 0); t.setHours(0, 0, 0, 0);
      const diffDays = Math.round((t - a) / 86400000);
      const idx = ((pcState.splitAnchor.index + diffDays) % rot.length + rot.length) % rot.length;
      return { name: rot[idx] };
    } catch (e) { return { name: '—' }; }
  }
  function computeStrengthCategory(datePlainKey) {
    let pc = null;
    try { pc = JSON.parse(localStorage.getItem('po_coach_v1')); } catch (e) {}
    if (!pc || !Array.isArray(pc.splitRotation) || !pc.splitRotation.length || !pc.splitAnchor || !pc.splitAnchor.date) {
      return { available: false, reason: 'Training not set up' };
    }
    const split = todaySplitFor(pc, datePlainKey);
    if (/^rest\b/i.test(split.name || '')) return { available: false, reason: 'rest day' };
    let doneDays = {};
    try { doneDays = JSON.parse(localStorage.getItem('po_coach_workout_done')) || {}; } catch (e) {}
    const done = !!doneDays[datePlainKey];
    return { available: true, fraction: done ? 1 : 0, label: 'Strength (' + split.name + ')', detail: done ? 'Done' : 'Not logged yet' };
  }
  function migratePlanCardio(planInner) {
    if (!planInner || typeof planInner !== 'object' || planInner.cardio) return planInner;
    const running = planInner.running;
    if (!running) return planInner;
    const longRun = running.longRun || {};
    const easyVolume = running.easyVolume || {};
    return Object.assign({}, planInner, {
      cardio: {
        longSession: { activityTypeId: 'running', targetAmount: longRun.targetKm || 0 },
        easyVolume: { activityTypeId: 'running', targetAmount: easyVolume.targetKm || 0 },
      },
    });
  }
  function computeCardioCategory(datePlainKey, weekMondayPlainKey) {
    let activities = [];
    try { activities = JSON.parse(localStorage.getItem('po_coach_activities')) || []; } catch (e) { activities = []; }

    // (1) Any session actually logged TODAY — checked FIRST, with NO
    // dependency on a weekly plan existing at all. This used to sit
    // after the "no plan yet" early-return below, which meant a real
    // logged session (e.g. a WHOOP-imported padel/paddle-tennis entry)
    // was silently ignored whenever the current week had no matching
    // plan yet (never generated, or generated for a different
    // weekStart) — confirmed live: Training showed 0/20 with cardio
    // excluded entirely from combineTrainingFraction's average, even
    // though po_coach_activities had a real session for today. A
    // logged session is real evidence of training regardless of
    // whether a plan exists to compare it against. "recommendable"
    // isn't checked here either — that's the right call regardless:
    // whether a type is currently allowed for future AI planning is a
    // different question from whether a real session the user actually
    // did today should count as "trained today".
    const todayTypes = Array.from(new Set(activities.filter((a) => a && a.dateKey === datePlainKey).map((a) => a.activityTypeId).filter(Boolean)));
    if (todayTypes.length) {
      return { available: true, fraction: 1, label: 'Cardio', detail: 'Logged today (' + todayTypes.join(', ') + ')' };
    }

    // (2) Fallback — this week's pace-so-far toward whichever type(s)
    // were actually assigned, same math as the original running-only
    // version. This DOES need a real plan for the current week, since
    // it compares progress against that plan's own targets.
    let plan = null;
    try { plan = JSON.parse(localStorage.getItem('po_coach_weekly_plan_v1')); } catch (e) {}
    if (plan && plan.plan) plan.plan = migratePlanCardio(plan.plan);
    if (!plan || plan.weekStart !== weekMondayPlainKey || !plan.plan || !plan.plan.cardio) return { available: false, reason: 'no weekly plan yet' };
    const cardio = plan.plan.cardio;
    const longSession = cardio.longSession || {};
    const easyVolume = cardio.easyVolume || {};
    const assignedTypeIds = new Set([longSession.activityTypeId, easyVolume.activityTypeId].filter(Boolean));
    let kmTarget = 0;
    if (longSession.activityTypeId) kmTarget += Number(longSession.targetAmount) || 0;
    if (easyVolume.activityTypeId) kmTarget += Number(easyVolume.targetAmount) || 0;
    kmTarget = Math.round(kmTarget * 10) / 10;
    if (!kmTarget) return { available: false, reason: 'no cardio target this week' };
    const soFar = activities.filter((a) => a && assignedTypeIds.has(a.activityTypeId) && a.dateKey >= weekMondayPlainKey && a.dateKey <= datePlainKey);
    const kmDone = Math.round(soFar.reduce((s, a) => s + (Number(a.distanceKm) || 0), 0) * 10) / 10;
    const dayIdx = mondayBasedDayIndex(datePlainKey);
    const expected = kmTarget * ((dayIdx + 1) / 7);
    const fraction = expected > 0 ? Math.min(1, kmDone / expected) : 1;
    return { available: true, fraction, label: 'Cardio pace', detail: kmDone + ' / ' + kmTarget + ' km this week' };
  }
  function combineTrainingFraction(strength, cardio, whoopStrainToday) {
    if (whoopStrainToday && whoopStrainToday.available && whoopStrainToday.strain >= 18) {
      return { available: true, fraction: 1, detail: 'All-Out day (WHOOP strain ' + whoopStrainToday.strain + ') — full training credit' };
    }
    const fracs = [];
    const details = [];
    if (strength.available) { fracs.push(strength.fraction); details.push(strength.label + ': ' + strength.detail); }
    if (cardio.available) { fracs.push(cardio.fraction); details.push(cardio.label + ': ' + cardio.detail); }
    if (!fracs.length) return { available: false, reason: strength.reason || cardio.reason || 'no data yet' };
    return { available: true, fraction: fracs.reduce((a, b) => a + b, 0) / fracs.length, detail: details.join(' · ') };
  }
  function combineWeightedCategories(categories, weights) {
    let earned = 0, weightSum = 0;
    categories.forEach(({ key, c }) => {
      if (!c.available) return;
      const w = Number(weights[key]) || 0;
      earned += c.fraction * w;
      weightSum += w;
    });
    return weightSum > 0 ? Math.round((earned / weightSum) * 100) : null;
  }

  // ---------- other auto-sourced categories ----------
  function computeStackCategory(dateActiveKey) {
    if (typeof window.CronoLib === 'undefined') return { available: false };
    const pct = window.CronoLib.getStackCompletionForDate(dateActiveKey);
    if (pct == null) return { available: false, reason: 'no stack configured' };
    return { available: true, fraction: pct / 100, label: 'Daily Stack', detail: pct + '% taken' };
  }
  function computeWaterCategory(datePlainKey) {
    let s = null;
    try { s = JSON.parse(localStorage.getItem('po_water_v1')); } catch (e) {}
    if (!s || typeof s !== 'object') return { available: false, reason: 'not set up yet' };
    const logs = s.logs || {};
    if (!Object.prototype.hasOwnProperty.call(logs, datePlainKey)) return { available: false, reason: 'nothing logged yet' };
    const count = logs[datePlainKey] || 0;
    const unitMl = s.unit === 'bottle' ? (s.bottleMl || 500) : s.unit === 'glass' ? (s.glassMl || 250) : s.unit === 'oz' ? 30 : 1;
    const drankMl = count * unitMl;
    const p = Object.assign({ weightKg: 75, age: 25, sex: 'm', activityHrsPerWeek: 5 }, s.profile || {});
    const wKg = s.weightUnit === 'lb' ? p.weightKg / 2.20462 : p.weightKg;
    const base = wKg * 35;
    const exercise = (p.activityHrsPerWeek || 0) / 7 * 500;
    const caffeine = Math.max(0, (s.caffeineMgPerDay != null ? s.caffeineMgPerDay : 200) - 200) * 1.5;
    let adjust = 0;
    if (p.sex === 'm') adjust += 200;
    if ((p.age || 0) >= 50) adjust += 100;
    const targetMl = base + exercise + caffeine + adjust; // substances omitted here (would need the full list re-parsed) — close enough for scoring purposes
    if (!targetMl) return { available: false };
    const fraction = Math.min(1, drankMl / targetMl);
    return { available: true, fraction, label: 'Water', detail: Math.round(drankMl) + ' / ' + Math.round(targetMl) + ' ml' };
  }
  window.ScoreLib = {
    defaultHabitConfig,
    normalizeHabit,
    manualHabitFraction,
    compareThreshold,
    weekOccurrenceCount,
    scoreManualHabitsForDate,
    todaySplitFor,
    computeStrengthCategory,
    migratePlanCardio,
    computeCardioCategory,
    combineTrainingFraction,
    combineWeightedCategories,
    computeStackCategory,
    computeWaterCategory,
  };
})();
