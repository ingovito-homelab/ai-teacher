<script setup>
import { computed, ref } from 'vue'

const props = defineProps({
  days: { type: Array, default: () => [] },     // [{ date: "YYYY-MM-DD", count }]
  months: { type: Array, default: () => [] },   // [{ date: "YYYY-MM", count }]
})

const view = ref('days')
const DAY_WINDOW = 30
const MONTH_WINDOW = 12

const pad = (n) => String(n).padStart(2, '0')
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`

// A continuous timeline (no gaps) ending today, so quiet days show as empty slots.
const series = computed(() => {
  const now = new Date()
  if (view.value === 'days') {
    const counts = new Map(props.days.map((d) => [d.date, d.count]))
    const out = []
    for (let i = DAY_WINDOW - 1; i >= 0; i--) {
      const d = new Date(now)
      d.setDate(now.getDate() - i)
      out.push({
        key: dayKey(d),
        count: counts.get(dayKey(d)) ?? 0,
        label: d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }),
        // a tick label once a week keeps the axis readable without collisions
        tick: i % 7 === 0 ? d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) : '',
      })
    }
    return out
  }
  const counts = new Map(props.months.map((m) => [m.date, m.count]))
  const out = []
  for (let i = MONTH_WINDOW - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1)
    const label = d.toLocaleDateString(undefined, { month: 'short' })
    out.push({
      key: monthKey(d),
      count: counts.get(monthKey(d)) ?? 0,
      label: d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' }),
      tick: label,
    })
  }
  return out
})

// ---- geometry (fixed viewBox; uniform scaling keeps slots pixel-even) ----

const W = 920
const H = 200
const M = { top: 12, right: 10, bottom: 24, left: 34 }
const innerW = W - M.left - M.right
const innerH = H - M.top - M.bottom

// round the y max up to a clean number so gridline values read well
function niceCeil(v) {
  if (v <= 5) return Math.max(1, v)
  const pow = 10 ** Math.floor(Math.log10(v))
  for (const m of [1, 2, 2.5, 5, 10]) {
    if (m * pow >= v && Number.isInteger(m * pow)) return m * pow
  }
  return 10 * pow
}

const yMax = computed(() => niceCeil(Math.max(...series.value.map((s) => s.count), 1)))

const yTicks = computed(() => {
  const max = yMax.value
  const ticks = [max]
  if (max % 2 === 0 && max >= 2) ticks.push(max / 2)
  return ticks
})

const bars = computed(() => {
  const n = series.value.length
  const slot = innerW / n
  const barW = Math.min(24, slot * 0.72)
  return series.value.map((s, i) => {
    const x = M.left + i * slot + (slot - barW) / 2
    const h = (s.count / yMax.value) * innerH
    const y = M.top + innerH - h
    // rounded 4px data-end, square at the baseline; zero -> no mark
    const r = Math.min(4, barW / 2, h)
    const path = h
      ? `M${x},${y + h} L${x},${y + r} Q${x},${y} ${x + r},${y} L${x + barW - r},${y} Q${x + barW},${y} ${x + barW},${y + r} L${x + barW},${y + h} Z`
      : ''
    return { ...s, i, x, y, h, slotX: M.left + i * slot, slot, barW, path, cx: x + barW / 2 }
  })
})

const yFor = (v) => M.top + innerH - (v / yMax.value) * innerH

// ---- headline stats (over all history, not just the window) ----

const totalAnswered = computed(() => props.days.reduce((a, d) => a + d.count, 0))

const activeDays = computed(() => props.days.filter((d) => d.count > 0).length)

const bestDay = computed(() => {
  let best = null
  for (const d of props.days) if (!best || d.count > best.count) best = d
  return best
})

// consecutive days up to today (or yesterday) with at least one answer
const streak = computed(() => {
  const counts = new Map(props.days.map((d) => [d.date, d.count]))
  const now = new Date()
  let n = 0
  // allow the streak to still count if today has no answer yet
  let start = counts.get(dayKey(now)) > 0 ? 0 : 1
  for (let i = start; ; i++) {
    const d = new Date(now)
    d.setDate(now.getDate() - i)
    if (counts.get(dayKey(d)) > 0) n++
    else break
  }
  return n
})

const hovered = ref(null)

const tooltip = computed(() => {
  if (hovered.value == null) return null
  const b = bars.value[hovered.value]
  if (!b) return null
  return {
    text: `${b.label} · ${b.count}`,
    left: (b.cx / W) * 100 + '%',
    top: ((b.count ? b.y : yFor(0)) / H) * 100 + '%',
  }
})
</script>

<template>
  <section class="activity">
    <header class="activity-head">
      <div>
        <h3>Answering activity</h3>
        <p class="activity-sub">Questions answered per {{ view === 'days' ? 'day, last 30 days' : 'month, last 12 months' }}.</p>
      </div>
      <div class="seg" role="tablist">
        <button :class="{ on: view === 'days' }" @click="view = 'days'">Days</button>
        <button :class="{ on: view === 'months' }" @click="view = 'months'">Months</button>
      </div>
    </header>

    <div class="activity-stats">
      <div><span class="stat-label">Answered</span><span class="n">{{ totalAnswered }}</span></div>
      <div><span class="stat-label">Day streak</span><span class="n">{{ streak }} 🔥</span></div>
      <div><span class="stat-label">Active days</span><span class="n">{{ activeDays }}</span></div>
      <div><span class="stat-label">Best day</span><span class="n">{{ bestDay?.count ?? 0 }}</span></div>
    </div>

    <div class="chart-wrap" @mouseleave="hovered = null">
      <svg class="chart-svg" :viewBox="`0 0 ${W} ${H}`" role="img" aria-label="Bar chart of questions answered over time">
        <!-- gridlines + y ticks -->
        <g v-for="t in yTicks" :key="t">
          <line class="grid" :x1="M.left" :x2="W - M.right" :y1="yFor(t)" :y2="yFor(t)" />
          <text class="ytick" :x="M.left - 8" :y="yFor(t) + 4">{{ t }}</text>
        </g>
        <!-- baseline -->
        <line class="baseline" :x1="M.left" :x2="W - M.right" :y1="yFor(0)" :y2="yFor(0)" />

        <!-- bars -->
        <path
          v-for="b in bars"
          :key="b.key"
          v-show="b.path"
          class="bar"
          :class="{ hot: hovered === b.i }"
          :d="b.path"
        />

        <!-- x tick labels -->
        <text
          v-for="b in bars"
          :key="b.key + '-t'"
          v-show="b.tick"
          class="xtick"
          :x="b.cx"
          :y="H - 6"
        >{{ b.tick }}</text>

        <!-- hover hit targets (full slot height, wider than the mark) -->
        <rect
          v-for="b in bars"
          :key="b.key + '-h'"
          class="hit"
          :x="b.slotX"
          :y="M.top"
          :width="b.slot"
          :height="innerH"
          @mouseenter="hovered = b.i"
        />
      </svg>
      <div v-if="tooltip" class="tip" :style="{ left: tooltip.left, top: tooltip.top }">{{ tooltip.text }}</div>
    </div>
    <p v-if="!totalAnswered" class="empty-note">No answers yet — answer a few questions to start your streak.</p>
  </section>
</template>

<style scoped>
.activity {
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 14px;
  padding: 20px 22px 14px;
  box-shadow: var(--shadow);
  margin-bottom: 24px;
}
.activity-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 16px;
  flex-wrap: wrap;
}
.activity-head h3 { margin: 0; font-size: 16px; }
.activity-sub { margin: 2px 0 0; color: var(--muted); font-size: 13px; }

.seg {
  display: inline-flex;
  background: var(--panel-2);
  border: 1px solid var(--border);
  border-radius: 9px;
  padding: 2px;
}
.seg button {
  border: 0;
  background: transparent;
  color: var(--muted);
  font: inherit;
  font-size: 13px;
  padding: 5px 14px;
  border-radius: 7px;
  cursor: pointer;
}
.seg button.on { background: var(--accent); color: #fff; }

/* four equal columns with hairline dividers — matches the stat tiles below */
.activity-stats {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  margin: 18px 0 14px;
  border-block: 1px solid var(--border);
  padding: 12px 0;
}
.activity-stats > div {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 18px;
}
.activity-stats > div + div { border-left: 1px solid var(--border); }
.activity-stats > div:first-child { padding-left: 0; }
.activity-stats .n {
  font-size: 24px;
  font-weight: 700;
  letter-spacing: -0.02em;
  color: var(--text);
  line-height: 1.15;
  font-variant-numeric: tabular-nums;
}

.chart-wrap { position: relative; }
.chart-svg { display: block; width: 100%; height: auto; }

.grid, .baseline {
  stroke: var(--border);
  stroke-width: 1;
  vector-effect: non-scaling-stroke;
}
.bar { fill: var(--chart-bar); transition: fill 0.12s; }
.bar.hot { fill: var(--chart-bar-hot); }
.hit { fill: transparent; }
.ytick, .xtick {
  fill: var(--muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.ytick { text-anchor: end; }
.xtick { text-anchor: middle; }

.tip {
  position: absolute;
  transform: translate(-50%, calc(-100% - 6px));
  background: var(--text);
  color: var(--panel);
  font-size: 12px;
  padding: 3px 8px;
  border-radius: 6px;
  white-space: nowrap;
  pointer-events: none;
  z-index: 2;
}
.empty-note { color: var(--muted); font-size: 13px; margin: 10px 0 0; }

@media (max-width: 560px) {
  .activity-stats { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px 0; }
  .activity-stats > div:nth-child(3) { border-left: 0; padding-left: 0; }
}
</style>
