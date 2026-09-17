/**
 * Synthesised MiniDisc laser calibration: motor spin-down and spin-up hum, sled servo whirs,
 * seek clicks, laser focus chirps and a confirm tone. Nothing to download; schedules on the
 * already-unlocked AudioContext.
 */

export const CALIBRATION_SECONDS = 2.2;

function noiseBuffer(ctx: AudioContext, seconds: number): AudioBuffer {
  const buffer = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * seconds), ctx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

function envelope(gain: GainNode, start: number, peak: number, attack: number, hold: number, release: number): void {
  gain.gain.setValueAtTime(0, start);
  gain.gain.linearRampToValueAtTime(peak, start + attack);
  gain.gain.setValueAtTime(peak, start + attack + hold);
  gain.gain.exponentialRampToValueAtTime(0.0001, start + attack + hold + release);
}

export function playLaserCalibration(ctx: AudioContext, volume: number): number {
  const now = ctx.currentTime + 0.02;
  const master = ctx.createGain();
  master.gain.value = Math.max(0.05, volume) * 0.9;
  master.connect(ctx.destination);
  const stopAt = now + CALIBRATION_SECONDS + 0.2;

  // Spindle motor: winds down, pauses while the sled seeks, spins back up.
  const motor = ctx.createOscillator();
  motor.type = 'sawtooth';
  motor.frequency.setValueAtTime(118, now);
  motor.frequency.exponentialRampToValueAtTime(42, now + 0.55);
  motor.frequency.setValueAtTime(42, now + 1.15);
  motor.frequency.exponentialRampToValueAtTime(132, now + CALIBRATION_SECONDS);
  const motorFilter = ctx.createBiquadFilter();
  motorFilter.type = 'lowpass';
  motorFilter.frequency.value = 360;
  const motorGain = ctx.createGain();
  motorGain.gain.setValueAtTime(0.0001, now);
  motorGain.gain.linearRampToValueAtTime(0.05, now + 0.08);
  motorGain.gain.linearRampToValueAtTime(0.018, now + 0.6);
  motorGain.gain.linearRampToValueAtTime(0.06, now + CALIBRATION_SECONDS - 0.1);
  motorGain.gain.exponentialRampToValueAtTime(0.0001, stopAt);
  motor.connect(motorFilter).connect(motorGain).connect(master);
  motor.start(now);
  motor.stop(stopAt);

  // Sled servo whirs as the laser pickup travels across the disc.
  for (const [start, from, to] of [
    [0.32, 620, 1380],
    [0.78, 1380, 760],
    [1.22, 760, 1120],
  ] as const) {
    const servo = ctx.createOscillator();
    servo.type = 'square';
    servo.frequency.setValueAtTime(from, now + start);
    servo.frequency.exponentialRampToValueAtTime(to, now + start + 0.2);
    const band = ctx.createBiquadFilter();
    band.type = 'bandpass';
    band.frequency.value = 1100;
    band.Q.value = 4;
    const gain = ctx.createGain();
    envelope(gain, now + start, 0.035, 0.02, 0.14, 0.08);
    servo.connect(band).connect(gain).connect(master);
    servo.start(now + start);
    servo.stop(now + start + 0.3);
  }

  // Seek clicks: short filtered noise ticks at uneven intervals.
  const clickNoise = noiseBuffer(ctx, 0.02);
  for (const at of [0.14, 0.41, 0.53, 0.9, 1.02, 1.37, 1.49, 1.7]) {
    const click = ctx.createBufferSource();
    click.buffer = clickNoise;
    const highpass = ctx.createBiquadFilter();
    highpass.type = 'highpass';
    highpass.frequency.value = 2200;
    const gain = ctx.createGain();
    envelope(gain, now + at, 0.24, 0.001, 0.004, 0.03);
    click.connect(highpass).connect(gain).connect(master);
    click.start(now + at);
  }

  // Laser focus chirps rising, then a confirm tone.
  for (const [index, at] of [1.58, 1.76, 1.94].entries()) {
    const chirp = ctx.createOscillator();
    chirp.type = 'sine';
    const base = 2400 + index * 320;
    chirp.frequency.setValueAtTime(base, now + at);
    chirp.frequency.exponentialRampToValueAtTime(base * 1.35, now + at + 0.08);
    const gain = ctx.createGain();
    envelope(gain, now + at, 0.03, 0.005, 0.05, 0.05);
    chirp.connect(gain).connect(master);
    chirp.start(now + at);
    chirp.stop(now + at + 0.14);
  }
  const confirm = ctx.createOscillator();
  confirm.type = 'triangle';
  confirm.frequency.value = 1976;
  const confirmGain = ctx.createGain();
  envelope(confirmGain, now + 2.08, 0.045, 0.004, 0.06, 0.1);
  confirm.connect(confirmGain).connect(master);
  confirm.start(now + 2.08);
  confirm.stop(now + 2.3);

  // Faint pickup hiss under everything.
  const hiss = ctx.createBufferSource();
  hiss.buffer = noiseBuffer(ctx, CALIBRATION_SECONDS + 0.2);
  const hissBand = ctx.createBiquadFilter();
  hissBand.type = 'bandpass';
  hissBand.frequency.value = 3600;
  hissBand.Q.value = 0.8;
  const hissGain = ctx.createGain();
  envelope(hissGain, now, 0.012, 0.1, CALIBRATION_SECONDS - 0.3, 0.2);
  hiss.connect(hissBand).connect(hissGain).connect(master);
  hiss.start(now);

  window.setTimeout(() => master.disconnect(), (CALIBRATION_SECONDS + 0.6) * 1000);
  return CALIBRATION_SECONDS;
}
