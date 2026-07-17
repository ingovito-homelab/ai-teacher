async function json(res) {
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
  return res.json()
}

// Section ids are paths like "java/parallelism" — encode so the slash
// stays inside one URL segment.
const enc = (id) => encodeURIComponent(id)

export function listSections() {
  return fetch('/api/sections').then(json)
}

export function getSection(id) {
  return fetch(`/api/sections/${enc(id)}`).then(json)
}

export function getActivity() {
  return fetch('/api/activity').then(json)
}

export function clearLowScores(id, threshold) {
  return fetch(`/api/sections/${enc(id)}/clear-low-scores`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ threshold }),
  }).then(json)
}

export function setAssistRequired(id, questionId, assistRequired) {
  return fetch(`/api/sections/${enc(id)}/assist`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId, assistRequired }),
  }).then(json)
}

export function clearExplanation(id, questionId) {
  return fetch(`/api/sections/${enc(id)}/explanation`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ questionId }),
  }).then(json)
}

export function setHidden(id, hidden, threshold) {
  return fetch(`/api/sections/${enc(id)}/hidden`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hidden, threshold }),
  }).then(json)
}

export function saveAnswers(id, answers) {
  return fetch(`/api/sections/${enc(id)}/answers`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ answers }),
  }).then(json)
}
