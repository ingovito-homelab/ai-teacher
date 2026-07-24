<script setup>
import { computed, nextTick, ref } from 'vue'

const FOLLOW_UP_MARKER = '----FOLLOW UP ANSWER-----'

const props = defineProps({
  question: { type: Object, required: true },
  index: { type: Number, required: true },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits([
  'update:modelValue',
  'toggle-assist',
  'request-explanation',
  'remove-explanation',
])

const evaluation = computed(() => props.question.evaluation)
const followUp = computed(() => props.question.followUp)
const isQuiz = computed(() => props.question.type === 'quiz')
const hasFollowUpAnswer = computed(() => props.modelValue.includes(FOLLOW_UP_MARKER))

const answerBox = ref(null)
const followUpBox = ref(null)

// ---- explanation touch-ups: "add examples" / "expand deeper" ----
const expandOpen = ref(false)
const expandContext = ref('')

function requestExamples() {
  emit('request-explanation', { mode: 'examples' })
}

function toggleExpand() {
  expandOpen.value = !expandOpen.value
}

function submitExpand() {
  emit('request-explanation', { mode: 'expand', context: expandContext.value.trim() })
  expandOpen.value = false
  expandContext.value = ''
}

function onInput(e) {
  emit('update:modelValue', e.target.value)
}

// ---- quiz (multiselect) ----
// A quiz answer lives in the same string field as open answers: the selected
// option texts, one per line, with any follow-up answer below the marker.

const markerIndex = computed(() => props.modelValue.indexOf(FOLLOW_UP_MARKER))
const selectionPart = computed(() =>
  markerIndex.value < 0 ? props.modelValue : props.modelValue.slice(0, markerIndex.value)
)
const followUpPart = computed(() =>
  markerIndex.value < 0
    ? ''
    : props.modelValue.slice(markerIndex.value + FOLLOW_UP_MARKER.length).replace(/^\n/, '')
)
const selected = computed(() => {
  const lines = new Set(selectionPart.value.split('\n').map((l) => l.trim()).filter(Boolean))
  return new Set((props.question.options ?? []).filter((o) => lines.has(o)))
})

function combine(selectionText, followUpText) {
  if (markerIndex.value < 0) return selectionText
  const base = selectionText.replace(/\s+$/, '')
  return (base ? base + '\n\n' : '') + FOLLOW_UP_MARKER + '\n' + followUpText
}

function toggleOption(option) {
  const next = new Set(selected.value)
  if (next.has(option)) next.delete(option)
  else next.add(option)
  const text = (props.question.options ?? []).filter((o) => next.has(o)).join('\n')
  emit('update:modelValue', combine(text, followUpPart.value))
}

function onFollowUpInput(e) {
  emit('update:modelValue', combine(selectionPart.value, e.target.value))
}

async function answerFollowUp() {
  if (hasFollowUpAnswer.value) return
  const base = props.modelValue.replace(/\s+$/, '')
  emit('update:modelValue', (base ? base + '\n\n' : '') + FOLLOW_UP_MARKER + '\n')
  await nextTick()
  const el = isQuiz.value ? followUpBox.value : answerBox.value
  if (!el) return
  el.focus()
  el.setSelectionRange(el.value.length, el.value.length)
  el.scrollTop = el.scrollHeight
}
</script>

<template>
  <article class="card">
    <header class="card-head">
      <span class="badge">Q{{ index + 1 }}</span>
      <span v-if="isQuiz" class="tag tag-quiz">quiz · multiselect</span>
      <span v-if="evaluation" class="tag tag-done">evaluated</span>
      <span v-else-if="modelValue.trim()" class="tag tag-answered">answered</span>
      <span v-else class="tag tag-todo">todo</span>
      <button
        class="assist-toggle"
        :class="{ active: question.assistRequired }"
        :title="question.assistRequired
          ? 'Assist requested — the evaluator will add an explanation with examples. Click to unmark.'
          : 'Mark for assist — next evaluation adds an explanation with examples, even for a good answer.'"
        @click="emit('toggle-assist')"
      >
        {{ question.assistRequired ? '🆘 Assist required' : '🛟 Request assist' }}
      </button>
    </header>

    <p class="question">{{ question.question }}</p>

    <div v-if="isQuiz" class="quiz-options">
      <label
        v-for="opt in question.options"
        :key="opt"
        class="quiz-option"
        :class="{ checked: selected.has(opt) }"
      >
        <input type="checkbox" :checked="selected.has(opt)" @change="toggleOption(opt)" />
        <span>{{ opt }}</span>
      </label>
      <p class="quiz-hint">Select every option that applies.</p>
    </div>

    <textarea
      v-else
      ref="answerBox"
      class="answer"
      rows="4"
      placeholder="Type your answer..."
      :value="modelValue"
      @input="onInput"
    ></textarea>

    <section v-if="evaluation" class="eval">
      <div class="eval-head">
        <strong>Evaluation</strong>
        <span v-if="evaluation.score != null" class="score">{{ evaluation.score }}</span>
        <span v-if="evaluation.verdict" class="verdict">{{ evaluation.verdict }}</span>
      </div>
      <p v-if="evaluation.feedback" class="feedback">{{ evaluation.feedback }}</p>
    </section>

    <!-- explanation is agent-written HTML from the local topic file -->
    <section v-if="question.explanation" class="explanation">
      <div class="explanation-head">
        <strong>📖 Explanation</strong>
        <button
          class="explanation-close"
          title="Remove explanation (deletes it from the topic file)"
          @click="emit('remove-explanation')"
        >✕</button>
      </div>
      <div class="explanation-body" v-html="question.explanation"></div>
      <div class="explanation-actions">
        <button class="btn ghost btn-sm" title="Ask the evaluator to add more examples" @click="requestExamples">
          ➕ Dodaj przykłady
        </button>
        <button class="btn ghost btn-sm" title="Ask the evaluator to go deeper" @click="toggleExpand">
          🔎 Rozwiń bardziej dogłębnie
        </button>
      </div>
      <div v-if="expandOpen" class="explanation-expand">
        <textarea
          v-model="expandContext"
          class="answer"
          rows="2"
          placeholder="Opcjonalnie: na czym się skupić? (kontekst)"
        ></textarea>
        <button class="btn btn-sm" @click="submitExpand">Poproś o rozwinięcie</button>
      </div>
    </section>

    <section v-if="followUp" class="followup">
      <div class="followup-head">
        <strong>Follow-up</strong>
        <button v-if="!hasFollowUpAnswer" class="btn ghost btn-sm" @click="answerFollowUp">
          ✎ Answer follow-up
        </button>
        <span v-else-if="!isQuiz" class="followup-answered">answer above ↑</span>
      </div>
      <p>{{ followUp }}</p>
      <!-- quiz cards have no free-text box above, so the follow-up answer goes here -->
      <textarea
        v-if="isQuiz && hasFollowUpAnswer"
        ref="followUpBox"
        class="answer followup-answer"
        rows="3"
        placeholder="Type your follow-up answer..."
        :value="followUpPart"
        @input="onFollowUpInput"
      ></textarea>
    </section>
  </article>
</template>
