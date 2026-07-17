import express from 'express'
import { readFile, writeFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseScore } from './src/score.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const DIST_DIR = path.join(__dirname, 'dist')
const PORT = process.env.PORT || 3000

const app = express()
app.use(express.json({ limit: '4mb' }))

// A section id is the file path relative to DATA_DIR without ".json",
// e.g. "java/parallelism". The first segment is the subject; deeper
// nesting is allowed and just extends the path.
function sectionFile(id) {
  const file = path.normalize(path.join(DATA_DIR, `${id}.json`))
  if (!file.startsWith(DATA_DIR + path.sep) || path.basename(file).startsWith('_')) {
    return null
  }
  return file
}

const titleFromSlug = (slug) =>
  slug.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')

function averageScore(questions) {
  const scores = questions
    .map((q) => parseScore(q.evaluation?.score))
    .filter((s) => s != null && Number.isFinite(s))
  if (!scores.length) return null
  return Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10
}

// Recursively collect section ids ("java/core", ...). Files/dirs starting
// with "_" are metadata, not sections.
async function listSectionIds(dir = DATA_DIR, prefix = '') {
  const ids = []
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('_') || entry.name.startsWith('.')) continue
    if (entry.isDirectory()) {
      ids.push(...(await listSectionIds(path.join(dir, entry.name), `${prefix}${entry.name}/`)))
    } else if (entry.name.endsWith('.json')) {
      ids.push(`${prefix}${entry.name.replace(/\.json$/, '')}`)
    }
  }
  return ids
}

async function subjectTitle(subjectId) {
  try {
    const meta = JSON.parse(await readFile(path.join(DATA_DIR, subjectId, '_subject.json'), 'utf-8'))
    if (meta.title) return meta.title
  } catch {
    // no metadata file — derive from the slug
  }
  return titleFromSlug(subjectId)
}

async function readSection(id) {
  const file = sectionFile(id)
  if (!file) throw new Error('Invalid section id')
  const section = JSON.parse(await readFile(file, 'utf-8'))
  const subjectId = id.includes('/') ? id.split('/')[0] : null
  return {
    ...section,
    id,
    subject: subjectId,
    subjectTitle: subjectId ? await subjectTitle(subjectId) : null,
  }
}

app.get('/api/sections', async (_req, res) => {
  const sections = []
  for (const id of await listSectionIds()) {
    try {
      const s = await readSection(id)
      const questions = s.questions ?? []
      sections.push({
        id,
        subject: s.subject,
        subjectTitle: s.subjectTitle,
        title: s.title ?? id,
        total: questions.length,
        answered: questions.filter((q) => (q.answer ?? '').trim()).length,
        evaluated: questions.filter((q) => q.evaluation).length,
        followUps: questions.filter((q) => q.followUp).length,
        scored: questions.filter((q) => parseScore(q.evaluation?.score) != null).length,
        avgScore: averageScore(questions),
      })
    } catch {
      // skip malformed files
    }
  }
  sections.sort(
    (a, b) =>
      (a.subjectTitle ?? '').localeCompare(b.subjectTitle ?? '') ||
      a.title.localeCompare(b.title)
  )
  res.json(sections)
})

// Activity feed: every answeredAt timestamp across all topics, so the
// dashboard can chart how many questions were answered per day / month.
app.get('/api/activity', async (_req, res) => {
  const days = new Map()   // "YYYY-MM-DD" -> count
  const months = new Map() // "YYYY-MM"    -> count
  for (const id of await listSectionIds()) {
    try {
      const section = JSON.parse(await readFile(sectionFile(id), 'utf-8'))
      for (const q of section.questions ?? []) {
        if (!q.answeredAt) continue
        const day = q.answeredAt.slice(0, 10)
        if (!day || Number.isNaN(Date.parse(q.answeredAt))) continue
        days.set(day, (days.get(day) ?? 0) + 1)
        const month = day.slice(0, 7)
        months.set(month, (months.get(month) ?? 0) + 1)
      }
    } catch {
      // skip malformed files
    }
  }
  const toSorted = (m) =>
    [...m.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count }))
  res.json({ days: toSorted(days), months: toSorted(months) })
})

