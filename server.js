import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { openDb } from './server/db.js'
import { importSeeds } from './server/importer.js'
import { createApp } from './server/app.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data')
const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'ai-teacher.db')
const DIST_DIR = path.join(__dirname, 'dist')
const PORT = process.env.PORT || 3000

const db = openDb(DB_FILE)
// withState: true — this fork's data/*.json files still carry real
// answer/evaluation state (pre-dating the SQLite migration), not just seed
// questions. Harmless to leave on permanently: it only applies state to
// questions being inserted for the first time, never to rows already in the DB.
const { topics, inserted, skipped } = await importSeeds(db, DATA_DIR, { withState: true })
console.log(`seed import: ${topics} topics, ${inserted} new questions, ${skipped} already known`)

createApp({ db, distDir: DIST_DIR }).listen(PORT, () =>
  console.log(`ai-teacher listening on :${PORT} (db: ${DB_FILE})`)
)
