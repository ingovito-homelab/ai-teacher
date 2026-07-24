import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Same resolution rules as server.js, so host scripts and the containerized
// server always talk about the same files.
const appDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)))

export const DATA_DIR = process.env.DATA_DIR || path.join(appDir, 'data')
export const DB_FILE = process.env.DB_FILE || path.join(DATA_DIR, 'ai-teacher.db')
export const PENDING_FILE = path.join(DATA_DIR, '_pending.json')
export const EVALUATIONS_FILE = path.join(DATA_DIR, '_evaluations.json')