// :id is the URL-encoded section path, e.g. "java%2Fparallelism"
app.get('/api/sections/:id', async (req, res) => {
  try {
    res.json(await readSection(req.params.id))
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

// Merge answers only; never overwrite agent-written questions/evaluations/follow-ups.
app.put('/api/sections/:id/answers', async (req, res) => {
  const answers = req.body?.answers ?? {}
  const file = sectionFile(req.params.id)
  if (!file) return res.status(400).json({ error: 'Invalid section id' })
  try {
    const section = JSON.parse(await readFile(file, 'utf-8'))
    for (const q of section.questions ?? []) {
      if (Object.prototype.hasOwnProperty.call(answers, q.id)) {
        q.answer = answers[q.id]
        // stamp the first time an answer becomes non-empty; clear when emptied
        if ((q.answer ?? '').trim()) {
          if (!q.answeredAt) q.answeredAt = new Date().toISOString()
        } else {
          delete q.answeredAt
        }
      }
    }
    await writeFile(file, JSON.stringify(section, null, 2) + '\n')
    res.json(await readSection(req.params.id))
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

// Reset questions whose evaluation scored below the threshold (0-10 scale)
// so they can be answered again from scratch.
app.post('/api/sections/:id/clear-low-scores', async (req, res) => {
  const threshold = Number(req.body?.threshold ?? 6)
  if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'Invalid threshold' })
  const file = sectionFile(req.params.id)
  if (!file) return res.status(400).json({ error: 'Invalid section id' })
  try {
    const section = JSON.parse(await readFile(file, 'utf-8'))
    const clearedIds = []
    for (const q of section.questions ?? []) {
      const score = parseScore(q.evaluation?.score)
      if (score != null && score < threshold) {
        q.answer = ''
        q.evaluation = null
        q.followUp = null
        delete q.answeredAt
        clearedIds.push(q.id)
      }
    }
    if (clearedIds.length) await writeFile(file, JSON.stringify(section, null, 2) + '\n')
    res.json({ clearedIds, section: await readSection(req.params.id) })
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

// Toggle a question's "assistRequired" flag — the evaluator skill writes an
// HTML explanation only for flagged questions.
app.put('/api/sections/:id/assist', async (req, res) => {
  const { questionId, assistRequired } = req.body ?? {}
  if (typeof questionId !== 'string' || typeof assistRequired !== 'boolean') {
    return res.status(400).json({ error: 'questionId (string) and assistRequired (boolean) required' })
  }
  const file = sectionFile(req.params.id)
  if (!file) return res.status(400).json({ error: 'Invalid section id' })
  try {
    const section = JSON.parse(await readFile(file, 'utf-8'))
    const q = (section.questions ?? []).find((q) => q.id === questionId)
    if (!q) return res.status(404).json({ error: 'Question not found' })
    if (assistRequired) q.assistRequired = true
    else delete q.assistRequired
    await writeFile(file, JSON.stringify(section, null, 2) + '\n')
    res.json(await readSection(req.params.id))
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

// Remove a question's agent-written HTML explanation from the topic file.
app.delete('/api/sections/:id/explanation', async (req, res) => {
  const { questionId } = req.body ?? {}
  if (typeof questionId !== 'string') {
    return res.status(400).json({ error: 'questionId (string) required' })
  }
  const file = sectionFile(req.params.id)
  if (!file) return res.status(400).json({ error: 'Invalid section id' })
  try {
    const section = JSON.parse(await readFile(file, 'utf-8'))
    const q = (section.questions ?? []).find((q) => q.id === questionId)
    if (!q) return res.status(404).json({ error: 'Question not found' })
    delete q.explanation
    await writeFile(file, JSON.stringify(section, null, 2) + '\n')
    res.json(await readSection(req.params.id))
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

// Persist per-question "hidden" flags in the topic file. hidden=true marks
// questions whose evaluation scored at or above the threshold (0-10 scale);
// hidden=false unhides every question.
app.put('/api/sections/:id/hidden', async (req, res) => {
  const hidden = req.body?.hidden
  const threshold = Number(req.body?.threshold ?? 6)
  if (typeof hidden !== 'boolean') return res.status(400).json({ error: 'hidden must be a boolean' })
  if (!Number.isFinite(threshold)) return res.status(400).json({ error: 'Invalid threshold' })
  const file = sectionFile(req.params.id)
  if (!file) return res.status(400).json({ error: 'Invalid section id' })
  try {
    const section = JSON.parse(await readFile(file, 'utf-8'))
    const changedIds = []
    for (const q of section.questions ?? []) {
      if (hidden) {
        const score = parseScore(q.evaluation?.score)
        if (score != null && score >= threshold && !q.hidden) {
          q.hidden = true
          changedIds.push(q.id)
        }
      } else if (q.hidden) {
        delete q.hidden
        changedIds.push(q.id)
      }
    }
    if (changedIds.length) await writeFile(file, JSON.stringify(section, null, 2) + '\n')
    res.json({ changedIds, section: await readSection(req.params.id) })
  } catch {
    res.status(404).json({ error: 'Section not found' })
  }
})

app.use(express.static(DIST_DIR))
app.get('*', (_req, res) => res.sendFile(path.join(DIST_DIR, 'index.html')))

app.listen(PORT, () => console.log(`ai-teacher listening on :${PORT} (data: ${DATA_DIR})`))
