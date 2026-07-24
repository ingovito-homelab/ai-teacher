import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { questionHash } from './db.js'

export const titleFromSlug = (slug) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

// Recursively collect topic ids ("java/core", ...) relative to dataDir.
// Files/dirs starting with "_" or "." are metadata/work files, never topics.
async function listTopicIds(dir, prefix = '') {
  const ids = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      ids.push(...(await listTopicIds(path.join(dir, entry.name), `${prefix}${entry.name}/`)))
    } else if (entry.name.endsWith('.json')) {
      ids.push(`${prefix}${entry.name.replace(/\.json$/, '')}`)
    }
  }
  return ids
}

async function subjectTitle(dataDir, subjectId) {
  try {
    const meta = JSON.parse(
      await readFile(path.join(dataDir, subjectId, '_subject.json'), 'utf-8')
    )
    if (meta.title) return meta.title
  } catch {
    // no metadata file — derive from the slug
  }
  return titleFromSlug(subjectId)
}

const nextQid = (takenQids) => {
  let n = 0
  for (const qid of takenQids) {
    const m = /^q(\d+)$/.exec(qid)
    if (m) n = Math.max(n, Number(m[1]))
  }
  return `q${n + 1}`
}

// SQLite datetime string ('YYYY-MM-DD HH:MM:SS.mmm') for "now".
const sqliteNow = () => new Date().toISOString().replace('T', ' ').replace('Z', '')

// Convert a legacy ISO timestamp (this fork's old file-based server stamped
// `answeredAt` on questions, for the activity dashboard) to the same SQLite
// datetime format, so migrated questions keep their real answering date
// instead of collapsing onto the import date.
function sqliteDatetime(iso) {
  if (typeof iso !== 'string' || Number.isNaN(Date.parse(iso))) return null
  return new Date(iso).toISOString().replace('T', ' ').replace('Z', '')
}

/**
 * Import seed JSON files from dataDir into the DB.
 *
 * Seeds are `data/<subject>/<topic>.json` with `{ title, description?, questions }`;
 * each entry in `questions` is either a plain string or an object with a
 * `question` field. Existing questions are recognized by a content hash of the
 * question text, so re-running the import never duplicates anything.
 *
 * With `withState: true` (one-off legacy migration) newly inserted questions
 * also carry over answer/evaluation/followUp/assistRequired/hidden/explanation
 * from the old full-schema topic files.
 */
export async function importSeeds(db, dataDir, { withState = false } = {}) {
  const stats = { topics: 0, inserted: 0, skipped: 0 }
  const now = sqliteNow()

  const upsertSubject = db.prepare(
    `INSERT INTO subjects (id, title) VALUES (?, ?)
     ON CONFLICT(id) DO UPDATE SET title = excluded.title`
  )
  const upsertTopic = db.prepare(
    `INSERT INTO topics (id, subject_id, title, description) VALUES (?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       subject_id = excluded.subject_id,
       title = excluded.title,
       description = excluded.description`
  )
  const insertQuestion = db.prepare(
    `INSERT INTO questions (
       topic_id, qid, type, question, question_hash, options, correct,
       answer, eval_score, eval_verdict, eval_feedback, follow_up,
       explanation, assist_required, hidden, answered_at, evaluated_at
     ) VALUES (
       @topicId, @qid, @type, @question, @hash, @options, @correct,
       @answer, @score, @verdict, @feedback, @followUp,
       @explanation, @assist, @hidden, @answeredAt, @evaluatedAt
     )`
  )
  const existing = db.prepare(
    'SELECT qid, question_hash FROM questions WHERE topic_id = ?'
  )

  for (const topicId of await listTopicIds(dataDir)) {
    let seed
    try {
      seed = JSON.parse(await readFile(path.join(dataDir, `${topicId}.json`), 'utf-8'))
    } catch {
      continue // skip malformed files, like the old server did
    }
    stats.topics++

    const subjectId = topicId.includes('/') ? topicId.split('/')[0] : null
    if (subjectId) upsertSubject.run(subjectId, await subjectTitle(dataDir, subjectId))
    const slug = topicId.split('/').pop()
    upsertTopic.run(topicId, subjectId, seed.title ?? titleFromSlug(slug), seed.description ?? null)

    const rows = existing.all(topicId)
    const knownHashes = new Set(rows.map((r) => r.question_hash))
    const takenQids = new Set(rows.map((r) => r.qid))

    for (const entry of seed.questions ?? []) {
      const q = typeof entry === 'string' ? { question: entry } : entry
      if (typeof q.question !== 'string' || !q.question.trim()) continue

      // Multiselect quiz entries: {type:'quiz', question, options:[...], correct:[indices]}.
      // Malformed quizzes are skipped like any other malformed entry.
      const isQuiz = q.type === 'quiz'
      let options = null
      let correct = null
      if (isQuiz) {
        options = Array.isArray(q.options)
          ? q.options.filter((o) => typeof o === 'string' && o.trim())
          : []
        correct = Array.isArray(q.correct)
          ? [...new Set(q.correct)].filter((i) => Number.isInteger(i) && i >= 0 && i < options.length)
          : []
        if (options.length < 2 || !correct.length) continue
      }

      // Quiz identity includes the options: the same stem ("Which of these are
      // true about X?") may legitimately recur with a different option set.
      const hash = questionHash(isQuiz ? [q.question, ...options].join('\n') : q.question)
      if (knownHashes.has(hash)) {
        stats.skipped++
        continue
      }
      const qid = q.id && !takenQids.has(q.id) ? q.id : nextQid(takenQids)
      const state = withState ? q : {}
      const answer = typeof state.answer === 'string' ? state.answer : ''
      insertQuestion.run({
        topicId,
        qid,
        type: isQuiz ? 'quiz' : 'open',
        question: q.question,
        hash,
        options: isQuiz ? JSON.stringify(options) : null,
        correct: isQuiz ? JSON.stringify(correct.sort((a, b) => a - b)) : null,
        answer,
        score: state.evaluation?.score ?? null,
        verdict: state.evaluation?.verdict ?? null,
        feedback: state.evaluation?.feedback ?? null,
        followUp: state.followUp ?? null,
        explanation: state.explanation ?? null,
        assist: state.assistRequired ? 1 : 0,
        hidden: state.hidden ? 1 : 0,
        answeredAt: answer.trim() ? (sqliteDatetime(state.answeredAt) ?? now) : null,
        evaluatedAt: state.evaluation ? now : null,
      })
      knownHashes.add(hash)
      takenQids.add(qid)
      stats.inserted++
    }
  }
  return stats
}
