import cors from "cors";
import crypto from "crypto";
import express from "express";
import rateLimit from "express-rate-limit";
import { pool } from "./db";

const app = express();
const port = Number(process.env.PORT || 3001);

app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 300,
    standardHeaders: true,
    legacyHeaders: false
  })
);

const asyncHandler =
  (
    handler: (
      req: express.Request,
      res: express.Response,
      next: express.NextFunction
    ) => Promise<void>
  ) =>
  (req: express.Request, res: express.Response, next: express.NextFunction) => {
    handler(req, res, next).catch(next);
  };

const toNumber = (value: unknown) => {
  const parsed = Number(value);
  return Number.isNaN(parsed) ? 0 : parsed;
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

const isValidTimestamp = (value: string) => !Number.isNaN(Date.parse(value));

const parseNonNegativeNumber = (value: unknown) => {
  if (value === undefined || value === null) {
    return null;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    return null;
  }
  return parsed;
};

type AdminUserRow = {
  user_id: string;
  name: string;
  answered_count: number | string;
  last_session_id: string | null;
};

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.post(
  "/sessions",
  asyncHandler(async (req, res) => {
    const { user_id, person_name, session_id, started_at, total_active_ms } =
      req.body || {};
    if (
      !isNonEmptyString(user_id) ||
      !isNonEmptyString(person_name) ||
      !isNonEmptyString(session_id) ||
      !isNonEmptyString(started_at)
    ) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }
    const normalizedStartedAt = started_at.trim();
    if (!isValidTimestamp(normalizedStartedAt)) {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }
    const totalActiveMs = parseNonNegativeNumber(total_active_ms);
    if (total_active_ms !== undefined && totalActiveMs === null) {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }

    const normalizedUserId = user_id.trim();
    const normalizedPersonName = person_name.trim();
    const normalizedSessionId = session_id.trim();
    const initialActiveMs = totalActiveMs ?? 0;

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO users (user_id, display_name) VALUES ($1, $2) ON CONFLICT (user_id) DO UPDATE SET display_name = EXCLUDED.display_name",
        [normalizedUserId, normalizedPersonName]
      );
      await client.query(
        "INSERT INTO sessions (session_id, user_id, started_at, total_active_ms) VALUES ($1, $2, $3, $4) ON CONFLICT (session_id) DO UPDATE SET user_id = EXCLUDED.user_id, started_at = EXCLUDED.started_at, total_active_ms = GREATEST(sessions.total_active_ms, EXCLUDED.total_active_ms)",
        [
          normalizedSessionId,
          normalizedUserId,
          normalizedStartedAt,
          initialActiveMs
        ]
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    res.json({ session_id: normalizedSessionId });
  })
);

app.get(
  "/sessions/:id",
  asyncHandler(async (req, res) => {
    const sessionId = req.params.id;
    const { rows } = await pool.query(
      "SELECT session_id, user_id, started_at, ended_at, total_active_ms FROM sessions WHERE session_id = $1",
      [sessionId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.json(rows[0]);
  })
);

app.get(
  "/progress",
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const { rows } = await pool.query(
      "SELECT s.session_id, COALESCE(SUM(CASE WHEN a.skipped THEN 0 ELSE 1 END), 0) AS answered_count, MAX(s.total_active_ms) AS total_active_ms FROM sessions s LEFT JOIN answers a ON a.session_id = s.session_id WHERE s.session_id = $1 GROUP BY s.session_id",
      [sessionId]
    );

    if (rows.length === 0) {
      res.status(404).json({ error: "not_found" });
      return;
    }

    res.json({
      answered_count: toNumber(rows[0].answered_count),
      total_active_ms: toNumber(rows[0].total_active_ms)
    });
  })
);

