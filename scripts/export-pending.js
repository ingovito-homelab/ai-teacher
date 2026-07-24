// Export every question awaiting the AI evaluator to data/_pending.json:
// answered (or re-answered, e.g. a follow-up answer was appended) since the
// last evaluation, or flagged "assist required" without an explanation yet.
//
//   node scripts/export-pending.js
import { writeFile } from 'node:fs/promises'
import { openDb, pendingQuestions } from '../server/db.js'
import { DB_FILE, PENDING_FILE } from './lib.js'

const db = openDb(DB_FILE)
const questions = pendingQuestions(db)
db.close()

if (!questions.length) {
  console.log('nothing pending — no answered-but-unevaluated or assist-flagged questions')
  process.exit(0)
}

await writeFile(
  PENDING_FILE,
  JSON.stringify({ exportedAt: new Date().toISOString(), count: questions.length, questions }, null, 2) + '\n'
)
console.log(`${questions.length} pending question(s) written to ${PENDING_FILE}`)
