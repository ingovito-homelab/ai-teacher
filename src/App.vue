<script setup>
import { computed, onMounted, ref, watch } from 'vue'
import { listSections, getSection, saveAnswers, clearLowScores, setHidden, setAssistRequired, clearExplanation, getActivity } from './api'
import { parseScore } from './score'
import QuestionCard from './components/QuestionCard.vue'
import ActivityChart from './components/ActivityChart.vue'

// answers evaluated below this mark (out of 10) can be cleared for a retry
const CLEAR_THRESHOLD = 6

const sections = ref([])
const currentId = ref(null)
const section = ref(null)
const answers = ref({})
const loading = ref(false)
const saving = ref(false)
const clearing = ref(false)
const hiding = ref(false)

// ---- focus mode ----

const focusSetupOpen = ref(false)
const focusCount = ref(3)
const focusIds = ref([])
const focusDistractions = ref(0)
const focusActive = computed(() => focusIds.value.length > 0)

let baseTitle = 'AI Teacher'
const status = ref('')
const statusError = ref(false)

const theme = ref('light')

function applyTheme(value) {
  theme.value = value
  document.documentElement.dataset.theme = value
  localStorage.setItem('ai-teacher-theme', value)
}

function toggleTheme() {
  applyTheme(theme.value === 'dark' ? 'light' : 'dark')
}

// ---- unsaved answer drafts (localStorage) ----

const draftsKey = (id) => `ai-teacher-drafts:${id}`

function loadDrafts(id) {
  try {
    return JSON.parse(localStorage.getItem(draftsKey(id))) ?? {}
  } catch {
    return {}
  }
}

// keep only drafts that differ from what's saved in the file
function persistDrafts() {
  if (!currentId.value || !section.value) return
  const drafts = {}
  for (const q of section.value.questions) {
    const v = answers.value[q.id] ?? ''
    if (v !== (q.answer ?? '')) drafts[q.id] = v
  }
  if (Object.keys(drafts).length) {
    localStorage.setItem(draftsKey(currentId.value), JSON.stringify(drafts))
  } else {
    localStorage.removeItem(draftsKey(currentId.value))
  }
}

watch(answers, persistDrafts, { deep: true })

// ---- subject grouping ----

// sections come flat from the API ("java/parallelism"); group them by subject
const subjects = computed(() => {
  const groups = new Map()
  for (const s of sections.value) {
    const key = s.subject ?? s.id
    if (!groups.has(key)) {
      groups.set(key, {
        id: key,
        title: s.subjectTitle ?? s.title,
        topics: [],
        total: 0,
        answered: 0,
        evaluated: 0,
        followUps: 0,
        scoreSum: 0,
        scored: 0,
      })
    }
    const g = groups.get(key)
    g.topics.push(s)
    g.total += s.total
    g.answered += s.answered
    g.evaluated += s.evaluated
    g.followUps += s.followUps
    if (s.avgScore != null && s.scored) {
      g.scoreSum += s.avgScore * s.scored
      g.scored += s.scored
    }
  }
  return [...groups.values()].map((g) => ({
    ...g,
    avgScore: g.scored ? Math.round((g.scoreSum / g.scored) * 10) / 10 : null,
  }))
})

// ---- stats ----

const totals = computed(() => {
  const t = {
    subjects: subjects.value.length,
    topics: sections.value.length,
    questions: 0,
    answered: 0,
    evaluated: 0,
    followUps: 0,
  }
  let scoreSum = 0
  let scored = 0
  for (const s of sections.value) {
    t.questions += s.total
    t.answered += s.answered
    t.evaluated += s.evaluated
    t.followUps += s.followUps
    if (s.avgScore != null && s.scored) {
      scoreSum += s.avgScore * s.scored
      scored += s.scored
    }
  }
  t.avgScore = scored ? Math.round((scoreSum / scored) * 10) / 10 : null
  return t
})

const dirty = computed(() => {
  if (!section.value) return false
  return section.value.questions.some((q) => (q.answer ?? '') !== (answers.value[q.id] ?? ''))
})

const activity = ref({ days: [], months: [] })

async function refreshSections() {
  sections.value = await listSections()
  activity.value = await getActivity()
}

function openDashboard() {
  if (focusActive.value) return
  currentId.value = null
  section.value = null
  status.value = ''
  refreshSections()
}

async function openSection(id) {
  if (focusActive.value) return
  loading.value = true
  status.value = ''
  try {
    currentId.value = id
    const data = await getSection(id)
    section.value = data
    const merged = Object.fromEntries(data.questions.map((q) => [q.id, q.answer ?? '']))
    const drafts = loadDrafts(id)
    for (const [qid, v] of Object.entries(drafts)) {
      if (qid in merged) merged[qid] = v
    }
    answers.value = merged
  } finally {
    loading.value = false
  }
}

