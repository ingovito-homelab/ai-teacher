<script setup>
import { computed, nextTick, ref } from 'vue'

const FOLLOW_UP_MARKER = '----FOLLOW UP ANSWER-----'

const props = defineProps({
  question: { type: Object, required: true },
  index: { type: Number, required: true },
  modelValue: { type: String, default: '' },
})
const emit = defineEmits(['update:modelValue', 'toggle-assist', 'remove-explanation'])

const evaluation = computed(() => props.question.evaluation)
const followUp = computed(() => props.question.followUp)
const hasFollowUpAnswer = computed(() => props.modelValue.includes(FOLLOW_UP_MARKER))

const answerBox = ref(null)

function onInput(e) {
  emit('update:modelValue', e.target.value)
}

async function answerFollowUp() {
  if (hasFollowUpAnswer.value) return
  const base = props.modelValue.replace(/\s+$/, '')
  emit('update:modelValue', (base ? base + '\n\n' : '') + FOLLOW_UP_MARKER + '\n')
  await nextTick()
  const el = answerBox.value
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

    <textarea
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
    </section>

    <section v-if="followUp" class="followup">
      <div class="followup-head">
        <strong>Follow-up</strong>
        <button v-if="!hasFollowUpAnswer" class="btn ghost btn-sm" @click="answerFollowUp">
          ✎ Answer follow-up
        </button>
        <span v-else class="followup-answered">answer above ↑</span>
      </div>
      <p>{{ followUp }}</p>
    </section>
  </article>
</template>
