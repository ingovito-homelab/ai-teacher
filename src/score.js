// "8/10" -> 8, "4/5" -> 8, "7" -> 7 (assumed /10); null when unparseable
export function parseScore(score) {
  if (typeof score === 'number') return score
  if (typeof score !== 'string') return null
  const frac = score.match(/(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)/)
  if (frac) return (Number(frac[1]) / Number(frac[2])) * 10
  const num = score.match(/\d+(?:\.\d+)?/)
  return num ? Number(num[0]) : null
}
