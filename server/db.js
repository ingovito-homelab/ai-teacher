import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
import { parseScore } from '../src/score.js'

// Millisecond-precision UTC timestamp; lexicographic order == chronological order.
const NOW = "strftime('%Y-%m-%d %H:%M:%f', 'now')"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS subjects (
  id    TEXT PRIMARY KEY,
  title TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS topics (
  id          TEXT PRIMARY KEY,
  subject_id  TEXT REFERENCES subjects(id),
  title       TEXT NOT NULL,
  description TEXT
);

CREATE TABLE IF NOT EXISTS questions (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  topic_id        TEXT NOT NULL REFERENCES topics(id),
  qid             TEXT NOT NULL,
  type            TEXT NOT NULL DEFAULT 'open',
  question        TEXT NOT NULL,
  question_hash   TEXT NOT NULL,
  options         TEXT,
  correct         TEXT,
  answer          TEXT NOT NULL DEFAULT '',
  eval_score      TEXT,
  eval_verdict    TEXT,
  eval_feedback   TEXT,
  follow_up       TEXT,
  explanation     TEXT,
  assist_required INTEGER NOT NULL DEFAULT 0,
  assist_mode     TEXT,
  assist_context  TEXT,
  hidden          INTEGER NOT NULL DEFAULT 0,
  answered_at     TEXT,
  evaluated_at    TEXT,
  UNIQUE(topic_id, qid),
  UNIQUE(topic_id, question_hash)
);
`

export function openDb(file) {
  const db = new DatabaseSync(file)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(SCHEMA)
  migrate(db)
  return db
}

// CREATE TABLE IF NOT EXISTS never alters an existing table, so columns added
// after the first release must be bolted on here.
function migrate(db) {
  const columns = new Set(db.prepare('PRAGMA table_info(questions)').all().map((c) => c.name))
  if (!columns.has('type')) {
    db.exec("ALTER TABLE questions ADD COLUMN type TEXT NOT NULL DEFAULT 'open'")
  }
  if (!columns.has('options')) db.exec('ALTER TABLE questions ADD COLUMN options TEXT')
  if (!columns.has('correct')) db.exec('ALTER TABLE questions ADD COLUMN correct TEXT')
  if (!columns.has('assist_mode')) db.exec('ALTER TABLE questions ADD COLUMN assist_mode TEXT')
  if (!columns.has('assist_context')) db.exec('ALTER TABLE questions ADD COLUMN assist_context TEXT')
}

// Dedup key for a question: whitespace- and case-insensitive content hash.
export function questionHash(text) {
  const normalized = String(text).trim().replace(/\s+/g, ' ').toLowerCase()
  return createHash('sha256').update(normalized).digest('hex')
}

const hasEvaluation = (row) =>
  row.eval_score != null || row.eval_verdict != null || row.eval_feedback != null

// Rebuild the exact question shape the JSON files used, so the API contract
// (and the Vue client) stays unchanged. Quiz questions additionally carry
// type + options; the correct answers never leave the server through this API.
function toApiQuestion(row) {
  const q = {
    id: row.qid,
    question: row.question,
    answer: row.answer,
    evaluation: hasEvaluation(row)
      ? { score: row.eval_score, verdict: row.eval_verdict, feedback: row.eval_feedback }
      : null,
    followUp: row.follow_up,
  }
  if (row.type === 'quiz') {
    q.type = 'quiz'
    q.options = JSON.parse(row.options ?? '[]')
  }
  if (row.assist_required) q.assistRequired = true
  if (row.hidden) q.hidden = true
  if (row.explanation != null) q.explanation = row.explanation
  return q
}

function topicRow(db, id) {
  return db
    .prepare(
      `SELECT t.id, t.title, t.description, t.subject_id AS subject, s.title AS subjectTitle
       FROM topics t LEFT JOIN subjects s ON s.id = t.subject_id
       WHERE t.id = ?`
    )
    .get(id)
}

function questionRows(db, topicId) {
  return db.prepare('SELECT * FROM questions WHERE topic_id = ? ORDER BY id').all(topicId)
}

export function getSection(db, id) {
  const topic = topicRow(db, id)
  if (!topic) return null
  const section = {
    id: topic.id,
    title: topic.title,
    questions: questionRows(db, id).map(toApiQuestion),
    subject: topic.subject ?? null,
    subjectTitle: topic.subjectTitle ?? null,
  }
  if (topic.description != null) section.description = topic.description
  return section
}

export function listSections(db) {
  const topics = db
    .prepare(
      `SELECT t.id, t.title, t.subject_id AS subject, s.title AS subjectTitle
       FROM topics t LEFT JOIN subjects s ON s.id = t.subject_id`
    )
    .all()
  const sections = topics.map((t) => {
    const rows = questionRows(db, t.id)
    const scores = rows
      .map((r) => parseScore(r.eval_score))
      .filter((s) => s != null && Number.isFinite(s))
    return {
      id: t.id,
      subject: t.subject ?? null,
      subjectTitle: t.subjectTitle ?? null,
      title: t.title ?? t.id,
      total: rows.length,
      answered: rows.filter((r) => r.answer.trim()).length,
      evaluated: rows.filter(hasEvaluation).length,
      followUps: rows.filter((r) => r.follow_up).length,
      scored: scores.length,
      avgScore: scores.length
        ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
        : null,
    }
  })
  sections.sort(
    (a, b) =>
      (a.subjectTitle ?? '').localeCompare(b.subjectTitle ?? '') ||
      a.title.localeCompare(b.title)
  )
  return sections
}

// Activity feed: every answered_at timestamp across all topics, bucketed by
// day and month, so the dashboard can chart answering activity over time.
export function getActivity(db) {
  const rows = db
    .prepare("SELECT substr(answered_at, 1, 10) AS day FROM questions WHERE answered_at IS NOT NULL")
    .all()
  const days = new Map()
  const months = new Map()
  for (const { day } of rows) {
    if (!day) continue
    days.set(day, (days.get(day) ?? 0) + 1)
    const month = day.slice(0, 7)
    months.set(month, (months.get(month) ?? 0) + 1)
  }
  const toSorted = (m) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }))
  return { days: toSorted(days), months: toSorted(months) }
}

// Merge answers only (map of qid -> text). answered_at bumps only when the
// text actually changed, so a no-op "Save answers" never re-queues a question
// for evaluation; clearing an answer clears answered_at.
export function saveAnswers(db, topicId, answers) {
  const stmt = db.prepare(
    `UPDATE questions SET
       answer = @answer,
       answered_at = CASE
         WHEN @answer = answer THEN answered_at
         WHEN trim(@answer) = '' THEN NULL
         ELSE ${NOW}
       END
     WHERE topic_id = @topicId AND qid = @qid`
  )
  for (const [qid, answer] of Object.entries(answers)) {
    if (typeof answer !== 'string') continue
    stmt.run({ topicId, qid, answer })
  }
}

export function clearLowScores(db, topicId, threshold) {
  const clearedIds = questionRows(db, topicId)
    .filter((r) => {
      const score = parseScore(r.eval_score)
      return score != null && score < threshold
    })
    .map((r) => r.qid)
  const stmt = db.prepare(
    `UPDATE questions SET
       answer = '', eval_score = NULL, eval_verdict = NULL, eval_feedback = NULL,
       follow_up = NULL, answered_at = NULL, evaluated_at = NULL
     WHERE topic_id = ? AND qid = ?`
  )
  for (const qid of clearedIds) stmt.run(topicId, qid)
  return clearedIds
}

// Toggling assist ON clears any previous explanation: the user is asking for a
// (new) explanation, and "assist on + no explanation yet" is what marks the
// question as pending for the evaluator.
export function setAssistRequired(db, topicId, qid, assistRequired) {
  const result = assistRequired
    ? db
        .prepare(
          `UPDATE questions SET assist_required = 1, explanation = NULL,
             assist_mode = NULL, assist_context = NULL WHERE topic_id = ? AND qid = ?`
        )
        .run(topicId, qid)
    : db
        .prepare(
          `UPDATE questions SET assist_required = 0, assist_mode = NULL, assist_context = NULL
             WHERE topic_id = ? AND qid = ?`
        )
        .run(topicId, qid)
  return result.changes > 0
}

// Ask the evaluator to touch up an existing explanation rather than replace it
// wholesale: 'examples' adds more concrete examples, 'expand' goes deeper
// (optionally steered by free-text context). Unlike setAssistRequired(true),
// this keeps the current explanation visible until the evaluator overwrites it.
export function requestExplanationUpdate(db, topicId, qid, mode, context) {
  const result = db
    .prepare(
      `UPDATE questions SET assist_required = 1, assist_mode = @mode, assist_context = @context
         WHERE topic_id = @topicId AND qid = @qid`
    )
    .run({ topicId, qid, mode, context: context || null })
  return result.changes > 0
}

// Remove a question's agent-written HTML explanation, keeping everything else.
export function clearExplanation(db, topicId, qid) {
  const result = db
    .prepare('UPDATE questions SET explanation = NULL WHERE topic_id = ? AND qid = ?')
    .run(topicId, qid)
  return result.changes > 0
}

export function setHidden(db, topicId, hidden, threshold) {
  const rows = questionRows(db, topicId)
  const changedIds = []
  const stmt = db.prepare('UPDATE questions SET hidden = ? WHERE topic_id = ? AND qid = ?')
  for (const r of rows) {
    if (hidden) {
      const score = parseScore(r.eval_score)
      if (score != null && score >= threshold && !r.hidden) {
        stmt.run(1, topicId, r.qid)
        changedIds.push(r.qid)
      }
    } else if (r.hidden) {
      stmt.run(0, topicId, r.qid)
      changedIds.push(r.qid)
    }
  }
  return changedIds
}

// A question is pending evaluation when it has an answer newer than its last
// evaluation, or the user requested assist and no explanation was written yet.
export function pendingQuestions(db) {
  return db
    .prepare(
      `SELECT t.id AS topic, t.title AS topicTitle, s.title AS subjectTitle,
              q.qid, q.type, q.question, q.options, q.correct, q.answer,
              q.eval_score, q.eval_verdict, q.eval_feedback,
              q.follow_up, q.assist_required, q.assist_mode, q.assist_context, q.explanation
       FROM questions q
       JOIN topics t ON t.id = q.topic_id
       LEFT JOIN subjects s ON s.id = t.subject_id
       WHERE (trim(q.answer) <> ''
              AND q.answered_at IS NOT NULL
              AND (q.evaluated_at IS NULL OR q.answered_at > q.evaluated_at))
          OR (q.assist_required = 1 AND (q.explanation IS NULL OR q.assist_mode IS NOT NULL))
       ORDER BY t.id, q.id`
    )
    .all()
    .map((r) => {
      const p = {
        topic: r.topic,
        topicTitle: r.topicTitle,
        subjectTitle: r.subjectTitle ?? null,
        qid: r.qid,
        question: r.question,
        answer: r.answer,
        assistRequired: !!r.assist_required,
        previousEvaluation: hasEvaluation(r)
          ? { score: r.eval_score, verdict: r.eval_verdict, feedback: r.eval_feedback }
          : null,
        currentFollowUp: r.follow_up,
      }
      // 'examples' / 'expand' ask the evaluator to touch up the explanation
      // already on the question, so it's exported alongside the request.
      if (r.assist_mode) {
        p.assistMode = r.assist_mode
        if (r.assist_context) p.assistContext = r.assist_context
        if (r.explanation) p.currentExplanation = r.explanation
      }
      // The evaluator (unlike the UI) does get the answer key, so quiz answers
      // can be graded objectively.
      if (r.type === 'quiz') {
        const options = JSON.parse(r.options ?? '[]')
        p.type = 'quiz'
        p.options = options
        p.correctOptions = JSON.parse(r.correct ?? '[]').map((i) => options[i])
      }
      return p
    })
}

// Write one evaluation result back. Only the fields present in the payload are
// touched; evaluated_at is stamped whenever an evaluation object is written.
export function applyEvaluation(db, { topic, qid, evaluation, followUp, explanation }) {
  const sets = []
  const params = { topic, qid }
  if (evaluation) {
    sets.push(
      'eval_score = @score',
      'eval_verdict = @verdict',
      'eval_feedback = @feedback',
      `evaluated_at = ${NOW}`
    )
    params.score = evaluation.score ?? null
    params.verdict = evaluation.verdict ?? null
    params.feedback = evaluation.feedback ?? null
  }
  if (followUp !== undefined) {
    sets.push('follow_up = @followUp')
    params.followUp = followUp
  }
  if (explanation !== undefined) {
    sets.push('explanation = @explanation', 'assist_mode = NULL', 'assist_context = NULL')
    params.explanation = explanation
  }
  if (!sets.length) return false
  const result = db
    .prepare(`UPDATE questions SET ${sets.join(', ')} WHERE topic_id = @topic AND qid = @qid`)
    .run(params)
  return result.changes > 0
}
