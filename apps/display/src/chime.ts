// A soft two-note chime, drawn with Web Audio so no sound file ships. Browsers let
// a page play sound only once someone has used it, so it stays silent until then.
let context: AudioContext | undefined;
let used = false;

const NOTES = [
  { hz: 1318.5, at: 0 },
  { hz: 1760, at: 0.11 },
];
const PEAK = 0.05;
const DECAY_S = 0.9;

export function listenForUse() {
  const mark = () => {
    used = true;
    removeEventListener("pointerdown", mark, true);
    removeEventListener("keydown", mark, true);
  };
  addEventListener("pointerdown", mark, true);
  addEventListener("keydown", mark, true);
}

function open(): AudioContext | undefined {
  try {
    context ??= new AudioContext();
  } catch {
    return undefined;
  }
  return context;
}

function play(audio: AudioContext) {
  const now = audio.currentTime;
  for (const { hz, at } of NOTES) {
    const tone = audio.createOscillator();
    const level = audio.createGain();
    tone.type = "sine";
    tone.frequency.value = hz;
    level.gain.setValueAtTime(0, now + at);
    level.gain.linearRampToValueAtTime(PEAK, now + at + 0.012);
    level.gain.exponentialRampToValueAtTime(0.0001, now + at + DECAY_S);
    tone.connect(level).connect(audio.destination);
    tone.start(now + at);
    tone.stop(now + at + DECAY_S + 0.05);
  }
}

// From a click or a key press, such as the switch that turns the chime on: it
// counts as use, so the chime can play from then on.
export function wake() {
  used = true;
  void open()?.resume().catch(() => {});
}

export function chime() {
  if (!used && !navigator.userActivation?.hasBeenActive) return;
  const audio = open();
  if (!audio) return;
  if (audio.state === "running") play(audio);
  else
    void audio
      .resume()
      .then(() => play(audio))
      .catch(() => {});
}