function setStatus(text, isError = false) {
  status.value = text
  statusError.value = isError
}

async function save() {
  if (!currentId.value) return
  saving.value = true
  setStatus('')
  try {
    const updated = await saveAnswers(currentId.value, answers.value)
    section.value = updated
    answers.value = Object.fromEntries(updated.questions.map((q) => [q.id, q.answer ?? '']))
    setStatus('Saved ✓')
    await refreshSections()
  } catch (e) {
    setStatus(`Error: ${e.message}`, true)
  } finally {
    saving.value = false
  }
}

const lowScored = computed(() => {
  if (!section.value) return 0
  return section.value.questions.filter((q) => {
    const score = parseScore(q.evaluation?.score)
    return score != null && score < CLEAR_THRESHOLD
  }).length
})

// questions answered well enough (score >= threshold) that are not hidden yet
const hideable = computed(() => {
  if (!section.value) return 0
  return section.value.questions.filter((q) => {
    const score = parseScore(q.evaluation?.score)
    return !q.hidden && score != null && score >= CLEAR_THRESHOLD
  }).length
})

const hiddenCount = computed(
  () => section.value?.questions.filter((q) => q.hidden).length ?? 0
)

// keep the original index so question numbers don't shift when hiding
const visibleQuestions = computed(() => {
  const items = (section.value?.questions ?? []).map((question, index) => ({ question, index }))
  if (focusActive.value) {
    return items.filter(({ question }) => focusIds.value.includes(question.id))
  }
  return items.filter(({ question }) => !question.hidden)
})

// ---- focus mode ----

const unanswered = computed(() => {
  if (!section.value) return []
  return section.value.questions.filter(
    (q) => !q.hidden && !(answers.value[q.id] ?? '').trim()
  )
})

const focusAnswered = computed(
  () => focusIds.value.filter((id) => (answers.value[id] ?? '').trim()).length
)

function startFocus() {
  const pool = unanswered.value
  if (!pool.length) return
  const n = Math.min(Math.max(1, Math.floor(focusCount.value) || 1), pool.length)
  focusIds.value = pool.slice(0, n).map((q) => q.id)
  focusDistractions.value = 0
  focusSetupOpen.value = false
  setStatus(`Focus mode: answer ${n} question(s) — navigation is locked until you're done.`)
  window.scrollTo({ top: 0, behavior: 'smooth' })
}

function endFocus(completed) {
  focusIds.value = []
  document.title = baseTitle
  setStatus(completed ? 'Focus complete 🎉 — remember to save your answers.' : 'Focus mode ended.')
}

function giveUpFocus() {
  if (confirm('Give up focus mode? Your typed answers are kept as drafts.')) endFocus(false)
}

// all focus questions answered -> session complete
watch(focusAnswered, (n) => {
  if (focusActive.value && n === focusIds.value.length) endFocus(true)
})

// make leaving harder while a focus session is running
function onBeforeUnload(e) {
  if (!focusActive.value) return
  e.preventDefault()
  e.returnValue = ''
}

function onVisibilityChange() {
  if (!focusActive.value) return
  if (document.hidden) {
    focusDistractions.value++
    document.title = '🚨 Focus mode — come back!'
  } else {
    document.title = baseTitle
  }
}

async function toggleAssist(question) {
  if (!currentId.value) return
  try {
    const updated = await setAssistRequired(currentId.value, question.id, !question.assistRequired)
    section.value = updated
  } catch (e) {
    setStatus(`Error: ${e.message}`, true)
  }
}

async function removeExplanation(question) {
  if (!currentId.value) return
  try {
    section.value = await clearExplanation(currentId.value, question.id)
  } catch (e) {
    setStatus(`Error: ${e.message}`, true)
  }
}

async function toggleHidden(hidden) {
  if (!currentId.value || hiding.value) return
  hiding.value = true
  setStatus('')
  try {
    const { changedIds, section: updated } = await setHidden(currentId.value, hidden, CLEAR_THRESHOLD)
    section.value = updated
    setStatus(hidden ? `Hidden ${changedIds.length} question(s) ✓` : `Unhidden ${changedIds.length} question(s) ✓`)
  } catch (e) {
    setStatus(`Error: ${e.message}`, true)
  } finally {
    hiding.value = false
  }
}

async function clearLowScored() {
  if (!currentId.value || !lowScored.value || clearing.value) return
  const msg = `Clear ${lowScored.value} answer(s) scored below ${CLEAR_THRESHOLD}/10?\nAnswer, evaluation and follow-up will be removed so you can retry.`
  if (!confirm(msg)) return
  clearing.value = true
  setStatus('')
  try {
    const { clearedIds, section: updated } = await clearLowScores(currentId.value, CLEAR_THRESHOLD)
    section.value = updated
    for (const qid of clearedIds) answers.value[qid] = ''
    setStatus(`Cleared ${clearedIds.length} low-scored answer(s) ✓`)
    await refreshSections()
  } catch (e) {
    setStatus(`Error: ${e.message}`, true)
  } finally {
    clearing.value = false
  }
}

