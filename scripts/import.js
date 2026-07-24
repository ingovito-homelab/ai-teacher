// Import seed question JSONs into SQLite. Safe to re-run: questions are
// deduplicated by a content hash of their text.
//
//   node scripts/import.js               # new questions only
//   node scripts/import.js --with-state  # one-off legacy migration: also carry
//                                        # answers/evaluations/flags from the
//                                        # old full-schema topic files
import { openDb } from '../server/db.js'
import { importSeeds } from '../server/importer.js'
import { DATA_DIR, DB_FILE } from './lib.js'

const withState = process.argv.includes('--with-state')

const db = openDb(DB_FILE)
const stats = await importSeeds(db, DATA_DIR, { withState })
db.close()

console.log(
  `imported into ${DB_FILE}${withState ? ' (with legacy state)' : ''}: ` +
    `${stats.topics} topics, ${stats.inserted} new questions, ${stats.skipped} already known`
)
