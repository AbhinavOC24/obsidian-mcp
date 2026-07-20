/**
 * SM-2 spaced-repetition algorithm implementation.
 *
 * Grade scale (mirrors Anki's button labels):
 *   0 = again  (complete blackout / wrong)
 *   1 = hard   (correct but with significant difficulty)
 *   2 = good   (correct after a hesitation)
 *   3 = easy   (perfect recall)
 *
 * Reference: https://www.supermemo.com/en/blog/application-of-a-computer-to-improve-the-results-achieved-in-working-with-the-super-memo-method
 */

export type Grade = 0 | 1 | 2 | 3;

export interface SM2State {
  easeFactor: number;   // default 2.5, minimum 1.3
  intervalDays: number; // days until next review
  dueDate: string;      // ISO date YYYY-MM-DD
  reviewCount: number;
}

export interface SM2Result {
  easeFactor: number;
  intervalDays: number;
  dueDate: string;
  reviewCount: number;
}

const MIN_EASE = 1.3;

/**
 * Calculate the next review state given the current SM-2 state and grade.
 */
export function calculateNextReview(state: SM2State, grade: Grade): SM2Result {
  const { easeFactor, intervalDays, reviewCount } = state;

  let newEase = easeFactor;
  let newInterval: number;

  if (grade === 0) {
    // "Again" — reset interval, don't change ease (card goes back to start)
    newInterval = 1;
    newEase = Math.max(MIN_EASE, easeFactor - 0.2);
  } else {
    // Ease adjustment per grade
    const easeDeltas: Record<Grade, number> = {
      0: -0.2,  // handled above
      1: -0.15, // hard
      2: 0,     // good — no change
      3: +0.1,  // easy
    };
    newEase = Math.max(MIN_EASE, easeFactor + easeDeltas[grade]);

    if (reviewCount === 0) {
      newInterval = 1;
    } else if (reviewCount === 1) {
      newInterval = 6;
    } else {
      newInterval = Math.round(intervalDays * newEase);
      // Cap "hard" multiplier
      if (grade === 1) {
        newInterval = Math.max(intervalDays + 1, Math.round(intervalDays * 1.2));
      }
    }
  }

  const due = addDays(new Date(), newInterval);
  return {
    easeFactor: parseFloat(newEase.toFixed(4)),
    intervalDays: newInterval,
    dueDate: toISODate(due),
    reviewCount: reviewCount + 1,
  };
}

/**
 * Parse a grade string from an MCP client into a numeric grade.
 * Accepts "again" | "hard" | "good" | "easy" or numeric "0"–"3".
 */
export function parseGrade(raw: string): Grade {
  const map: Record<string, Grade> = {
    again: 0, "0": 0,
    hard: 1,  "1": 1,
    good: 2,  "2": 2,
    easy: 3,  "3": 3,
  };
  const g = map[raw.toLowerCase()];
  if (g === undefined) throw new Error(`Invalid grade "${raw}". Use: again/hard/good/easy or 0–3`);
  return g;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function addDays(date: Date, days: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

function toISODate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Today's date as YYYY-MM-DD (local time-zone agnostic — uses UTC) */
export function todayISO(): string {
  return toISODate(new Date());
}
