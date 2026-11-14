/*
 * EmbyDJ deck playback engine (AudioWorklet).
 *
 * Plays a decoded track from memory with a freely variable - also negative - speed:
 *   - normal playback at `rate` (tempo fader x pitch bend)
 *   - scratch mode: the read head follows a target position driven by the jog wheel
 *   - click-free jumps (seek, hot cue, loop wrap) via a short crossfade
 *   - click-free start / stop via a short gain ramp
 * Interpolation: 4-point cubic Hermite.
 *
 * Messages in (port):  load {L, R}, unload, play {pos?, rate, when?}, stop, seek {pos}, rate {rate},
 *                      loop {active, start, end}, scratchBegin {pos}, scratchMove {pos},
 *                      scratchEnd {resume, pos?, rate, ramp?}  (ramp: seconds of motor start from standstill),
 *                      spin {vel, dur, resume, resumePos?, rate, endVel?, shape?, ramp?}
 *                        (backspin: vel < 0, brake: vel > 0; the speed runs from vel to endVel (default 0),
 *                        shape 'late' (1 - u^3) slows down little at first and much at the end (short quiet tail),
 *                        ramp: seconds the "motor" needs to bring the record back to speed afterwards),
 *                      slice {id, start, end}
 * Messages out:        ended, pos {pos, time}   (pos in seconds, time = AudioContext time),
 *                      slice {id, L, R}
 */
class EmbyDJDeckProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.L = null;
        this.R = null;
        this.len = 0;
        this.pos = 0;          // read head, in samples
        this.rate = 1;
        this.playing = false;
        this.scratch = false;
        this.target = 0;       // scratch target, in samples
        this.vel = 0;          // current head speed, samples per output sample
        this.amp = 0;          // output gain envelope (click-free start/stop)
        this.loopS = 0;
        this.loopE = 0;
        this.loopOn = false;
        this.fadeLen = Math.round(sampleRate * 0.006);
        this.fade = 0;         // remaining crossfade samples
        this.fadePos = 0;      // read head of the outgoing signal during a crossfade
        this.fadeStep = 0;
        this.pendingPlay = null; // play scheduled for a later AudioContext time (Auto-Mix)
        this.spin = false;     // backspin / brake / spin: speed runs from spinV0 to spinEnd
        this.spinV0 = 0;
        this.spinEnd = 0;
        this.spinN = 1;        // length of the spin, in samples
        this.spinI = 0;
        this.spinLate = false;
        this.spinResume = false;
        this.spinResumePos = null;
        this.spinRamp = 0;
        this.rampN = 0;        // motor start after a spin: speed 0 -> rate over rampN samples
        this.rampI = 0;
        this.port.onmessage = (e) => this.onMessage(e.data);
    }

    onMessage(m) {
        const sr = sampleRate;
        switch (m.type) {
            case 'load':
                this.L = m.L; this.R = m.R || m.L; this.len = this.L.length;
                this.pos = 0; this.playing = false; this.scratch = false; this.vel = 0; this.amp = 0; this.fade = 0;
                this.loopOn = false;
                break;
            case 'unload':
                this.L = this.R = null; this.len = 0; this.playing = false; this.scratch = false;
                break;
            case 'play':
                this.spin = false;
                this.rampN = 0;
                if (m.when && m.when > currentTime + 0.003) { this.pendingPlay = m; break; }
                this.pendingPlay = null;
                if (m.pos != null) this.jump(m.pos * sr);
                this.rate = m.rate;
                this.playing = true;
                break;
            case 'stop':
                this.pendingPlay = null;
                this.spin = false;
                this.rampN = 0;
                this.playing = false;
                break;
            case 'seek':
                this.pendingPlay = null;
                this.spin = false;
                this.rampN = 0;
                this.jump(m.pos * sr);
                break;
            case 'rate':
                this.rate = m.rate;
                break;
            case 'loop':
                this.loopOn = !!m.active;
                this.loopS = m.start * sr;
                this.loopE = m.end * sr;
                break;
            case 'slice': {
                // copy of a region (loop -> sampler pad)
                const s0 = Math.max(0, Math.floor(m.start * sr)), s1 = Math.min(this.len, Math.floor(m.end * sr));
                const L = this.L ? this.L.slice(s0, s1) : new Float32Array(0);
                const R = this.L && this.R !== this.L ? this.R.slice(s0, s1) : null;
                this.port.postMessage({ type: 'slice', id: m.id, L: L, R: R }, R ? [L.buffer, R.buffer] : [L.buffer]);
                break;
            }
            case 'scratchBegin':
                this.spin = false;
                this.rampN = 0;
                this.scratch = true;
                this.target = m.pos * sr;
                if (Math.abs(this.target - this.pos) > sr * 0.05) this.jump(this.target);
                this.vel = this.playing ? this.rate : 0;
                break;
            case 'scratchMove':
                this.target = m.pos * sr;
                break;
            case 'spin':
                // starts from the current head (also straight out of a scratch)
                this.scratch = false;
                this.spin = true;
                this.vel = m.vel;
                this.spinV0 = m.vel;
                this.spinEnd = m.endVel || 0;
                this.spinN = Math.max(1, Math.round(m.dur * sr));
                this.spinI = 0;
                this.spinLate = m.shape === 'late';
                this.spinResume = !!m.resume;
                this.spinResumePos = m.resumePos;
                this.spinRamp = m.ramp || 0;
                this.rampN = 0;
                this.rate = m.rate;
                this.playing = false;
                break;
            case 'scratchEnd':
                this.scratch = false;
                if (m.resume) {
                    this.rate = m.rate;
                    this.playing = true;
                    if (m.pos != null) this.jump(m.pos * sr);
                    if (m.ramp > 0 && m.pos == null) {
                        // motor start; the position is reported when the record is up to speed
                        this.rampN = Math.round(m.ramp * sr);
                        this.rampI = 0;
                        break;
                    }
                    this.rampN = 0;
                    // tell the main thread where playback really continues
                    this.port.postMessage({ type: 'pos', pos: this.pos / sr, time: currentTime });
                } else {
                    this.playing = false;
                }
                break;
        }
    }

    jump(p) {
        if (this.amp > 0.001 && this.L) {
            this.fadePos = this.pos;
            this.fadeStep = this.vel || this.rate;
            this.fade = this.fadeLen;
        }
        this.pos = Math.max(0, Math.min(p, this.len - 1));
    }

    sample(ch, p) {
        const i = Math.floor(p), t = p - i, n = this.len;
        if (i < 0 || i >= n) return 0;
        const xm1 = i > 0 ? ch[i - 1] : ch[i];
        const x0 = ch[i];
        const x1 = i + 1 < n ? ch[i + 1] : x0;
        const x2 = i + 2 < n ? ch[i + 2] : x1;
        const c1 = 0.5 * (x1 - xm1);
        const c2 = xm1 - 2.5 * x0 + 2 * x1 - 0.5 * x2;
        const c3 = 0.5 * (x2 - xm1) + 1.5 * (x0 - x1);
        return ((c3 * t + c2) * t + c1) * t + x0;
    }

    process(inputs, outputs) {
        const out = outputs[0];
        const oL = out[0], oR = out.length > 1 ? out[1] : null;
        const n = oL.length;
        if (!this.L) return true;

        const sr = sampleRate;
        if (this.pendingPlay && currentTime >= this.pendingPlay.when) {
            const m = this.pendingPlay;
            this.pendingPlay = null;
            if (m.pos != null) this.jump(m.pos * sr);
            this.rate = m.rate;
            this.playing = true;
        }
        const follow = 1 / (sr * 0.025);   // scratch: close the gap to the target within ~25 ms
        const smoothing = 0.0025;          // scratch: speed smoothing per sample (~8 ms)
        const ampStep = 0.004;             // start/stop ramp (~5 ms)

        for (let i = 0; i < n; i++) {
            let step;
            if (this.spin) {
                const u = this.spinI / this.spinN;
                step = this.vel = this.spinEnd + (this.spinV0 - this.spinEnd) * (this.spinLate ? 1 - u * u * u : 1 - u);
                if (++this.spinI >= this.spinN) {
                    this.vel = this.spinEnd;
                    this.spin = false;
                    if (this.spinResume) {
                        if (this.spinResumePos != null) this.jump(this.spinResumePos * sr);
                        this.playing = true;
                        if (this.spinEnd === 0 && this.spinRamp > 0 && this.spinResumePos == null) {
                            // the motor pulls the record back to speed; the position is reported when done
                            this.rampN = Math.round(this.spinRamp * sr);
                            this.rampI = 0;
                        } else {
                            this.port.postMessage({ type: 'pos', pos: this.pos / sr, time: currentTime });
                        }
                    }
                }
            } else if (this.scratch) {
                const want = (this.target - this.pos) * follow;
                this.vel += (want - this.vel) * smoothing;
                step = this.vel;
            } else if (this.playing) {
                if (this.rampN > 0) {
                    step = this.rate * this.rampI / this.rampN;
                    if (++this.rampI >= this.rampN) {
                        this.rampN = 0;
                        this.port.postMessage({ type: 'pos', pos: this.pos / sr, time: currentTime });
                    }
                } else {
                    step = this.rate;
                }
                this.vel = step;
            } else {
                // stopping: let the platter run out during the fade-out instead of freezing
                step = this.vel * this.amp;
            }

            const on = this.playing || this.scratch || this.spin;
            this.amp += ((on ? 1 : 0) - this.amp) * ampStep;

            let l = 0, r = 0;
            if (this.amp > 0.0005) {
                l = this.sample(this.L, this.pos);
                r = this.sample(this.R, this.pos);
                if (this.fade > 0) {
                    const f = this.fade / this.fadeLen;
                    l = l * (1 - f) + this.sample(this.L, this.fadePos) * f;
                    r = r * (1 - f) + this.sample(this.R, this.fadePos) * f;
                    this.fadePos += this.fadeStep;
                    this.fade--;
                }
                l *= this.amp; r *= this.amp;
            }
            oL[i] = l;
            if (oR) oR[i] = r;

            this.pos += step;

            // loop wrap (forward playback only; scratching may leave the loop freely)
            if (this.loopOn && !this.scratch && !this.spin && step > 0 && this.pos >= this.loopE && this.loopE > this.loopS) {
                this.fadePos = this.pos;
                this.fadeStep = step;
                this.fade = this.fadeLen;
                this.pos -= (this.loopE - this.loopS);
            }

            if (this.pos >= this.len - 1) {
                this.pos = this.len - 1;
                this.vel = 0;
                if (this.playing && !this.scratch) {
                    this.playing = false;
                    this.port.postMessage({ type: 'ended' });
                }
            } else if (this.pos < 0) {
                this.pos = 0;
                this.vel = 0;
            }
        }
        return true;
    }
}

registerProcessor('embydj-deck', EmbyDJDeckProcessor);
