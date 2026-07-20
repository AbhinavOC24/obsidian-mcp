import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getDb } from "../db/schema.js";
import type { QuestionRow } from "../db/schema.js";
import { todayISO } from "../db/sm2.js";

// ─── Tool registration ────────────────────────────────────────────────────────

export function registerQuestionTools(server: McpServer): void {
  const db = getDb();

  // ── add_questions ──────────────────────────────────────────────────────────

  server.registerTool(
    "add_questions",
    {
      title: "Add Questions",
      description:
        "Store a set of questions (generated client-side by the LLM) for a given note. " +
        "The server schedules them for spaced-repetition review using SM-2.",
      inputSchema: {
        note_path: z
          .string()
          .describe("Relative path of the note these questions are about (e.g. 'Projects/MyNote.md')"),
        questions: z
          .array(
            z.object({
              question_text: z.string().min(1).describe("The question to ask"),
              answer_text: z
                .string()
                .default("")
                .describe("Expected answer or key points (can be empty — reviewed as open-ended)"),
            })
          )
          .min(1)
          .describe("List of questions to add"),
      },
    },
    async ({ note_path, questions }) => {
      const insert = db.prepare(`
        INSERT INTO questions (note_path, question_text, answer_text, due_date)
        VALUES (?, ?, ?, ?)
      `);

      const insertMany = db.transaction((qs: typeof questions) => {
        for (const q of qs) {
          insert.run(note_path, q.question_text, q.answer_text, todayISO());
        }
      });

      insertMany(questions);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                success: true,
                note_path,
                added: questions.length,
                message: `Added ${questions.length} question(s) for "${note_path}". They are due today.`,
              },
              null,
              2
            ),
          },
        ],
      };
    }
  );

  // ── list_questions ─────────────────────────────────────────────────────────

  server.registerTool(
    "list_questions",
    {
      title: "List Questions",
      description: "List all stored questions, optionally filtered by note path.",
      inputSchema: {
        note_path: z.string().optional().describe("Filter to a specific note path"),
        limit: z.number().int().min(1).max(200).default(50),
      },
    },
    async ({ note_path, limit }) => {
      let rows: QuestionRow[];
      if (note_path) {
        rows = db
          .prepare("SELECT * FROM questions WHERE note_path = ? ORDER BY due_date LIMIT ?")
          .all(note_path, limit ?? 50) as QuestionRow[];
      } else {
        rows = db
          .prepare("SELECT * FROM questions ORDER BY due_date LIMIT ?")
          .all(limit ?? 50) as QuestionRow[];
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ count: rows.length, questions: rows }, null, 2),
          },
        ],
      };
    }
  );

  // ── delete_question ────────────────────────────────────────────────────────

  server.registerTool(
    "delete_question",
    {
      title: "Delete Question",
      description: "Remove a question from the review queue.",
      inputSchema: {
        question_id: z.number().int().describe("ID of the question to delete"),
      },
    },
    async ({ question_id }) => {
      const info = db.prepare("DELETE FROM questions WHERE id = ?").run(question_id);
      const deleted = info.changes > 0;

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { success: deleted, question_id, message: deleted ? "Question deleted." : "Question not found." },
              null,
              2
            ),
          },
        ],
      };
    }
  );
}
