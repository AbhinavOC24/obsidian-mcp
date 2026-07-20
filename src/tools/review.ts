import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db/schema.js";
import type { QuestionRow } from "../db/schema.js";
import { calculateNextReview, parseGrade, todayISO } from "../db/sm2.js";
import { topicSearch } from "../vault/search.js";

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerReviewTools(server: McpServer): void {
  const db = getDb();

  // ── get_due_questions ──────────────────────────────────────────────────────

  server.registerTool(
    "get_due_questions",
    {
      title: "Get Due Questions",
      description:
        "Return questions scheduled for review today (SM-2 due date ≤ today), " +
        "optionally filtered by topic/tag and limited in count.",
      inputSchema: {
        topic: z
          .string()
          .optional()
          .describe("Filter by topic: only questions whose note_path contains notes tagged/matched to this topic"),
        limit: z.number().int().min(1).max(100).default(20).describe("Max questions to return"),
      },
    },
    async ({ topic, limit }) => {
      const today = todayISO();
      let rows: QuestionRow[];

      if (topic) {
        // Get note paths relevant to the topic
        const topicNotes = await topicSearch(topic, 30);
        const notePaths = topicNotes.map((n) => n.path);

        if (notePaths.length === 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ topic, due_today: 0, questions: [], message: "No notes found for topic." }, null, 2),
              },
            ],
          };
        }

        const placeholders = notePaths.map(() => "?").join(",");
        rows = db
          .prepare(
            `SELECT * FROM questions
             WHERE due_date <= ?
               AND note_path IN (${placeholders})
             ORDER BY due_date ASC, ease_factor ASC
             LIMIT ?`
          )
          .all(today, ...notePaths, limit ?? 20) as QuestionRow[];
      } else {
        rows = db
          .prepare(
            `SELECT * FROM questions
             WHERE due_date <= ?
             ORDER BY due_date ASC, ease_factor ASC
             LIMIT ?`
          )
          .all(today, limit ?? 20) as QuestionRow[];
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                date: today,
                topic: topic ?? null,
                due_today: rows.length,
                questions: rows.map((q) => ({
                  id: q.id,
                  note_path: q.note_path,
                  question: q.question_text,
                  answer: q.answer_text,
                  ease_factor: q.ease_factor,
                  interval_days: q.interval_days,
                  review_count: q.review_count,
                  due_date: q.due_date,
                  last_reviewed: q.last_reviewed,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── submit_review ──────────────────────────────────────────────────────────

  server.registerTool(
    "submit_review",
    {
      title: "Submit Review",
      description:
        "Record the result of reviewing a question and update its SM-2 schedule. " +
        "Grade: again (0), hard (1), good (2), easy (3).",
      inputSchema: {
        question_id: z.number().int().describe("ID of the question being reviewed"),
        grade: z
          .union([z.enum(["again", "hard", "good", "easy"]), z.enum(["0", "1", "2", "3"])])
          .describe("Self-rated recall grade: again | hard | good | easy (or 0–3)"),
      },
    },
    async ({ question_id, grade }) => {
      const q = db.prepare("SELECT * FROM questions WHERE id = ?").get(question_id) as QuestionRow | undefined;
      if (!q) {
        return {
          content: [{ type: "text" as const, text: `Question ${question_id} not found.` }],
          isError: true,
        };
      }

      const numericGrade = parseGrade(grade);
      const next = calculateNextReview(
        {
          easeFactor: q.ease_factor,
          intervalDays: q.interval_days,
          dueDate: q.due_date,
          reviewCount: q.review_count,
        },
        numericGrade
      );

      db.prepare(
        `UPDATE questions
         SET ease_factor   = ?,
             interval_days = ?,
             due_date      = ?,
             last_reviewed = ?,
             review_count  = ?
         WHERE id = ?`
      ).run(next.easeFactor, next.intervalDays, next.dueDate, new Date().toISOString(), next.reviewCount, question_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                question_id,
                grade,
                next_review: next.dueDate,
                interval_days: next.intervalDays,
                ease_factor: next.easeFactor,
                review_count: next.reviewCount,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── get_topic_mastery ──────────────────────────────────────────────────────

  server.registerTool(
    "get_topic_mastery",
    {
      title: "Get Topic Mastery",
      description:
        "Aggregate review statistics for a topic: question counts, average ease, weak areas, overdue.",
      inputSchema: {
        topic: z.string().describe("Topic or tag to analyse"),
      },
    },
    async ({ topic }) => {
      // Get note paths relevant to topic
      const topicNotes = await topicSearch(topic, 50);
      const notePaths = topicNotes.map((n) => n.path);

      if (notePaths.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ topic, message: "No notes found for topic." }, null, 2),
            },
          ],
        };
      }

      const placeholders = notePaths.map(() => "?").join(",");
      const questions = db
        .prepare(`SELECT * FROM questions WHERE note_path IN (${placeholders})`)
        .all(...notePaths) as QuestionRow[];

      const today = todayISO();
      const total = questions.length;
      const reviewed = questions.filter((q) => q.review_count > 0);
      const overdue = questions.filter((q) => q.due_date < today);
      const dueToday = questions.filter((q) => q.due_date <= today);

      const avgEase =
        reviewed.length > 0
          ? reviewed.reduce((s, q) => s + q.ease_factor, 0) / reviewed.length
          : 0;

      // Weak: low ease factor (< 2.0) or many reviews still needed
      const weak = questions
        .filter((q) => q.ease_factor < 2.0 && q.review_count > 0)
        .sort((a, b) => a.ease_factor - b.ease_factor)
        .slice(0, 5);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                topic,
                notes_found: topicNotes.length,
                questions: {
                  total,
                  reviewed: reviewed.length,
                  never_reviewed: total - reviewed.length,
                  due_today: dueToday.length,
                  overdue: overdue.length,
                  avg_ease_factor: parseFloat(avgEase.toFixed(3)),
                },
                weak_areas: weak.map((q) => ({
                  id: q.id,
                  note_path: q.note_path,
                  question: q.question_text,
                  ease_factor: q.ease_factor,
                  review_count: q.review_count,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── cross_question ─────────────────────────────────────────────────────────

  server.registerTool(
    "cross_question",
    {
      title: "Cross Question",
      description:
        'Quiz-me entry point. Returns the most relevant notes for a topic AND due questions for it. ' +
        'The MCP client\'s LLM then uses this data to quiz the user, generate follow-up questions, ' +
        'and calls submit_review / add_questions to track results.',
      inputSchema: {
        topic: z.string().describe("Topic to be quizzed on"),
        depth: z
          .enum(["shallow", "medium", "deep"])
          .default("medium")
          .describe("How many notes/questions to surface (shallow=3, medium=7, deep=15)"),
      },
    },
    async ({ topic, depth }) => {
      const noteLimit = depth === "shallow" ? 3 : depth === "deep" ? 15 : 7;
      const qLimit = depth === "shallow" ? 5 : depth === "deep" ? 25 : 12;

      // Get relevant notes
      const topicNotes = await topicSearch(topic, noteLimit);

      // Get due questions
      const notePaths = topicNotes.map((n) => n.path);
      let dueQuestions: QuestionRow[] = [];

      if (notePaths.length > 0) {
        const placeholders = notePaths.map(() => "?").join(",");
        dueQuestions = db
          .prepare(
            `SELECT * FROM questions
             WHERE note_path IN (${placeholders}) AND due_date <= date('now')
             ORDER BY ease_factor ASC, due_date ASC
             LIMIT ?`
          )
          .all(...notePaths, qLimit) as QuestionRow[];
      }

      // Fetch full content for top 3 notes (to give LLM context to generate questions from)
      const noteSummaries = topicNotes.slice(0, noteLimit).map((n) => ({
        path: n.path,
        title: n.title,
        tags: n.tags,
        snippet: n.snippet,
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                topic,
                depth,
                instructions:
                  "Use the notes and due_questions below to quiz the user on this topic. " +
                  "For each due question: ask it, wait for the user's answer, then call submit_review with the grade. " +
                  "For notes with no questions, generate new questions from the content and call add_questions to store them. " +
                  "Use get_note to fetch full content of any note.",
                notes_found: topicNotes.length,
                notes: noteSummaries,
                due_questions: dueQuestions.length,
                questions: dueQuestions.map((q) => ({
                  id: q.id,
                  note_path: q.note_path,
                  question: q.question_text,
                  answer_hint: q.answer_text,
                  ease_factor: q.ease_factor,
                  review_count: q.review_count,
                })),
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
