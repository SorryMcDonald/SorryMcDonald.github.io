export type SoundName = "click" | "join" | "deal" | "turn" | "bomb" | "win" | "lose" | "error"

let context: AudioContext | null = null
let muted = localStorage.getItem("game-muted") === "true"

function audio() {
  context ??= new AudioContext()
  if (context.state === "suspended") void context.resume()
  return context
}

function tone(frequency: number, start: number, duration: number, gain = 0.05, type: OscillatorType = "sine") {
  const ctx = audio()
  const oscillator = ctx.createOscillator()
  const volume = ctx.createGain()
  oscillator.type = type
  oscillator.frequency.setValueAtTime(frequency, ctx.currentTime + start)
  volume.gain.setValueAtTime(0, ctx.currentTime + start)
  volume.gain.linearRampToValueAtTime(gain, ctx.currentTime + start + 0.01)
  volume.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + duration)
  oscillator.connect(volume).connect(ctx.destination)
  oscillator.start(ctx.currentTime + start)
  oscillator.stop(ctx.currentTime + start + duration + 0.02)
}

export function playSound(name: SoundName) {
  if (muted) return
  try {
    if (name === "click") tone(520, 0, 0.06, 0.035)
    if (name === "join") [440, 660, 880].forEach((value, index) => tone(value, index * 0.06, 0.13, 0.04))
    if (name === "deal") [760, 680, 600].forEach((value, index) => tone(value, index * 0.035, 0.07, 0.025, "triangle"))
    if (name === "turn") tone(920, 0, 0.12, 0.04, "triangle")
    if (name === "bomb") [130, 82, 55].forEach((value, index) => tone(value, index * 0.035, 0.35, 0.12, "sawtooth"))
    if (name === "win") [523, 659, 784, 1047].forEach((value, index) => tone(value, index * 0.1, 0.28, 0.055))
    if (name === "lose") [392, 330, 262].forEach((value, index) => tone(value, index * 0.12, 0.3, 0.045, "triangle"))
    if (name === "error") [220, 180].forEach((value, index) => tone(value, index * 0.08, 0.15, 0.05, "square"))
  } catch {
    // 浏览器禁止自动播放时静默跳过，首次点击后即可正常播放。
  }
}

export function isMuted() {
  return muted
}

export function toggleMuted() {
  muted = !muted
  localStorage.setItem("game-muted", String(muted))
  if (!muted) playSound("click")
  return muted
}