app.post(
  "/answers",
  asyncHandler(async (req, res) => {
    const {
      reponse_id,
      user_id,
      session_id,
      question_id,
      section_id,
      question_text,
      selected_option,
      free_text,
      reponse,
      timestamp,
      skipped,
      total_active_ms
    } = req.body || {};

    if (
      !isNonEmptyString(reponse_id) ||
      !isNonEmptyString(user_id) ||
      !isNonEmptyString(session_id) ||
      !isNonEmptyString(question_id) ||
      !isNonEmptyString(section_id) ||
      !isNonEmptyString(question_text) ||
      !isNonEmptyString(timestamp)
    ) {
      res.status(400).json({ error: "missing_fields" });
      return;
    }

    const normalizedTimestamp = timestamp.trim();
    if (!isValidTimestamp(normalizedTimestamp)) {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }

    if (
      selected_option !== undefined &&
      selected_option !== null &&
      typeof selected_option !== "string"
    ) {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }
    if (free_text !== undefined && free_text !== null && typeof free_text !== "string") {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }
    if (reponse !== undefined && reponse !== null && typeof reponse !== "string") {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }
    if (skipped !== undefined && typeof skipped !== "boolean") {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }

    const normalizedReponseId = reponse_id.trim();
    const normalizedUserId = user_id.trim();
    const normalizedSessionId = session_id.trim();
    const normalizedQuestionId = question_id.trim();
    const normalizedSectionId = section_id.trim();
    const normalizedQuestionText = question_text.trim();
    const responseText = typeof reponse === "string" ? reponse : "";
    const freeTextValue = typeof free_text === "string" ? free_text : "";
    const selectedOptionValue =
      typeof selected_option === "string" ? selected_option : null;
    const skippedValue = Boolean(skipped);
    const totalActiveMs = parseNonNegativeNumber(total_active_ms);
    if (total_active_ms !== undefined && totalActiveMs === null) {
      res.status(400).json({ error: "invalid_fields" });
      return;
    }

    if (freeTextValue.length > 200) {
      res.status(400).json({ error: "free_text_too_long" });
      return;
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(
        "INSERT INTO questions (question_id, section_id, question_text) VALUES ($1, $2, $3) ON CONFLICT (question_id) DO UPDATE SET section_id = EXCLUDED.section_id, question_text = EXCLUDED.question_text",
        [normalizedQuestionId, normalizedSectionId, normalizedQuestionText]
      );
      await client.query(
        "INSERT INTO answers (reponse_id, user_id, session_id, question_id, section_id, question_text, reponse, selected_option, free_text, skipped, timestamp) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) ON CONFLICT (reponse_id) DO NOTHING",
        [
          normalizedReponseId,
          normalizedUserId,
          normalizedSessionId,
          normalizedQuestionId,
          normalizedSectionId,
          normalizedQuestionText,
          responseText,
          selectedOptionValue,
          freeTextValue,
          skippedValue,
          normalizedTimestamp
        ]
      );
      if (totalActiveMs !== null) {
        await client.query(
          "UPDATE sessions SET total_active_ms = GREATEST(total_active_ms, $1) WHERE session_id = $2",
          [totalActiveMs, normalizedSessionId]
        );
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }

    res.status(201).json({ ok: true });
  })
);

app.get(
  "/recap",
  asyncHandler(async (req, res) => {
    const sessionId = String(req.query.session_id || "");
    if (!sessionId) {
      res.status(400).json({ error: "missing_session_id" });
      return;
    }

    const { rows } = await pool.query(
      "SELECT reponse_id, user_id, session_id, question_id, section_id, question_text, reponse, selected_option, free_text, skipped, timestamp FROM answers WHERE session_id = $1 ORDER BY timestamp ASC",
      [sessionId]
    );

    res.json({ answers: rows });
  })
);

app.get(
  "/admin/users",
  asyncHandler(async (_req, res) => {
    const { rows } = await pool.query(
      "SELECT u.user_id, u.display_name AS name, COALESCE(COUNT(a.*) FILTER (WHERE a.skipped = false), 0) AS answered_count, (SELECT s.session_id FROM sessions s WHERE s.user_id = u.user_id ORDER BY s.started_at DESC LIMIT 1) AS last_session_id FROM users u LEFT JOIN answers a ON a.user_id = u.user_id GROUP BY u.user_id, u.display_name ORDER BY u.display_name"
    );

    res.json(
      (rows as AdminUserRow[]).map((row) => ({
        ...row,
        answered_count: toNumber(row.answered_count)
      }))
    );
  })
);

app.get(
  "/admin/users/:id/questions",
  asyncHandler(async (req, res) => {
    const userId = req.params.id;
    const { rows } = await pool.query(
      "SELECT DISTINCT a.question_id, COALESCE(a.question_text, q.question_text) AS question_text FROM answers a LEFT JOIN questions q ON q.question_id = a.question_id WHERE a.user_id = $1 ORDER BY a.question_id",
      [userId]
    );

    res.json(rows);
  })
);

app.post(
  "/admin/pairings",
    asyncHandler(async (req, res) => {
      const { user_id_a, user_id_b, session_id } = req.body || {};
      if (!isNonEmptyString(user_id_a) || !isNonEmptyString(user_id_b)) {
        res.status(400).json({ error: "missing_fields" });
        return;
      }
      if (
        session_id !== undefined &&
        session_id !== null &&
        !isNonEmptyString(session_id)
      ) {
        res.status(400).json({ error: "invalid_fields" });
        return;
      }

      const normalizedUserA = user_id_a.trim();
      const normalizedUserB = user_id_b.trim();
      const normalizedSessionId = isNonEmptyString(session_id)
        ? session_id.trim()
        : null;

      if (normalizedUserA === normalizedUserB) {
        res.status(400).json({ error: "same_user_pairing" });
        return;
      }

    const pairingId =
      typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `pair-${Date.now()}-${Math.floor(Math.random() * 1000000)}`;

      await pool.query(
        "INSERT INTO pairings (pairing_id, user_id_a, user_id_b, session_id) VALUES ($1, $2, $3, $4)",
        [pairingId, normalizedUserA, normalizedUserB, normalizedSessionId]
      );

    res.status(201).json({ pairing_id: pairingId });
  })
);

app.use((error: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error(error);
  res.status(500).json({ error: "server_error" });
});

app.listen(port, () => {
  console.log(`RD Reponses backend running on ${port}`);
});