async function reload() {
  if (currentId.value) await openSection(currentId.value)
  await refreshSections()
  setStatus('Reloaded ✓')
}

const fmtScore = (v) => (v == null ? '—' : `${v}/10`)

onMounted(async () => {
  const saved = localStorage.getItem('ai-teacher-theme')
  const preferred = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  applyTheme(saved || preferred)
  baseTitle = document.title
  window.addEventListener('beforeunload', onBeforeUnload)
  document.addEventListener('visibilitychange', onVisibilityChange)
  await refreshSections()
})
</script>

<template>
  <div class="layout">
    <aside class="sidebar" :class="{ locked: focusActive }">
      <div class="brand">
        <h1><span class="logo">🎓</span> AI Teacher</h1>
        <button class="theme-toggle" :title="theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode'" @click="toggleTheme">
          {{ theme === 'dark' ? '☀️' : '🌙' }}
        </button>
      </div>

      <nav>
        <button class="section-item home" :class="{ active: !currentId }" @click="openDashboard">
          <span class="section-title">📊 Dashboard</span>
        </button>

        <div v-for="g in subjects" :key="g.id" class="subject-group">
          <p class="subject-label">{{ g.title }}</p>
          <button
            v-for="s in g.topics"
            :key="s.id"
            class="section-item"
            :class="{ active: s.id === currentId }"
            @click="openSection(s.id)"
          >
            <span class="section-title">{{ s.title }}</span>
            <span class="progress">
              <span class="progress-bar" :style="{ width: s.total ? (s.answered / s.total) * 100 + '%' : '0%' }"></span>
            </span>
            <span class="section-meta">{{ s.answered }}/{{ s.total }} answered · {{ s.evaluated }} evaluated</span>
          </button>
        </div>
        <p v-if="!sections.length" class="empty">No topics yet. Run the question-writer agent.</p>
      </nav>

      <div class="sidebar-footer">
        <button class="btn ghost" style="width: 100%" @click="reload">↻ Reload sections</button>
      </div>
    </aside>

    <main class="content" :class="{ wide: !section && !loading }">
      <div v-if="loading" class="empty">Loading…</div>

      <template v-else-if="section">
        <header class="toolbar sticky">
          <div>
            <p v-if="section.subjectTitle" class="breadcrumb">{{ section.subjectTitle }}</p>
            <h2>{{ section.title }}</h2>
            <p v-if="section.description" class="desc">{{ section.description }}</p>
          </div>
          <div class="actions">
            <span v-if="status" class="status" :class="{ error: statusError }">{{ status }}</span>
            <button
              v-if="hideable"
              class="btn ghost"
              :disabled="hiding"
              :title="`Hide questions scored ${CLEAR_THRESHOLD}/10 or higher (saved in the topic file)`"
              @click="toggleHidden(true)"
            >
              🙈 Hide answered ({{ hideable }})
            </button>
            <button
              v-if="hiddenCount"
              class="btn ghost"
              :disabled="hiding"
              title="Unhide all hidden questions (saved in the topic file)"
              @click="toggleHidden(false)"
            >
              👁 Show all ({{ hiddenCount }})
            </button>
            <button
              v-if="lowScored"
              class="btn ghost"
              :disabled="clearing"
              :title="`Reset answers scored below ${CLEAR_THRESHOLD}/10`"
              @click="clearLowScored"
            >
              {{ clearing ? 'Clearing…' : `🧹 Clear low scores (${lowScored})` }}
            </button>
            <button class="btn ghost" @click="reload">Reload</button>
            <button class="btn" :disabled="!dirty || saving" @click="save">
              {{ saving ? 'Saving…' : 'Save answers' }}
            </button>
          </div>
        </header>

        <p v-if="dirty" class="draft-note">Unsaved changes — kept locally until you save.</p>

        <p v-if="hiddenCount" class="draft-note">
          {{ hiddenCount }} question(s) with a mark of {{ CLEAR_THRESHOLD }}/10 or higher hidden.
        </p>

        <QuestionCard
          v-for="{ question: q, index: i } in visibleQuestions"
          :key="q.id"
          :question="q"
          :index="i"
          v-model="answers[q.id]"
          @toggle-assist="toggleAssist(q)"
          @remove-explanation="removeExplanation(q)"
        />
        <p v-if="!visibleQuestions.length" class="empty">All questions answered well — nothing left to show 🎉</p>
      </template>

      <template v-else>
        <header class="toolbar">
          <div>
            <h2>Dashboard</h2>
            <p class="desc">Your progress across all subjects and topics.</p>
          </div>
          <div class="actions">
            <button class="btn ghost" @click="refreshSections">Refresh</button>
          </div>
        </header>

        <ActivityChart :days="activity.days" :months="activity.months" />

        <div class="stats-grid">
          <div class="stat-tile">
            <span class="stat-label">Subjects</span>
            <span class="stat-value">{{ totals.subjects }}</span>
          </div>
          <div class="stat-tile">
            <span class="stat-label">Topics</span>
            <span class="stat-value">{{ totals.topics }}</span>
          </div>
          <div class="stat-tile">
            <span class="stat-label">Questions</span>
            <span class="stat-value">{{ totals.questions }}</span>
          </div>
          <div class="stat-tile">
            <span class="stat-label">Answered</span>
            <span class="stat-value">{{ totals.answered }}<span class="stat-sub">/{{ totals.questions }}</span></span>
          </div>
          <div class="stat-tile">
            <span class="stat-label">Evaluated</span>
            <span class="stat-value">{{ totals.evaluated }}</span>
          </div>
          <div class="stat-tile">
            <span class="stat-label">Average mark</span>
            <span class="stat-value">{{ fmtScore(totals.avgScore) }}</span>
          </div>
        </div>

        <div class="table-wrap">
          <table class="stats-table">
            <thead>
              <tr>
                <th>Topic</th>
                <th>Questions</th>
                <th>Answered</th>
                <th>Evaluated</th>
                <th>Follow-ups</th>
                <th>Avg mark</th>
                <th class="col-progress">Progress</th>
              </tr>
            </thead>
            <tbody>
              <template v-for="g in subjects" :key="g.id">
                <tr class="subject-row">
                  <td class="cell-title">{{ g.title }}</td>
                  <td>{{ g.total }}</td>
                  <td>{{ g.answered }}</td>
                  <td>{{ g.evaluated }}</td>
                  <td>{{ g.followUps }}</td>
                  <td>
                    <span v-if="g.avgScore != null" class="mark">{{ fmtScore(g.avgScore) }}</span>
                    <span v-else class="mark-empty">—</span>
                  </td>
                  <td class="col-progress">
                    <span class="progress">
                      <span class="progress-bar" :style="{ width: g.total ? (g.answered / g.total) * 100 + '%' : '0%' }"></span>
                    </span>
                  </td>
                </tr>
                <tr v-for="s in g.topics" :key="s.id" class="topic-row" @click="openSection(s.id)">
                  <td class="cell-title cell-topic">{{ s.title }}</td>
                  <td>{{ s.total }}</td>
                  <td>{{ s.answered }}</td>
                  <td>{{ s.evaluated }}</td>
                  <td>{{ s.followUps }}</td>
                  <td>
                    <span v-if="s.avgScore != null" class="mark">{{ fmtScore(s.avgScore) }}</span>
                    <span v-else class="mark-empty">—</span>
                  </td>
                  <td class="col-progress">
                    <span class="progress">
                      <span class="progress-bar" :style="{ width: s.total ? (s.answered / s.total) * 100 + '%' : '0%' }"></span>
                    </span>
                  </td>
                </tr>
              </template>
            </tbody>
          </table>
          <p v-if="!sections.length" class="empty">No topics yet. Run the question-writer agent.</p>
        </div>
      </template>
    </main>

    <div v-if="section && !loading" class="fab">
      <div v-if="focusActive" class="fab-panel">
        <strong>🎯 Focus mode</strong>
        <p class="fab-progress">{{ focusAnswered }}/{{ focusIds.length }} answered</p>
        <p v-if="focusDistractions" class="fab-distractions">⚠️ {{ focusDistractions }} distraction(s)</p>
        <button class="btn ghost btn-sm" @click="giveUpFocus">Give up</button>
      </div>

      <div v-else-if="focusSetupOpen" class="fab-panel">
        <strong>🎯 Focus mode</strong>
        <label class="fab-label" for="focus-count">How many questions?</label>
        <input
          id="focus-count"
          v-model.number="focusCount"
          class="fab-input"
          type="number"
          min="1"
          :max="unanswered.length"
        />
        <p class="fab-hint">{{ unanswered.length }} unanswered available</p>
        <div class="fab-row">
          <button class="btn" :disabled="!unanswered.length" @click="startFocus">Start</button>
          <button class="btn ghost" @click="focusSetupOpen = false">Cancel</button>
        </div>
      </div>

      <button
        v-else
        class="btn fab-btn"
        :disabled="!unanswered.length"
        :title="unanswered.length ? 'Pick a number of questions and answer them without distractions' : 'No unanswered questions in this topic'"
        @click="focusSetupOpen = true"
      >
        🎯 Focus mode
      </button>
    </div>
  </div>
</template>
