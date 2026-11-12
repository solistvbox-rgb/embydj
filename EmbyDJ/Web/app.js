/*
 * EmbyDJ web app - two decks, mixer and library browser on top of the Web Audio API.
 * Served by the EmbyDJ plugin at <server>/emby/EmbyDJ/Web/index.html (same origin as Emby).
 */
(function () {
    'use strict';

    // =====================================================================================
    // i18n
    // =====================================================================================
    var LANG = 'en'; // UI is English only
    var TEXT = {
        en: {
            noTrack: 'No track loaded', search: 'Search title, artist, album, genre…', sortTitle: 'Title', sortArtist: 'Artist',
            sortAlbum: 'Album', sortAdded: 'Recently added', sortRandom: 'Random', colTitle: 'Title',
            colArtist: 'Artist', colAlbum: 'Album', colTime: 'Time', shortcuts: 'Keyboard shortcuts',
            hotcueHelp: 'Hot cue: click = set / jump, right-click = delete.',
            allTracks: 'All tracks', libraries: 'Libraries', playlists: 'Playlists', tracks: '{n} tracks',
            smpEmpty: 'empty', smpEmptyHint: 'Click: load a file · drop a track, file or folder entry · right-click: options',
            smpSaveFailed: 'Saving the pads failed: {e}', smpLoadFailed: 'Sample could not be loaded: {e}',
            smpTooLarge: 'Sample is larger than 10 MB.', smpUnsupported: 'Not a supported audio file: {n}',
            smpLongTrack: 'Long track - the whole track is loaded into the pad.', smpNoLoop: 'Set a loop on the deck first.',
            smpBankFull: 'No free pad in this bank.', smpLoopSaved: 'Loop saved to pad {n}.', smpRename: 'Pad name',
            smpFolderUnsupported: 'The folder browser needs Chrome or Edge (https or localhost).',
            smpFolderChoose: 'Choose a folder with your samples.', smpFolderReconnect: 'Allow access to the sample folder again.',
            smpFolderEmpty: 'No audio files or folders here.',
            noBackspin: 'Backspin needs the Worklet engine (https or localhost).',
            amNext: 'Next: {n}', amLoading: 'Loading next track…', amNoTrack: 'Auto-Mix: no track to play in the current list.',
            amStopped: 'Auto-Mix stopped (manual control).', trackSortHint: 'Sorting by track number works when the list contains a single album (e.g. search for the album).',
            loadingMore: 'Loading…', noMusic: 'No music found.', noMatch: 'No title, artist, album or genre matches.', downloading: 'Loading track… {p}',
            decoding: 'Decoding…', analyzing: 'Analyzing…', deckPlaying: 'Deck {d} is playing – pause it first.',
            bothPlaying: 'Both decks are playing.', loadFailed: 'Could not load track: {e}',
            noAuth: 'Not signed in', noAuthHint: 'Open EmbyDJ from the Emby web app (left menu → EmbyDJ) while signed in.',
            openEmby: 'Open Emby', syncNoBpm: 'Sync needs a BPM on both decks.', loopNoBpm: 'Beat loops need a BPM.',
            ready: 'Signed in as {u}', noScratch: 'Engine: basic (no scratching - needs https)', newTab: 'Open in new tab', remain: 'REMAIN', effect: 'EFFECT', longTrack: 'Very long track – loading needs a lot of memory.',
            tempoOutOfRange: 'Tempo difference too large for sync.'
        }
    };

    function t(key, vars) {
        var s = (TEXT[LANG] && TEXT[LANG][key]) || TEXT.en[key] || key;
        if (vars) Object.keys(vars).forEach(function (k) { s = s.replace('{' + k + '}', vars[k]); });
        return s;
    }

    function applyI18n(root) {
        root.querySelectorAll('[data-i18n]').forEach(function (el) { el.textContent = t(el.dataset.i18n); });
        root.querySelectorAll('[data-i18n-placeholder]').forEach(function (el) { el.placeholder = t(el.dataset.i18nPlaceholder); });
    }

    // =====================================================================================
    // helpers
    // =====================================================================================
    var $ = function (sel, root) { return (root || document).querySelector(sel); };
    function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
    function frac(x) { return x - Math.floor(x); }
    function fmtTime(s, tenths) {
        if (!isFinite(s) || s < 0) s = 0;
        var m = Math.floor(s / 60), sec = s - m * 60;
        var str = m + ':' + (sec < 10 ? '0' : '') + (tenths ? sec.toFixed(1) : Math.floor(sec));
        return str;
    }
    function ticksToSec(ticks) { return ticks ? ticks / 1e7 : 0; }
    function sleep0() { return new Promise(function (r) { setTimeout(r, 0); }); }

    var toastTimer = null;
    function toast(msg) {
        var el = $('#toast');
        el.textContent = msg;
        el.classList.add('show');
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.classList.remove('show'); }, 2600);
    }

    // =====================================================================================
    // auth + API (same origin as Emby; token taken from the hosting Emby web app)
    // =====================================================================================
    var BASE = location.pathname.split('/EmbyDJ/')[0]; // usually "/emby"
    var auth = null;

    function findAuth() {
        var wins = [];
        try { if (window.parent && window.parent !== window) wins.push(window.parent); } catch (e) { /* ignore */ }
        try { if (window.opener) wins.push(window.opener); } catch (e) { /* ignore */ }
        for (var i = 0; i < wins.length; i++) {
            try {
                var ac = wins[i].ApiClient;
                if (ac && ac.accessToken && ac.accessToken() && ac.getCurrentUserId()) {
                    return { token: ac.accessToken(), userId: ac.getCurrentUserId() };
                }
            } catch (e) { /* cross-origin or not ready */ }
        }
        try {
            var saved = JSON.parse(sessionStorage.getItem('embydj-auth') || 'null');
            if (saved && saved.token && saved.userId) return saved;
        } catch (e) { /* ignore */ }
        // Fallback: credentials the Emby web app keeps in localStorage.
        try {
            for (var k = 0; k < localStorage.length; k++) {
                var key = localStorage.key(k);
                if (!/credentials/i.test(key)) continue;
                var data = JSON.parse(localStorage.getItem(key));
                var servers = (data && data.Servers) || [];
                for (var j = 0; j < servers.length; j++) {
                    if (servers[j].AccessToken && servers[j].UserId) return { token: servers[j].AccessToken, userId: servers[j].UserId };
                }
            }
        } catch (e) { /* ignore */ }
        return null;
    }

    function qs(params) {
        if (!params) return '';
        var parts = [];
        Object.keys(params).forEach(function (k) {
            var v = params[k];
            if (v === undefined || v === null || v === '') return;
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
        });
        return parts.length ? '?' + parts.join('&') : '';
    }

    function apiFetch(path, params, opts) {
        opts = opts || {};
        var headers = Object.assign({ 'X-Emby-Token': auth.token }, opts.headers || {});
        return fetch(BASE + path + qs(params), Object.assign({}, opts, { headers: headers })).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return r;
        });
    }
    function apiJson(path, params) { return apiFetch(path, params).then(function (r) { return r.json(); }); }

    function imageUrl(item, size) {
        if (item.AlbumId && item.AlbumPrimaryImageTag) {
            return BASE + '/Items/' + item.AlbumId + '/Images/Primary' + qs({ tag: item.AlbumPrimaryImageTag, maxHeight: size, quality: 80 });
        }
        if (item.ImageTags && item.ImageTags.Primary) {
            return BASE + '/Items/' + item.Id + '/Images/Primary' + qs({ tag: item.ImageTags.Primary, maxHeight: size, quality: 80 });
        }
        return '';
    }
    function artistOf(item) {
        return (item.Artists && item.Artists.length ? item.Artists.join(', ') : item.AlbumArtist) || '';
    }

    // ---- DJ metadata (BPM, cues) stored by the plugin ----
    var metaCache = {}; // itemId -> meta object (or null = known to have none)

    function fetchMeta(ids) {
        var missing = ids.filter(function (id) { return !(id in metaCache); });
        if (!missing.length) return Promise.resolve();
        // chunks of 100 ids keep the URL short
        var chunks = [];
        for (var i = 0; i < missing.length; i += 100) chunks.push(missing.slice(i, i + 100));
        return Promise.all(chunks.map(function (chunk) {
            return apiJson('/EmbyDJ/Tracks', { Ids: chunk.join(',') }).then(function (res) {
                chunk.forEach(function (id) { metaCache[id] = res[id] || null; });
            }).catch(function () { /* metadata is optional */ });
        }));
    }

    function saveMeta(id, meta) {
        metaCache[id] = meta;
        updateLibraryBpm(id);
        return apiFetch('/EmbyDJ/Tracks/' + encodeURIComponent(id), null, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ Data: JSON.stringify(meta) })
        }).catch(function (e) { console.warn('EmbyDJ: saving track data failed', e); });
    }

    // Downloads the original file (or a transcoded MP3 as fallback) with progress.
    function fetchAudio(item, transcode, onProgress) {
        var path = transcode ? '/Audio/' + item.Id + '/stream.mp3' : '/Audio/' + item.Id + '/stream';
        var params = transcode ? { AudioCodec: 'mp3', AudioBitrate: 320000 } : { static: true };
        return apiFetch(path, params).then(function (res) {
            var total = +res.headers.get('Content-Length') || 0;
            if (!res.body || !res.body.getReader) return res.arrayBuffer();
            var reader = res.body.getReader();
            var chunks = [], received = 0;
            function pump() {
                return reader.read().then(function (r) {
                    if (r.done) {
                        var out = new Uint8Array(received), off = 0;
                        chunks.forEach(function (c) { out.set(c, off); off += c.length; });
                        return out.buffer;
                    }
                    chunks.push(r.value);
                    received += r.value.length;
                    onProgress(total ? received / total : -1, received);
                    return pump();
                });
            }
            return pump();
        });
    }

    // =====================================================================================
    // audio engine
    // =====================================================================================
    var ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
    var masterGain = ctx.createGain();
    var limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -1;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.002;
    limiter.release.value = 0.1;
    var masterAnalyser = ctx.createAnalyser();
    masterAnalyser.fftSize = 1024;
    masterGain.connect(limiter);
    limiter.connect(masterAnalyser);
    masterAnalyser.connect(ctx.destination);

    function resumeAudio() { if (ctx.state === 'suspended') ctx.resume(); }
    document.addEventListener('pointerdown', resumeAudio, true);
    document.addEventListener('keydown', resumeAudio, true);

    function dbToGain(db) { return Math.pow(10, db / 20); }
    function smooth(param, value) { param.setTargetAtTime(value, ctx.currentTime, 0.012); }

    // ---- waveform analysis: 3 frequency bands + peak, FPS bins per second ----
    var WAVE_FPS = 200;

    function analyzeWave(buffer) {
        var sr = buffer.sampleRate, n = buffer.length, hop = sr / WAVE_FPS;
        var bins = Math.ceil(n / hop);
        var c0 = buffer.getChannelData(0);
        var c1 = buffer.numberOfChannels > 1 ? buffer.getChannelData(1) : c0;
        var low = new Float32Array(bins), mid = new Float32Array(bins), high = new Float32Array(bins), peak = new Float32Array(bins);
        var aL = 1 - Math.exp(-2 * Math.PI * 180 / sr), aM = 1 - Math.exp(-2 * Math.PI * 2200 / sr);
        var l1 = 0, l2 = 0, m1 = 0, m2 = 0, i = 0, b = 0;

        function chunk() {
            var stop = Math.min(bins, b + 2048);
            for (; b < stop; b++) {
                var end = Math.min(n, Math.round((b + 1) * hop));
                var sl = 0, sm = 0, sh = 0, pk = 0, c = 0;
                for (; i < end; i++) {
                    var x = (c0[i] + c1[i]) * 0.5;
                    l1 += aL * (x - l1); l2 += aL * (l1 - l2);
                    m1 += aM * (x - m1); m2 += aM * (m1 - m2);
                    var lo = l2, mi = m2 - l2, hi = x - m2;
                    sl += lo * lo; sm += mi * mi; sh += hi * hi;
                    var ax = x < 0 ? -x : x;
                    if (ax > pk) pk = ax;
                    c++;
                }
                if (c) { low[b] = Math.sqrt(sl / c); mid[b] = Math.sqrt(sm / c); high[b] = Math.sqrt(sh / c); }
                peak[b] = pk;
            }
            if (b < bins) return sleep0().then(chunk);
            var loudness = measureLoudness(low, mid, high, WAVE_FPS);
            [low, mid, high, peak].forEach(function (arr) {
                var mx = 1e-9;
                for (var k = 0; k < arr.length; k++) if (arr[k] > mx) mx = arr[k];
                for (k = 0; k < arr.length; k++) arr[k] /= mx;
            });
            return { fps: WAVE_FPS, bins: bins, low: low, mid: mid, high: high, peak: peak, loudness: loudness };
        }
        return chunk();
    }

    // ---- loudness ----
    // Integrated loudness in LUFS, an approximation of ITU-R BS.1770 / EBU R128 from the band levels:
    // weighted like the K-filter (less low end, +4 dB highs), 400 ms blocks every 100 ms, absolute gate
    // -70 LUFS, relative gate -10 LU. The +3 dB stands for the two stereo channels (the analysis uses
    // the mono sum). Accurate enough to bring tracks to a similar level, which is all Auto-Gain needs.
    function measureLoudness(low, mid, high, fps) {
        var n = low.length, block = Math.round(fps * 0.4), step = Math.round(fps * 0.1);
        var pw = new Float64Array(n + 1);   // prefix sums of the weighted power
        for (var i = 0; i < n; i++) pw[i + 1] = pw[i] + 0.5 * low[i] * low[i] + mid[i] * mid[i] + 2.5 * high[i] * high[i];
        var blocks = [];
        for (var s = 0; s + block <= n; s += step) blocks.push((pw[s + block] - pw[s]) / block);
        if (!blocks.length) return null;
        var lufs = function (p) { return -0.691 + 3.01 + 10 * Math.log10(p); };
        var avg = function (arr) { var t = 0; arr.forEach(function (p) { t += p; }); return t / arr.length; };
        var aboveAbs = blocks.filter(function (p) { return p > 0 && lufs(p) > -70; });
        if (!aboveAbs.length) return null;
        var relGate = lufs(avg(aboveAbs)) - 10;
        var gated = aboveAbs.filter(function (p) { return lufs(p) > relGate; });
        return Math.round(lufs(avg(gated)) * 10) / 10;
    }

    // ---- Auto-Gain: brings every track to about the same loudness via the channel GAIN ----
    var AUTO_GAIN_TARGET = -14;   // LUFS
    var AUTO_GAIN_MAX = 9;        // dB, max. boost (the limiter catches the rest)
    var autoGain = (function () { try { return localStorage.getItem('embydj-autogain') !== 'off'; } catch (e) { return true; } })();

    function autoGainDb(loudness) { return clamp(AUTO_GAIN_TARGET - loudness, -12, AUTO_GAIN_MAX); }

    // ---- BPM + first-beat detection (onset envelope, autocorrelation, comb refinement) ----
    function detectBpm(w) {
        var fps = w.fps, N = w.bins;
        if (N < fps * 15) return null;

        var nov = new Float32Array(N), prev = 0;
        for (var i = 0; i < N; i++) {
            var e = Math.log(1 + 40 * (w.low[i] + 0.35 * w.mid[i]));
            var d = e - prev;
            nov[i] = d > 0 ? d : 0;
            prev = e;
        }
        // subtract local mean (adaptive threshold)
        var win = Math.round(fps * 0.3), pre = new Float64Array(N + 1);
        for (i = 0; i < N; i++) pre[i + 1] = pre[i] + nov[i];
        var o = new Float32Array(N);
        for (i = 0; i < N; i++) {
            var a = Math.max(0, i - win), z = Math.min(N, i + win);
            var v = nov[i] - (pre[z] - pre[a]) / (z - a);
            o[i] = v > 0 ? v : 0;
        }

        // analysis region: at most 6 minutes from the middle of the track
        var len = Math.min(N - 2, fps * 360);
        var s0 = Math.max(1, Math.floor((N - len) / 2));

        // coarse: weighted autocorrelation over 60-200 BPM
        var lagMin = Math.floor(fps * 60 / 200), lagMax = Math.ceil(fps * 60 / 60);
        var acLen = Math.min(len, fps * 120);
        var best = -1, bestLag = 0;
        for (var L = lagMin; L <= lagMax; L++) {
            var s = 0;
            for (var k = s0; k < s0 + acLen - L; k++) s += o[k] * o[k + L];
            var bpm = 60 * fps / L;
            var lg = Math.log(bpm / 125) / Math.LN2;
            var score = s * Math.exp(-0.5 * lg * lg / 0.5);
            if (score > best) { best = score; bestLag = L; }
        }
        if (!bestLag || best <= 0) return null;

        function comb(p) {
            var bestS = -1, bestPh = 0;
            for (var ph = 0; ph < p; ph += 1) {
                var sum = 0, cnt = 0;
                for (var x = s0 + ph; x < s0 + len - 1; x += p) {
                    var q = Math.round(x);
                    sum += o[q] + 0.5 * (o[q - 1] + o[q + 1]);
                    cnt++;
                }
                if (cnt && sum / cnt > bestS) { bestS = sum / cnt; bestPh = ph; }
            }
            return { score: bestS, phase: bestPh };
        }

        // fine: comb filter around the coarse period
        var bestP = bestLag, bestC = { score: -1, phase: 0 };
        for (var p = bestLag - 1.5; p <= bestLag + 1.5; p += 0.02) {
            var c = comb(p);
            if (c.score > bestC.score) { bestC = c; bestP = p; }
        }
        var bpmOut = 60 * fps / bestP;
        bpmOut = Math.abs(bpmOut - Math.round(bpmOut)) < 0.08 ? Math.round(bpmOut) : Math.round(bpmOut * 100) / 100;
        var period = 60 * fps / bpmOut;
        var ph = comb(period).phase;
        var offset = ((s0 + ph) % period) / fps;
        return { bpm: bpmOut, offset: offset };
    }

    // ---- colour cache for waveform columns ----
    var colorCache = {};
    function bandColor(l, m, h) {
        var mx = Math.max(l, m, h) || 1;
        var r = Math.round(l / mx * 15), g = Math.round(m / mx * 15), b = Math.round(h / mx * 15);
        var key = (r << 8) | (g << 4) | b;
        var col = colorCache[key];
        if (!col) {
            col = 'rgb(' + Math.round(40 + r * 14.3) + ',' + Math.round(40 + g * 14.3) + ',' + Math.round(40 + b * 14.3) + ')';
            colorCache[key] = col;
        }
        return col;
    }

    // =====================================================================================
    // Effects. Each factory returns { input, output, set(p1, p2, bpm) -> label, dispose() }.
    // p1/p2 are knob positions 0..1; bpm is the deck's current effective BPM (0 = unknown).
    // =====================================================================================
    var BEAT_STEPS = [1 / 8, 1 / 4, 3 / 8, 1 / 2, 3 / 4, 1, 3 / 2, 2];
    var BEAT_NAMES = ['1/8', '1/4', '3/8', '1/2', '3/4', '1', '3/2', '2'];
    var SWEEP_STEPS = [1, 2, 4, 8, 16, 32];

    function stepOf(steps, v) { return Math.min(steps.length - 1, Math.floor(v * steps.length)); }
    function beatSeconds(beats, bpm) { return beats * 60 / (bpm || 120); }

    function nodeBag() {
        var nodes = [], oscs = [];
        return {
            add: function (n) { nodes.push(n); return n; },
            osc: function (o) { oscs.push(o); nodes.push(o); o.start(); return o; },
            dispose: function () {
                oscs.forEach(function (o) { try { o.stop(); } catch (e) { /* ignore */ } });
                nodes.forEach(function (n) { try { n.disconnect(); } catch (e) { /* ignore */ } });
            }
        };
    }

    function makeEcho() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        var d = bag.add(ctx.createDelay(4)), fb = bag.add(ctx.createGain());
        var lp = bag.add(ctx.createBiquadFilter()), hp = bag.add(ctx.createBiquadFilter());
        lp.type = 'lowpass'; lp.frequency.value = 4500;
        hp.type = 'highpass'; hp.frequency.value = 180;
        input.connect(d); d.connect(lp); lp.connect(hp); hp.connect(fb); fb.connect(d); d.connect(output);
        return {
            input: input, output: output, dispose: bag.dispose,
            set: function (p1, p2, bpm) {
                var i = stepOf(BEAT_STEPS, p1);
                smooth(d.delayTime, Math.min(3.9, beatSeconds(BEAT_STEPS[i], bpm)));
                smooth(fb.gain, p2 * 0.9);
                return BEAT_NAMES[i] + (bpm ? ' Beat' : ' (120)');
            }
        };
    }

    function makePingPong() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        input.channelCount = 1; input.channelCountMode = 'explicit';
        var dl = bag.add(ctx.createDelay(4)), dr = bag.add(ctx.createDelay(4)), fb = bag.add(ctx.createGain());
        var lp = bag.add(ctx.createBiquadFilter()); lp.type = 'lowpass'; lp.frequency.value = 5000;
        var merger = bag.add(ctx.createChannelMerger(2));
        input.connect(dl); dl.connect(dr); dr.connect(lp); lp.connect(fb); fb.connect(dl);
        dl.connect(merger, 0, 0); dr.connect(merger, 0, 1); merger.connect(output);
        return {
            input: input, output: output, dispose: bag.dispose,
            set: function (p1, p2, bpm) {
                var i = stepOf(BEAT_STEPS, p1), s = Math.min(3.9, beatSeconds(BEAT_STEPS[i], bpm));
                smooth(dl.delayTime, s); smooth(dr.delayTime, s);
                smooth(fb.gain, p2 * 0.85);
                return BEAT_NAMES[i] + (bpm ? ' Beat' : ' (120)');
            }
        };
    }

    function makeImpulse(seconds) {
        var len = Math.max(1, Math.round(ctx.sampleRate * seconds));
        var buf = ctx.createBuffer(2, len, ctx.sampleRate);
        for (var c = 0; c < 2; c++) {
            var data = buf.getChannelData(c);
            for (var i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
        }
        return buf;
    }

    function makeReverb() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        var hp = bag.add(ctx.createBiquadFilter()); hp.type = 'highpass'; hp.frequency.value = 200;
        var lp = bag.add(ctx.createBiquadFilter()); lp.type = 'lowpass';
        var conv = null, decay = 0, timer = null;
        input.connect(hp); lp.connect(output);
        output.gain.value = 0.8;
        function rebuild(sec) {
            var next = bag.add(ctx.createConvolver());
            next.buffer = makeImpulse(sec);
            hp.connect(next); next.connect(lp);
            if (conv) { var old = conv; setTimeout(function () { try { hp.disconnect(old); old.disconnect(); } catch (e) { /* ignore */ } }, 50); }
            conv = next;
        }
        return {
            input: input, output: output,
            dispose: function () { clearTimeout(timer); bag.dispose(); },
            set: function (p1, p2) {
                var sec = Math.round((0.4 + p1 * 5.6) * 10) / 10;
                if (sec !== decay) {
                    decay = sec;
                    clearTimeout(timer);
                    if (!conv) rebuild(sec); else timer = setTimeout(function () { rebuild(decay); }, 120);
                }
                smooth(lp.frequency, 800 * Math.pow(20, p2));
                return sec.toFixed(1) + ' s';
            }
        };
    }

    function makeFlanger() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        var d = bag.add(ctx.createDelay(0.05)), fb = bag.add(ctx.createGain());
        var lfo = ctx.createOscillator(), depth = bag.add(ctx.createGain());
        d.delayTime.value = 0.004;
        lfo.type = 'triangle';
        lfo.connect(depth); depth.connect(d.delayTime);
        input.connect(d); d.connect(fb); fb.connect(d); d.connect(output);
        bag.osc(lfo);
        return {
            input: input, output: output, dispose: bag.dispose,
            set: function (p1, p2, bpm) {
                var i = stepOf(SWEEP_STEPS, p1);
                smooth(lfo.frequency, 1 / beatSeconds(SWEEP_STEPS[i], bpm));
                smooth(depth.gain, 0.0008 + p2 * 0.0028);
                smooth(fb.gain, 0.3 + p2 * 0.55);
                return SWEEP_STEPS[i] + (bpm ? ' Beats' : ' (120)');
            }
        };
    }

    function makePhaser() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        var lfo = ctx.createOscillator(), depth = bag.add(ctx.createGain());
        var prev = input, stages = [];
        for (var i = 0; i < 6; i++) {
            var ap = bag.add(ctx.createBiquadFilter());
            ap.type = 'allpass'; ap.frequency.value = 900; ap.Q.value = 0.6;
            depth.connect(ap.frequency);
            prev.connect(ap); prev = ap; stages.push(ap);
        }
        prev.connect(output);
        lfo.connect(depth);
        bag.osc(lfo);
        return {
            input: input, output: output, dispose: bag.dispose,
            set: function (p1, p2, bpm) {
                var k = stepOf(SWEEP_STEPS, p1);
                smooth(lfo.frequency, 1 / beatSeconds(SWEEP_STEPS[k], bpm));
                smooth(depth.gain, 200 + p2 * 700);
                return SWEEP_STEPS[k] + (bpm ? ' Beats' : ' (120)');
            }
        };
    }

    function makeDistortion() {
        var bag = nodeBag();
        var input = bag.add(ctx.createGain()), output = bag.add(ctx.createGain());
        var shaper = bag.add(ctx.createWaveShaper()), lp = bag.add(ctx.createBiquadFilter());
        shaper.oversample = '4x';
        lp.type = 'lowpass';
        output.gain.value = 0.6;
        input.connect(shaper); shaper.connect(lp); lp.connect(output);
        var lastK = -1;
        return {
            input: input, output: output, dispose: bag.dispose,
            set: function (p1, p2) {
                var k = Math.round(1 + p1 * 60);
                if (k !== lastK) {
                    lastK = k;
                    var curve = new Float32Array(2048), norm = Math.tanh(k);
                    for (var i = 0; i < curve.length; i++) {
                        var x = i / (curve.length - 1) * 2 - 1;
                        curve[i] = Math.tanh(k * x) / norm;
                    }
                    shaper.curve = curve;
                }
                smooth(lp.frequency, 1000 * Math.pow(16, p2));
                return Math.round(p1 * 100) + '%';
            }
        };
    }

    // tail: echo/reverb keep ringing out after the effect is switched off.
    var FX_TYPES = {
        echo: { name: 'Echo', p1: 'TIME', p2: 'FEEDB.', tail: true, create: makeEcho },
        pingpong: { name: 'Ping-Pong', p1: 'TIME', p2: 'FEEDB.', tail: true, create: makePingPong },
        reverb: { name: 'Reverb', p1: 'SIZE', p2: 'TONE', tail: true, create: makeReverb },
        flanger: { name: 'Flanger', p1: 'RATE', p2: 'DEPTH', tail: false, create: makeFlanger },
        phaser: { name: 'Phaser', p1: 'RATE', p2: 'DEPTH', tail: false, create: makePhaser },
        distortion: { name: 'Distortion', p1: 'DRIVE', p2: 'TONE', tail: false, create: makeDistortion }
    };

    var HOTCUE_COLORS = ['#e5484d', '#2fa8f0', '#36d399', '#c084fc', '#f5a623', '#f06292'];
    var HOTCUE_COUNT = 6;
    var DECK_COLORS = { A: '#2fa8f0', B: '#f0503f' };
    var ZOOM = { seconds: 8 };       // visible seconds in the shared waveform band
    var SEC_PER_REV = 1.8;           // jog wheel: one revolution = 1.8 s of audio (33 1/3 rpm)

    // =====================================================================================
    // Playback engines
    //   WorkletEngine: AudioWorklet (deck-worklet.js) - variable/negative speed, scratching,
    //                  click-free jumps. Needs a secure context (https or localhost).
    //   BufferEngine:  fallback with AudioBufferSourceNode - no scratching.
    // Both: load(audioBuffer), start(pos, rate), stop(), setRate(rate), setLoop(loop),
    //       scratchBegin(pos), scratchMove(pos), scratchEnd(resume, pos, rate),
    //       spin(vel, dur, resume, resumePos, rate), getSlice(start, end)
    // and report back via deck.onEngineMessage({type: 'ended' | 'pos', ...}).
    // =====================================================================================
    var USE_WORKLET = false;

    function WorkletEngine(deck) {
        this.canScratch = true;
        this.node = new AudioWorkletNode(ctx, 'embydj-deck', { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2] });
        this.node.connect(deck.trim);
        var self = this;
        this.slices = {};
        this.sliceId = 0;
        this.node.port.onmessage = function (e) {
            var m = e.data;
            if (m.type === 'slice') {
                var cb = self.slices[m.id];
                delete self.slices[m.id];
                if (cb) cb(m);
                return;
            }
            deck.onEngineMessage(m);
        };
    }
    // copy of the audio between start and end (seconds) -> Promise<{L, R}>
    WorkletEngine.prototype.getSlice = function (start, end) {
        var self = this, id = ++this.sliceId;
        return new Promise(function (resolve) {
            self.slices[id] = resolve;
            self.post({ type: 'slice', id: id, start: start, end: end });
        });
    };
    WorkletEngine.prototype.post = function (m, transfer) { this.node.port.postMessage(m, transfer || []); };
    WorkletEngine.prototype.load = function (audio) {
        // copies, transferred to the audio thread - the decoded AudioBuffer can then be freed
        var L = new Float32Array(audio.getChannelData(0));
        var R = audio.numberOfChannels > 1 ? new Float32Array(audio.getChannelData(1)) : null;
        this.post({ type: 'load', L: L, R: R }, R ? [L.buffer, R.buffer] : [L.buffer]);
    };
    WorkletEngine.prototype.start = function (pos, rate, when) { this.post({ type: 'play', pos: pos, rate: rate, when: when || 0 }); };
    WorkletEngine.prototype.stop = function () { this.post({ type: 'stop' }); };
    WorkletEngine.prototype.setRate = function (rate) { this.post({ type: 'rate', rate: rate }); };
    WorkletEngine.prototype.setLoop = function (loop) { this.post({ type: 'loop', active: loop.active, start: loop.start, end: loop.end }); };
    WorkletEngine.prototype.scratchBegin = function (pos) { this.post({ type: 'scratchBegin', pos: pos }); };
    WorkletEngine.prototype.scratchMove = function (pos) { this.post({ type: 'scratchMove', pos: pos }); };
    WorkletEngine.prototype.scratchEnd = function (resume, pos, rate) { this.post({ type: 'scratchEnd', resume: resume, pos: pos, rate: rate }); };
    // backspin (vel < 0) / brake (vel > 0): speed runs linearly from vel to 0 within dur seconds
    WorkletEngine.prototype.spin = function (vel, dur, resume, resumePos, rate) {
        this.post({ type: 'spin', vel: vel, dur: dur, resume: resume, resumePos: resumePos, rate: rate });
        return true;
    };

    function BufferEngine(deck) {
        this.canScratch = false;
        this.deck = deck;
        this.audio = null;
        this.src = null;
        this.token = 0;
        this.loop = { active: false, start: 0, end: 0 };
    }
    BufferEngine.prototype.getSlice = function (start, end) {
        var a = this.audio, sr = a.sampleRate, s0 = Math.floor(start * sr), s1 = Math.min(a.length, Math.floor(end * sr));
        var L = a.getChannelData(0).slice(s0, s1);
        var R = a.numberOfChannels > 1 ? a.getChannelData(1).slice(s0, s1) : null;
        return Promise.resolve({ L: L, R: R });
    };
    BufferEngine.prototype.load = function (audio) { this.stop(); this.audio = audio; this.loop = { active: false, start: 0, end: 0 }; };
    BufferEngine.prototype.start = function (pos, rate, when) {
        this.stop();
        if (!this.audio) return;
        var self = this, token = ++this.token;
        var src = ctx.createBufferSource();
        src.buffer = this.audio;
        src.playbackRate.value = rate;
        if (this.loop.active) { src.loop = true; src.loopStart = this.loop.start; src.loopEnd = this.loop.end; }
        src.connect(this.deck.trim);
        src.onended = function () { if (token === self.token) { self.src = null; self.deck.onEngineMessage({ type: 'ended' }); } };
        src.start(when || 0, clamp(pos, 0, Math.max(0, this.audio.duration - 0.001)));
        this.src = src;
    };
    BufferEngine.prototype.stop = function () {
        if (!this.src) return;
        this.token++;
        try { this.src.stop(); } catch (e) { /* already stopped */ }
        this.src.disconnect();
        this.src = null;
    };
    BufferEngine.prototype.setRate = function (rate) { if (this.src) this.src.playbackRate.setValueAtTime(rate, ctx.currentTime); };
    BufferEngine.prototype.setLoop = function (loop) {
        this.loop = { active: loop.active, start: loop.start, end: loop.end };
        if (!this.src) return;
        if (loop.active) { this.src.loopStart = loop.start; this.src.loopEnd = loop.end; }
        this.src.loop = !!loop.active;
    };
    // no scratching: the jog only scrubs silently, playback resumes on release
    BufferEngine.prototype.scratchBegin = function () { this.stop(); };
    BufferEngine.prototype.scratchMove = function () { };
    BufferEngine.prototype.scratchEnd = function (resume, pos, rate) { if (resume) this.start(pos, rate); };
    // fallback: only a brake is possible (no reverse playback)
    BufferEngine.prototype.spin = function (vel, dur, resume, resumePos, rate) {
        if (vel <= 0 || !this.src) return false;
        var self = this, src = this.src, now = ctx.currentTime;
        src.playbackRate.cancelScheduledValues(now);
        src.playbackRate.setValueAtTime(vel, now);
        src.playbackRate.linearRampToValueAtTime(0.0001, now + dur);
        setTimeout(function () {
            if (self.src !== src) return;
            self.stop();
            if (resume) self.start(resumePos, rate);
        }, dur * 1000);
        return true;
    };

    // =====================================================================================
    // Deck
    // =====================================================================================
    function Deck(id, deckHost, channelHost) {
        this.id = id;
        this.item = null;
        this.buffer = null;
        this.wave = null;
        this.meta = Deck.emptyMeta();
        this.playing = false;
        this.pos = 0;
        this.startCtx = 0;
        this.loadToken = 0;
        this.scratching = false;
        this.scratchPos = 0;
        this.spinState = null;    // running backspin / brake
        this.spinTimer = null;
        this.slipRef = null;
        var prefs = {};
        try { prefs = JSON.parse(localStorage.getItem('embydj-deck-' + id) || '{}') || {}; } catch (e) { /* ignore */ }
        this.vinyl = prefs.vinyl !== false;   // vinyl mode: touching the platter scratches
        this.slip = !!prefs.slip;              // slip mode: after a scratch, continue where the track would be
        this.tempo = 0;       // fader position -1..1
        this.range = 0.08;    // ±8 %
        this.nudge = 1;
        this.loop = { active: false, start: 0, end: 0, beats: 4 };
        this.loopIn = null;
        this.previewing = false;
        this.jog = null;
        this.taps = [];
        this.saveTimer = null;
        this.vuHold = 0;

        this.buildAudio();
        this.engine = USE_WORKLET ? new WorkletEngine(this) : new BufferEngine(this);
        this.buildUI(deckHost);
        this.buildChannel(channelHost);
    }

    Deck.emptyMeta = function () { return { v: 1, bpm: 0, offset: 0, cue: 0, hotcues: [null, null, null, null, null, null] }; };

    Object.defineProperty(Deck.prototype, 'rate', { get: function () { return (1 + this.tempo * this.range) * this.nudge; } });
    Object.defineProperty(Deck.prototype, 'duration', { get: function () { return this.buffer ? this.buffer.duration : 0; } });

    // ---- audio graph: source -> trim -> low -> mid -> high -> lp -> hp -> fader -> xf -> master ----
    Deck.prototype.buildAudio = function () {
        this.trim = ctx.createGain();
        this.eqLow = ctx.createBiquadFilter(); this.eqLow.type = 'lowshelf'; this.eqLow.frequency.value = 220;
        this.eqMid = ctx.createBiquadFilter(); this.eqMid.type = 'peaking'; this.eqMid.frequency.value = 1100; this.eqMid.Q.value = 0.7;
        this.eqHigh = ctx.createBiquadFilter(); this.eqHigh.type = 'highshelf'; this.eqHigh.frequency.value = 3500;
        this.lp = ctx.createBiquadFilter(); this.lp.type = 'lowpass'; this.lp.frequency.value = 22000; this.lp.Q.value = 0.9;
        this.hp = ctx.createBiquadFilter(); this.hp.type = 'highpass'; this.hp.frequency.value = 10; this.hp.Q.value = 0.9;
        this.fader = ctx.createGain();
        this.xf = ctx.createGain();
        this.analyser = ctx.createAnalyser(); this.analyser.fftSize = 1024;
        this.trim.connect(this.eqLow); this.eqLow.connect(this.eqMid); this.eqMid.connect(this.eqHigh);
        this.eqHigh.connect(this.lp); this.lp.connect(this.hp); this.hp.connect(this.fader);
        // Post-fader FX insert: fader -> fxIn -> (dry | send -> effect -> wet) -> fxOut -> xf.
        // Post-fader so echo/reverb tails keep ringing when the channel fader is pulled down.
        this.fxIn = ctx.createGain(); this.fxDry = ctx.createGain(); this.fxSend = ctx.createGain();
        this.fxWet = ctx.createGain(); this.fxOut = ctx.createGain();
        this.fxSend.gain.value = 0; this.fxWet.gain.value = 0;
        this.fader.connect(this.fxIn);
        this.fxIn.connect(this.fxDry); this.fxDry.connect(this.fxOut);
        this.fxIn.connect(this.fxSend);
        this.fxWet.connect(this.fxOut);
        this.fxOut.connect(this.analyser); this.fxOut.connect(this.xf); this.xf.connect(masterGain);
        var saved = null;
        try { saved = JSON.parse(localStorage.getItem('embydj-fx-' + this.id) || 'null'); } catch (e) { /* ignore */ }
        this.fx = Object.assign({ type: 'echo', dw: 0.5, p1: 0.45, p2: 0.5 }, saved || {}, { on: false, node: null, bpm: -1 });
        if (!FX_TYPES[this.fx.type]) this.fx.type = 'echo';
        this.eqDb = { low: 0, mid: 0, high: 0 };
        this.kill = { low: false, mid: false, high: false };
        this.vuData = new Float32Array(this.analyser.fftSize);
    };

    // ---- effects ----
    Deck.prototype.setFxType = function (type) {
        var fx = this.fx;
        if (fx.node) { this.fxSend.disconnect(); fx.node.dispose(); }
        fx.type = type;
        fx.node = FX_TYPES[type].create();
        this.fxSend.connect(fx.node.input);
        fx.node.output.connect(this.fxWet);
        this.ui.fxType.value = type;
        this.ui.fxP1Label.textContent = FX_TYPES[type].p1;
        this.ui.fxP2Label.textContent = FX_TYPES[type].p2;
        fx.bpm = -1;
        this.updateFx();
        this.applyFxMix();
        this.saveFxPrefs();
    };

    Deck.prototype.updateFx = function () {
        var fx = this.fx;
        if (!fx.node) return;
        fx.bpm = this.meta.bpm ? this.meta.bpm * this.rate : 0;
        this.ui.fxValue.textContent = fx.node.set(fx.p1, fx.p2, fx.bpm) || '';
    };

    Deck.prototype.applyFxMix = function () {
        var fx = this.fx, dw = fx.dw;
        if (fx.on) {
            smooth(this.fxSend.gain, 1);
            smooth(this.fxDry.gain, Math.min(1, 2 * (1 - dw)));
            smooth(this.fxWet.gain, Math.min(1, 2 * dw));
        } else {
            smooth(this.fxSend.gain, 0);
            smooth(this.fxDry.gain, 1);
            // echo/reverb: leave the wet path open so the tail rings out naturally
            smooth(this.fxWet.gain, FX_TYPES[fx.type].tail ? Math.min(1, 2 * dw) : 0);
        }
        toggle(this.ui.fxOn, 'on', fx.on);
    };

    Deck.prototype.toggleFx = function () {
        this.fx.on = !this.fx.on;
        this.applyFxMix();
    };

    Deck.prototype.saveFxPrefs = function () {
        var fx = this.fx;
        try { localStorage.setItem('embydj-fx-' + this.id, JSON.stringify({ type: fx.type, dw: fx.dw, p1: fx.p1, p2: fx.p2 })); } catch (e) { /* ignore */ }
    };

    Deck.prototype.applyEq = function (band) {
        var node = band === 'low' ? this.eqLow : band === 'mid' ? this.eqMid : this.eqHigh;
        smooth(node.gain, this.kill[band] ? -40 : this.eqDb[band]);
    };

    Deck.prototype.setFilter = function (v) {
        var now = ctx.currentTime;
        if (Math.abs(v) < 0.03) {
            this.lp.frequency.setTargetAtTime(22000, now, 0.02);
            this.hp.frequency.setTargetAtTime(10, now, 0.02);
        } else if (v < 0) {
            this.lp.frequency.setTargetAtTime(22000 * Math.pow(60 / 22000, -v), now, 0.02);
            this.hp.frequency.setTargetAtTime(10, now, 0.02);
        } else {
            this.lp.frequency.setTargetAtTime(22000, now, 0.02);
            this.hp.frequency.setTargetAtTime(20 * Math.pow(9000 / 20, v), now, 0.02);
        }
    };

    // ---- transport ----
    Deck.prototype.position = function () {
        if (this.spinState) return this.spinPos();
        if (this.scratching) return this.scratchPos;
        if (!this.playing) return this.pos;
        var p = this.pos + Math.max(0, ctx.currentTime - this.startCtx) * this.rate;
        if (this.loop.active && p >= this.loop.end) {
            var L = this.loop.end - this.loop.start;
            p = this.loop.start + ((p - this.loop.start) % L);
        }
        return Math.min(p, this.duration);
    };

    // Freeze the current position as the new reference point (before changing rate/loop).
    Deck.prototype.rebase = function () {
        if (this.playing && !this.scratching) { this.pos = this.position(); this.startCtx = ctx.currentTime; }
    };

    Deck.prototype.onEngineMessage = function (m) {
        if (m.type === 'ended') {
            if (this.playing && !this.scratching) { this.playing = false; this.pos = this.duration; }
        } else if (m.type === 'pos') {
            // where playback really continued after a scratch
            if (this.playing && !this.scratching) { this.pos = m.pos; this.startCtx = m.time; }
        }
    };

    // (re)start playback at `at` (click-free jump with the worklet engine)
    Deck.prototype.startAt = function (at) {
        at = clamp(at, 0, Math.max(0, this.duration - 0.001));
        this.pos = at;
        this.startCtx = ctx.currentTime;
        this.engine.start(at, this.rate);
    };

    Deck.prototype.play = function () {
        this.cancelSpin();
        if (!this.buffer || this.playing) return;
        resumeAudio();
        this.playing = true;
        if (this.scratching) return; // playback starts when the platter is released
        if (this.pos >= this.duration - 0.05) this.pos = 0;
        this.startAt(this.pos);
    };

    Deck.prototype.pause = function () {
        this.cancelSpin();
        if (!this.playing) return;
        this.pos = this.position();
        this.playing = false;
        if (!this.scratching) this.engine.stop();
    };

    Deck.prototype.togglePlay = function () {
        if (this.spinState) { this.cancelSpin(); this.play(); return; } // play during a backspin / brake: back to normal
        if (this.previewing) { this.previewing = false; return; } // keep playing after cue preview
        if (this.playing) this.pause(); else this.play();
    };

    Deck.prototype.seek = function (time) {
        if (!this.buffer) return;
        if (this.spinState) { var wasRunning = this.spinState.resume; this.cancelSpin(); if (wasRunning) this.playing = true; }
        time = clamp(time, 0, this.duration);
        if (this.loop.active && (time < this.loop.start - 0.001 || time >= this.loop.end)) {
            this.loop.active = false;
            this.engine.setLoop(this.loop);
        }
        if (this.scratching) { this.scratchPos = time; this.engine.scratchMove(time); return; }
        if (this.playing) this.startAt(time); else this.pos = time;
    };

    Deck.prototype.applyRate = function () {
        if (this.playing && !this.scratching) this.engine.setRate(this.rate);
    };

    // ---- backspin / brake ----
    // v0: start speed in track-seconds per second (negative = backwards), dur: seconds until standstill.
    // Afterwards: slip on -> continue where the track would be; kind 'flick' while playing -> the
    // "motor" picks the record up again where the spin ended; otherwise the deck stops.
    Deck.prototype.spin = function (v0, dur, kind) {
        if (!this.buffer || this.spinState) return;
        if (v0 < 0 && !this.engine.canScratch) { toast(t('noBackspin')); return; }
        var now = ctx.currentTime, p0 = this.position();
        var wasPlaying = this.playing;
        var ref = this.slipRef || (wasPlaying ? { pos: p0, t: now, rate: this.rate } : null);
        var resume = false, resumePos = null;
        if (wasPlaying && this.slip && ref) { resume = true; resumePos = clamp(ref.pos + (now + dur - ref.t) * ref.rate, 0, this.duration); }
        else if (wasPlaying && kind === 'flick') resume = true;
        this.scratching = false;
        this.slipRef = null;
        if (!this.engine.spin(v0, dur, resume, resumePos, this.rate)) {
            if (v0 < 0) { toast(t('noBackspin')); return; }
        }
        if (this.loop.active) { this.loop.active = false; this.engine.setLoop(this.loop); }
        this.spinState = { p0: p0, t0: now, v0: v0, dur: dur, resume: resume, resumePos: resumePos, kind: kind };
        var self = this;
        clearTimeout(this.spinTimer);
        this.spinTimer = setTimeout(function () { self.finishSpin(); }, dur * 1000);
    };

    Deck.prototype.spinPos = function () {
        var s = this.spinState, dt = Math.min(Math.max(0, ctx.currentTime - s.t0), s.dur);
        return clamp(s.p0 + s.v0 * dt - 0.5 * (s.v0 / s.dur) * dt * dt, 0, this.duration);
    };

    Deck.prototype.finishSpin = function () {
        var s = this.spinState;
        if (!s) return;
        var end = clamp(s.p0 + s.v0 * s.dur / 2, 0, this.duration);
        this.spinState = null;
        clearTimeout(this.spinTimer);
        this.startCtx = ctx.currentTime;
        if (s.resume) { this.playing = true; this.pos = s.resumePos != null ? s.resumePos : end; }
        else { this.playing = false; this.pos = end; }
    };

    // stop a running spin right where it is (the caller decides what happens next)
    Deck.prototype.cancelSpin = function () {
        if (!this.spinState) return;
        var p = this.spinPos();
        this.spinState = null;
        clearTimeout(this.spinTimer);
        this.playing = false;
        this.pos = p;
        this.engine.stop();
    };

    // start playback at track position `pos` at AudioContext time `when` (Auto-Mix)
    Deck.prototype.playAt = function (pos, when) {
        this.cancelSpin();
        if (!this.buffer) return;
        resumeAudio();
        this.playing = true;
        this.pos = clamp(pos, 0, Math.max(0, this.duration - 0.001));
        this.startCtx = when;
        this.engine.start(this.pos, this.rate, when);
    };

    Deck.prototype.forwardspin = function () {
        var bl = this.beatLen() || 0.5;
        this.spin(3 * Math.max(this.rate, 0.5), Math.min(2.5, 2 * bl / Math.max(this.rate, 0.5)), 'button');
    };

    Deck.prototype.backspin = function () {
        var bl = this.beatLen() || 0.5;
        this.spin(-3 * Math.max(this.rate, 0.5), Math.min(2.5, 2 * bl / Math.max(this.rate, 0.5)), 'button');
    };

    Deck.prototype.brake = function () {
        if (!this.playing) return;
        var bl = this.beatLen() || 0.5;
        this.spin(this.rate, Math.min(3, 2 * bl / Math.max(this.rate, 0.5)), 'button');
    };

    // ---- scratching (jog wheel) ----
    Deck.prototype.scratchBegin = function () {
        if (!this.buffer || this.scratching) return;
        if (this.spinState) { var keep = this.spinState.resume; this.cancelSpin(); this.playing = keep; } // catch the spinning platter
        var p = this.position();
        this.slipRef = this.playing && this.slip ? { pos: p, t: ctx.currentTime, rate: this.rate } : null;
        this.scratching = true;
        this.scratchPos = p;
        this.engine.scratchBegin(p);
    };

    Deck.prototype.scratchMove = function (deltaSeconds) {
        if (!this.scratching) return;
        this.scratchPos = clamp(this.scratchPos + deltaSeconds, 0, this.duration);
        this.engine.scratchMove(this.scratchPos);
    };

    Deck.prototype.scratchEnd = function () {
        if (!this.scratching) return;
        this.scratching = false;
        var resumePos = null;
        if (this.playing && this.slipRef) {
            // slip mode: continue where the track would have been without the scratch
            resumePos = clamp(this.slipRef.pos + (ctx.currentTime - this.slipRef.t) * this.slipRef.rate, 0, this.duration);
        }
        this.slipRef = null;
        var p = resumePos != null ? resumePos : this.scratchPos;
        if (this.loop.active && (p < this.loop.start || p >= this.loop.end)) {
            this.loop.active = false;
            this.engine.setLoop(this.loop);
        }
        this.pos = p;
        this.startCtx = ctx.currentTime;
        if (this.playing) this.engine.scratchEnd(true, this.engine.canScratch ? resumePos : p, this.rate);
        else this.engine.scratchEnd(false);
    };

    Deck.prototype.savePrefs = function () {
        try { localStorage.setItem('embydj-deck-' + this.id, JSON.stringify({ vinyl: this.vinyl, slip: this.slip })); } catch (e) { /* ignore */ }
    };

    Deck.prototype.setTempo = function (v) {
        this.rebase();
        this.tempo = clamp(v, -1, 1);
        this.applyRate();
        this.ui.tempo.value = this.tempo;
    };

    Deck.prototype.setRange = function (r) {
        var pct = this.tempo * this.range;
        this.range = r;
        this.ui.range.value = String(r);
        this.setTempo(pct / r);
    };

    Deck.prototype.setNudge = function (f) {
        this.rebase();
        this.nudge = f;
        this.applyRate();
    };

    // ---- cue / hot cues ----
    Deck.prototype.cueDown = function () {
        if (!this.buffer) return;
        this.cancelSpin();
        var cue = this.meta.cue || 0;
        if (this.playing) { this.pause(); this.seek(cue); return; }
        if (Math.abs(this.pos - cue) < 0.02) { this.previewing = true; this.play(); return; }
        this.meta.cue = this.pos;
        this.scheduleSave();
    };

    Deck.prototype.cueUp = function () {
        if (!this.previewing) return;
        this.previewing = false;
        this.pause();
        this.seek(this.meta.cue || 0);
    };

    Deck.prototype.hotcue = function (i) {
        if (!this.buffer) return;
        var hc = this.meta.hotcues;
        if (hc[i] == null) { hc[i] = this.position(); this.scheduleSave(); }
        else this.seek(hc[i]);
    };

    Deck.prototype.deleteHotcue = function (i) {
        if (!this.buffer) return;
        this.meta.hotcues[i] = null;
        this.scheduleSave();
    };

    // ---- loops ----
    Deck.prototype.beatLen = function () { return this.meta.bpm ? 60 / this.meta.bpm : 0; };

    Deck.prototype.setLoop = function (start, end) {
        end = Math.min(end, this.duration);
        if (end - start < 0.01) return;
        this.rebase();
        this.loop.start = start;
        this.loop.end = end;
        this.loop.active = true;
        var p = this.pos;
        this.engine.setLoop(this.loop);
        if (this.scratching) return;
        if (this.playing) {
            if (p < start || p >= end) this.startAt(p >= end ? start + ((p - start) % (end - start)) : start);
        } else if (p < start || p >= end) {
            this.pos = start;
        }
    };

    Deck.prototype.exitLoop = function () {
        this.rebase();
        this.loop.active = false;
        this.engine.setLoop(this.loop);
    };

    Deck.prototype.toggleBeatLoop = function () {
        if (!this.buffer) return;
        if (this.loop.active) { this.exitLoop(); return; }
        var bl = this.beatLen();
        if (!bl) { toast(t('loopNoBpm')); return; }
        var p = this.position(), off = this.meta.offset || 0;
        var start = Math.max(0, off + Math.floor((p - off) / bl + 1e-6) * bl);
        this.setLoop(start, start + this.loop.beats * bl);
    };

    Deck.prototype.resizeLoop = function (factor) {
        var beats = clamp(this.loop.beats * factor, 1 / 8, 64);
        this.loop.beats = beats;
        if (this.loop.active && this.beatLen()) this.setLoop(this.loop.start, this.loop.start + beats * this.beatLen());
    };

    Deck.prototype.setLoopIn = function () {
        if (!this.buffer) return;
        this.loopIn = this.position();
    };

    Deck.prototype.setLoopOut = function () {
        if (!this.buffer) return;
        var p = this.position();
        var start = this.loopIn != null ? this.loopIn : (this.loop.active ? this.loop.start : null);
        if (start == null || p <= start) return;
        this.setLoop(start, p);
        var bl = this.beatLen();
        if (bl) this.loop.beats = Math.round((p - start) / bl * 8) / 8;
        this.loopIn = null;
    };

    // ---- BPM tools ----
    Deck.prototype.scaleBpm = function (f) {
        if (!this.meta.bpm) return;
        this.meta.bpm = Math.round(this.meta.bpm * f * 100) / 100;
        this.meta.bpmSource = 'manual';
        this.scheduleSave();
    };

    Deck.prototype.tap = function () {
        if (!this.buffer) return;
        var now = performance.now();
        this.taps = this.taps.filter(function (x) { return now - x < 2500; });
        this.taps.push(now);
        if (this.taps.length < 4) return;
        var iv = (this.taps[this.taps.length - 1] - this.taps[0]) / (this.taps.length - 1);
        var bpm = Math.round(60000 / iv / this.rate * 100) / 100;
        var bl = 60 / bpm;
        this.meta.bpm = bpm;
        this.meta.offset = this.position() % bl;
        this.meta.bpmSource = 'tap';
        this.scheduleSave();
    };

    Deck.prototype.syncTo = function (other) {
        if (!this.buffer || !other.buffer) return;
        if (!this.meta.bpm || !other.meta.bpm) { toast(t('syncNoBpm')); return; }
        var target = other.meta.bpm * (other.rate / other.nudge);
        var myBpm = this.meta.bpm;
        if (target / myBpm > 1.4) myBpm *= 2; else if (target / myBpm < 0.7) myBpm /= 2;
        var needed = target / myBpm - 1;
        if (Math.abs(needed) > 0.5) { toast(t('tempoOutOfRange')); return; }
        if (Math.abs(needed) > this.range) this.setRange(Math.abs(needed) <= 0.16 ? 0.16 : 0.5);
        this.setTempo(needed / this.range);

        // beat phase alignment (only meaningful when the other deck is running)
        if (other.playing) {
            var oBeat = 60 / other.meta.bpm, mBeat = 60 / myBpm;
            var oPh = frac((other.position() - (other.meta.offset || 0)) / oBeat);
            var mPh = frac((this.position() - (this.meta.offset || 0)) / mBeat);
            var d = oPh - mPh;
            if (d > 0.5) d -= 1; else if (d < -0.5) d += 1;
            if (Math.abs(d) > 0.005) this.seek(this.position() + d * mBeat);
        }
    };

    Deck.prototype.scheduleSave = function () {
        if (!this.item) return;
        var self = this, id = this.item.Id, meta = this.meta;
        clearTimeout(this.saveTimer);
        metaCache[id] = meta;
        updateLibraryBpm(id);
        this.saveTimer = setTimeout(function () { saveMeta(id, meta); }, 600);
    };

    // ---- loading ----
    Deck.prototype.load = function (item) {
        var self = this;
        if (this.playing) { toast(t('deckPlaying', { d: this.id })); return Promise.resolve(false); }
        var token = ++this.loadToken, loaded = false;
        var ui = this.ui;
        if (ticksToSec(item.RunTimeTicks) > 30 * 60) toast(t('longTrack'));

        ui.title.textContent = item.Name || '';
        ui.artist.textContent = artistOf(item);
        var img = imageUrl(item, 96);
        if (img) ui.cover.src = img; else ui.cover.removeAttribute('src');
        ui.loading.classList.add('show');
        ui.loadingBar.style.setProperty('--p', '0%');
        ui.loadingText.textContent = t('downloading', { p: '' });

        function progress(f, bytes) {
            if (token !== self.loadToken) return;
            ui.loadingBar.style.setProperty('--p', f >= 0 ? Math.round(f * 100) + '%' : '50%');
            ui.loadingText.textContent = t('downloading', { p: f >= 0 ? Math.round(f * 100) + '%' : Math.round(bytes / 1048576) + ' MB' });
        }
        function decode(buf) { return ctx.decodeAudioData(buf); }

        return Promise.all([fetchAudio(item, false, progress), fetchMeta([item.Id])])
            .then(function (r) {
                if (token !== self.loadToken) return null;
                ui.loadingText.textContent = t('decoding');
                return decode(r[0]).catch(function () {
                    // Codec the browser can't decode (e.g. ALAC, WMA): let Emby transcode to MP3.
                    return fetchAudio(item, true, progress).then(decode);
                });
            })
            .then(function (audio) {
                if (!audio || token !== self.loadToken) return null;
                ui.loadingText.textContent = t('analyzing');
                return analyzeWave(audio).then(function (wave) { return { audio: audio, wave: wave }; });
            })
            .then(function (res) {
                if (!res || token !== self.loadToken) return;
                var stored = metaCache[item.Id];
                var meta = Object.assign(Deck.emptyMeta(), stored || {});
                if (!Array.isArray(meta.hotcues)) meta.hotcues = [];
                while (meta.hotcues.length < HOTCUE_COUNT) meta.hotcues.push(null);
                var detected = false;
                if (!meta.bpm) {
                    var det = detectBpm(res.wave);
                    if (det) { meta.bpm = det.bpm; meta.offset = det.offset; meta.bpmSource = 'auto'; detected = true; }
                }
                self.engine.stop();
                self.playing = false;
                self.previewing = false;
                self.scratching = false;
                self.loop.active = false;
                self.loopIn = null;
                self.engine.load(res.audio);
                self.engine.setLoop(self.loop);
                // only the duration is kept here; the samples live in the engine
                self.buffer = { duration: res.audio.duration };
                self.wave = res.wave;
                self.item = item;
                self.meta = meta;
                self.pos = meta.cue || 0;
                self.overview = null;
                self.loudness = res.wave.loudness;
                if (self.loudness != null && meta.loudness !== self.loudness) { meta.loudness = self.loudness; detected = true; }
                self.applyAutoGain();
                // a new track starts at its original tempo
                self.nudge = 1;
                self.setTempo(0);
                loaded = true;
                markLoadedRows();
                if (detected) saveMeta(item.Id, meta);
            })
            .catch(function (e) {
                console.error('EmbyDJ: load failed', e);
                if (token === self.loadToken) toast(t('loadFailed', { e: e && e.message ? e.message : e }));
            })
            .then(function () {
                if (token === self.loadToken) ui.loading.classList.remove('show');
                return loaded;
            });
    };

    // ---- UI ----
    Deck.prototype.buildUI = function (host) {
        var self = this;
        var node = document.importNode($('#deckTemplate').content, true);
        applyI18n(node);
        host.appendChild(node);
        var root = host.querySelector('.deck');
        var q = function (s) { return root.querySelector(s); };
        this.root = root;
        var side = $('#bandSide' + this.id);
        this.color = DECK_COLORS[this.id];
        this.ui = {
            cover: q('.cover'), title: q('.title'), artist: q('.artist'),
            elapsed: side.querySelector('.band-elapsed'), remaining: side.querySelector('.band-remain'),
            bpm: q('.bpm'), pitchValue: q('.pitch-value'), jog: q('.jog'), overview: q('.wave-overview'),
            loading: q('.loading'), loadingBar: q('.loading-bar'), loadingText: q('.loading-text'),
            play: q('.play'), cue: q('.cue'), sync: q('.sync'),
            hotcues: Array.prototype.slice.call(root.querySelectorAll('.hotcue')),
            loopToggle: q('.loop-toggle'), loopLen: q('.loop-len'),
            tempo: q('.tempo-fader'), range: q('.tempo-range'),
            fxType: q('.fx-type'), fxOn: q('.fx-on'), fxValue: q('.fx-value'),
            fxP1Label: q('[data-fx="p1"] span'), fxP2Label: q('[data-fx="p2"] span'),
            vinyl: q('.vinyl-btn'), slip: q('.slip-btn'), backspin: q('.backspin-btn'), brake: q('.brake-btn'),
            forwardspin: q('.fwdspin-btn')
        };
        var ui = this.ui;
        ui.hotcues.forEach(function (b, i) { b.style.setProperty('--hc', HOTCUE_COLORS[i]); });

        ui.vinyl.addEventListener('click', function () { self.vinyl = !self.vinyl; self.savePrefs(); });
        ui.slip.addEventListener('click', function () { self.slip = !self.slip; self.savePrefs(); });
        ui.backspin.addEventListener('click', function () { self.backspin(); });
        ui.brake.addEventListener('click', function () { self.brake(); });
        ui.forwardspin.addEventListener('click', function () { self.forwardspin(); });
        q('.pitch-zero').addEventListener('click', function () { self.setTempo(0); });

        // transport
        ui.play.addEventListener('click', function () { manual(); self.togglePlay(); });
        ui.cue.addEventListener('pointerdown', function (e) { e.preventDefault(); manual(); self.cueDown(); });
        ui.cue.addEventListener('pointerup', function () { self.cueUp(); });
        ui.cue.addEventListener('pointerleave', function () { self.cueUp(); });
        ui.sync.addEventListener('click', function () { self.syncTo(self.other); });

        ui.hotcues.forEach(function (b, i) {
            b.addEventListener('click', function (e) { if (e.shiftKey) self.deleteHotcue(i); else self.hotcue(i); });
            b.addEventListener('contextmenu', function (e) { e.preventDefault(); self.deleteHotcue(i); });
        });

        q('.loop-toggle').addEventListener('click', function () { self.toggleBeatLoop(); });
        q('.loop-half').addEventListener('click', function () { self.resizeLoop(0.5); });
        q('.loop-double').addEventListener('click', function () { self.resizeLoop(2); });
        q('.loop-in').addEventListener('click', function () { self.setLoopIn(); });
        q('.loop-out').addEventListener('click', function () { self.setLoopOut(); });
        q('.loop-pad').addEventListener('click', function () { loopToPad(self); });

        q('.bpm-half').addEventListener('click', function () { self.scaleBpm(0.5); });
        q('.bpm-double').addEventListener('click', function () { self.scaleBpm(2); });
        q('.bpm-tap').addEventListener('click', function () { self.tap(); });

        // tempo
        ui.tempo.addEventListener('input', function () { self.setTempo(+ui.tempo.value); });
        ui.tempo.addEventListener('dblclick', function () { self.setTempo(0); });
        ui.range.addEventListener('change', function () { self.setRange(+ui.range.value); });
        function nudgeBtn(sel, f) {
            var b = q(sel);
            b.addEventListener('pointerdown', function (e) { e.preventDefault(); self.setNudge(f); });
            ['pointerup', 'pointerleave', 'pointercancel'].forEach(function (ev) {
                b.addEventListener(ev, function () { if (self.nudge !== 1) self.setNudge(1); });
            });
        }
        nudgeBtn('.nudge-down', 0.96);
        nudgeBtn('.nudge-up', 1.04);

        // effects
        Object.keys(FX_TYPES).forEach(function (k) {
            var o = document.createElement('option');
            o.value = k;
            o.textContent = FX_TYPES[k].name;
            ui.fxType.appendChild(o);
        });
        ui.fxType.addEventListener('change', function () { self.setFxType(ui.fxType.value); });
        ui.fxOn.addEventListener('click', function () { self.toggleFx(); });
        var fx = this.fx;
        initKnob(q('[data-fx="dw"]'), 0.5, function (v) { fx.dw = v; self.applyFxMix(); self.saveFxPrefs(); }, fx.dw);
        initKnob(q('[data-fx="p1"]'), 0.45, function (v) { fx.p1 = v; self.updateFx(); self.saveFxPrefs(); }, fx.p1);
        initKnob(q('[data-fx="p2"]'), 0.5, function (v) { fx.p2 = v; self.updateFx(); self.saveFxPrefs(); }, fx.p2);
        this.setFxType(fx.type);

        // overview: click / drag to seek
        var ovDrag = false;
        function ovSeek(e) {
            if (!self.buffer) return;
            var r = ui.overview.getBoundingClientRect();
            self.seek(clamp((e.clientX - r.left) / r.width, 0, 1) * self.duration);
        }
        ui.overview.addEventListener('pointerdown', function (e) { ovDrag = true; ui.overview.setPointerCapture(e.pointerId); ovSeek(e); });
        ui.overview.addEventListener('pointermove', function (e) { if (ovDrag) ovSeek(e); });
        ui.overview.addEventListener('pointerup', function () { ovDrag = false; });

        // jog wheel
        //   vinyl on : platter top = scratch (with sound), outer ring = bend (playing) / scratch (paused)
        //   vinyl off: whole wheel = bend (playing) / scratch (paused)
        function jogPoint(e) {
            var r = ui.jog.getBoundingClientRect(), dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
            return { a: Math.atan2(dy, dx), dist: Math.sqrt(dx * dx + dy * dy) / (r.width / 2) };
        }
        function jogEnd() {
            var j = self.jog;
            if (!j) return;
            clearTimeout(j.idle);
            if (j.mode === 'bend' && self.nudge !== 1) self.setNudge(1);
            if (j.mode === 'scratch') {
                // speed over the last ~100 ms before letting go (track-seconds per second)
                var now = performance.now(), sum = 0, first = now;
                j.hist.forEach(function (h) { if (now - h.t <= 100) { sum += h.s; first = Math.min(first, h.t); } });
                var span = Math.max(0.03, (now - first) / 1000);
                var v = sum / span;
                if (v <= -2) self.spin(Math.max(v, -8), clamp(-v / 3, 0.4, 2.5), 'flick');
                else if (v >= 3) self.spin(Math.min(v, 8), clamp(v / 3, 0.4, 2.5), 'flick');
                else self.scratchEnd();
            }
            self.jog = null;
        }
        ui.jog.addEventListener('pointerdown', function (e) {
            if (!self.buffer) return;
            e.preventDefault();
            try { ui.jog.setPointerCapture(e.pointerId); } catch (err) { /* synthetic event */ }
            var pt = jogPoint(e), rim = pt.dist > 0.8;
            var mode = (self.vinyl && !rim) || !self.playing ? 'scratch' : 'bend';
            self.jog = { a: pt.a, t: performance.now(), mode: mode, idle: null, hist: [] };
            if (mode === 'scratch') self.scratchBegin();
        });
        ui.jog.addEventListener('pointermove', function (e) {
            var j = self.jog;
            if (!j) return;
            var a = jogPoint(e).a, d = a - j.a;
            if (d > Math.PI) d -= 2 * Math.PI; else if (d < -Math.PI) d += 2 * Math.PI;
            var now = performance.now(), dt = Math.max(4, now - j.t) / 1000;
            j.a = a; j.t = now;
            var secs = d / (2 * Math.PI) * SEC_PER_REV;
            if (j.mode === 'scratch') {
                self.scratchMove(secs);
                j.hist.push({ t: now, s: secs });
                if (j.hist.length > 40) j.hist.shift();
            } else {
                self.setNudge(clamp(1 + secs / dt * 0.12, 0.8, 1.2));
                clearTimeout(j.idle);
                j.idle = setTimeout(function () { if (self.jog === j && self.nudge !== 1) self.setNudge(1); }, 70);
            }
        });
        ui.jog.addEventListener('pointerup', jogEnd);
        ui.jog.addEventListener('pointercancel', jogEnd);

        // drag & drop from the library
        root.addEventListener('dragover', function (e) { e.preventDefault(); root.classList.add('drop-target'); });
        root.addEventListener('dragleave', function () { root.classList.remove('drop-target'); });
        root.addEventListener('drop', function (e) {
            e.preventDefault();
            root.classList.remove('drop-target');
            var item = libItemsById[e.dataTransfer.getData('text/x-embydj-id')];
            if (item) { manual(); self.load(item); }
        });
    };

    // Auto-Gain on: GAIN from the measured loudness; off: GAIN back to 0 dB
    Deck.prototype.applyAutoGain = function () {
        if (!this.trimKnob || this.loudness == null) return;
        var db = autoGain ? autoGainDb(this.loudness) : 0;
        this.trimKnob.set(0.5 + db / 24);
    };

    Deck.prototype.buildChannel = function (host) {
        var self = this;
        var node = document.importNode($('#channelTemplate').content, true);
        host.appendChild(node);
        var root = host.querySelector('.channel');
        root.querySelector('.ch-label').textContent = this.id;
        this.vu = $('#vu' + this.id);

        root.querySelectorAll('.knob').forEach(function (el) {
            var p = el.dataset.param;
            if (p === 'trim') self.trimKnob = initKnob(el, 0.5, function (v) {
                var db = (v - 0.5) * 24;
                smooth(self.trim.gain, dbToGain(db));
                el.title = 'Gain ' + (db >= 0 ? '+' : '') + db.toFixed(1) + ' dB' +
                    (self.loudness != null ? ' (track: ' + self.loudness.toFixed(1) + ' LUFS)' : '') + ' - double-click resets';
            });
            else if (p === 'filter') initKnob(el, 0.5, function (v) { self.setFilter((v - 0.5) * 2); });
            else initKnob(el, 0.5, function (v) {
                self.eqDb[p] = v < 0.5 ? (v - 0.5) * 2 * 26 : (v - 0.5) * 2 * 6;
                self.applyEq(p);
            });
        });
        root.querySelectorAll('.kill').forEach(function (b) {
            b.addEventListener('click', function () {
                var band = b.dataset.band;
                self.kill[band] = !self.kill[band];
                b.classList.toggle('on', self.kill[band]);
                self.applyEq(band);
            });
        });
        var fader = root.querySelector('.ch-fader');
        function setFader() { var v = +fader.value; smooth(self.fader.gain, v * v * 1.38); }
        fader.addEventListener('input', setFader);
        fader.addEventListener('dblclick', function () { fader.value = 0.85; setFader(); });
        setFader();
    };

    // ---- per-frame rendering ----
    Deck.prototype.render = function () {
        var ui = this.ui;
        var pos = this.position();
        if (this.playing && pos >= this.duration - 0.0005 && !this.loop.active) { this.pause(); this.pos = this.duration; }

        ui.elapsed.textContent = fmtTime(pos, true);
        ui.remaining.textContent = '-' + fmtTime(this.duration - pos, true);
        var pct = (this.rate / this.nudge - 1) * 100;
        ui.pitchValue.textContent = (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
        ui.bpm.textContent = this.meta.bpm ? (this.meta.bpm * this.rate).toFixed(1) : '---';

        toggle(ui.play, 'on', this.playing);
        toggle(ui.vinyl, 'on', this.vinyl);
        toggle(ui.slip, 'on', this.slip);
        toggle(ui.backspin, 'on', !!this.spinState && this.spinState.v0 < 0);
        toggle(ui.forwardspin, 'on', !!this.spinState && this.spinState.v0 > this.rate * 1.5);
        toggle(ui.brake, 'on', !!this.spinState && this.spinState.v0 > 0);
        toggle(ui.jog, 'scratching', this.scratching);
        toggle(ui.cue, 'on', !!this.buffer && !this.playing && Math.abs(this.pos - (this.meta.cue || 0)) < 0.02);
        toggle(ui.loopToggle, 'on', this.loop.active);
        var beats = this.loop.beats;
        ui.loopLen.textContent = beats >= 1 ? String(beats) : '1/' + Math.round(1 / beats);
        for (var i = 0; i < ui.hotcues.length; i++) toggle(ui.hotcues[i], 'set', this.meta.hotcues[i] != null);

        this.drawOverview(pos);
        this.drawJog(pos);
        drawVu(this.vu, this.analyser, this.vuData, this);

        // keep tempo-synced effects locked to the current BPM
        var bpmNow = this.meta.bpm ? this.meta.bpm * this.rate : 0;
        if (Math.abs(bpmNow - this.fx.bpm) > 0.05) this.updateFx();
    };

    function toggle(el, cls, on) { if (el.classList.contains(cls) !== on) el.classList.toggle(cls, on); }

    function fitCanvas(cv) {
        var dpr = window.devicePixelRatio || 1;
        var w = Math.round(cv.clientWidth * dpr), h = Math.round(cv.clientHeight * dpr);
        if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; return true; }
        return false;
    }

    // Draws this deck's lane of the shared waveform band: region (0, y0, W, H) of g,
    // playhead at the horizontal centre, spp = seconds per (device) pixel.
    Deck.prototype.drawLane = function (g, y0, W, H, pos, spp) {
        g.save();
        g.beginPath(); g.rect(0, y0, W, H); g.clip();
        g.translate(0, y0);
        this.drawLaneInner(g, W, H, pos, spp);
        g.restore();
    };

    Deck.prototype.drawLaneInner = function (g, W, H, pos, spp) {
        var mid = H / 2;
        if (!this.wave) return;
        var w = this.wave, fps = w.fps, cx = W / 2;
        var t0 = pos - cx * spp;

        // loop region
        if (this.loop.active) {
            var lx0 = (this.loop.start - t0) / spp, lx1 = (this.loop.end - t0) / spp;
            g.fillStyle = 'rgba(54,211,153,.18)';
            g.fillRect(lx0, 0, lx1 - lx0, H);
        }

        // waveform columns
        for (var x = 0; x < W; x++) {
            var ta = t0 + x * spp;
            if (ta < 0 || ta > this.duration) continue;
            var b0 = Math.floor(ta * fps), b1 = Math.max(b0 + 1, Math.floor((ta + spp) * fps));
            var l = 0, m = 0, h = 0, p = 0;
            for (var b = b0; b < b1 && b < w.bins; b++) {
                if (w.low[b] > l) l = w.low[b];
                if (w.mid[b] > m) m = w.mid[b];
                if (w.high[b] > h) h = w.high[b];
                if (w.peak[b] > p) p = w.peak[b];
            }
            var hh = p * mid * 0.95;
            if (hh < 0.5) continue;
            g.fillStyle = bandColor(l, m, h);
            g.fillRect(x, mid - hh, 1, hh * 2);
        }

        // beat grid
        var bl = this.beatLen();
        if (bl && bl / spp > 4) {
            var off = this.meta.offset || 0;
            var first = Math.ceil((t0 - off) / bl);
            for (var k = first; ; k++) {
                var bt = off + k * bl, bx = (bt - t0) / spp;
                if (bx > W) break;
                if (bt < 0) continue;
                g.fillStyle = k % 4 === 0 ? 'rgba(255,255,255,.55)' : 'rgba(255,255,255,.18)';
                g.fillRect(Math.round(bx), 0, k % 4 === 0 ? 2 : 1, H);
            }
        }

        // cue + hot cues
        drawMarker(g, (this.meta.cue - t0) / spp, H, '#f5c33f', '');
        for (var i = 0; i < this.meta.hotcues.length; i++) {
            var hc = this.meta.hotcues[i];
            if (hc != null) drawMarker(g, (hc - t0) / spp, H, HOTCUE_COLORS[i], String(i + 1));
        }
        if (this.loopIn != null) drawMarker(g, (this.loopIn - t0) / spp, H, '#36d399', 'IN');

    };

    // ---- jog wheel ----
    Deck.prototype.drawJog = function (pos) {
        var cv = this.ui.jog;
        fitCanvas(cv);
        var g = cv.getContext('2d'), W = cv.width, H = cv.height;
        if (!W || !H) return;
        var cx = W / 2, cy = H / 2, R = Math.min(W, H) / 2 - 2, TAU = Math.PI * 2;
        var col = this.color, touched = this.scratching;
        g.clearRect(0, 0, W, H);

        // progress ring
        var ring = R * 0.085, rr = R - ring / 2;
        g.lineWidth = ring;
        g.strokeStyle = '#23262e';
        g.beginPath(); g.arc(cx, cy, rr, 0, TAU); g.stroke();
        if (this.duration) {
            g.strokeStyle = col;
            g.beginPath(); g.arc(cx, cy, rr, -Math.PI / 2, -Math.PI / 2 + TAU * clamp(pos / this.duration, 0, 1)); g.stroke();
        }

        // platter with grooves
        var pr = R * 0.84;
        var grad = g.createRadialGradient(cx, cy - pr * 0.3, pr * 0.1, cx, cy, pr);
        grad.addColorStop(0, touched ? '#2a2e38' : '#22252d');
        grad.addColorStop(1, '#0d0e12');
        g.fillStyle = grad;
        g.beginPath(); g.arc(cx, cy, pr, 0, TAU); g.fill();
        g.lineWidth = 1;
        g.strokeStyle = 'rgba(255,255,255,.04)';
        for (var k = 0.4; k < 0.98; k += 0.09) { g.beginPath(); g.arc(cx, cy, pr * k, 0, TAU); g.stroke(); }

        // rotating marker (33 1/3 rpm)
        var ang = (pos / SEC_PER_REV) * TAU - Math.PI / 2;
        g.strokeStyle = col;
        g.lineCap = 'round';
        g.lineWidth = Math.max(3, R * 0.06);
        g.beginPath();
        g.moveTo(cx + Math.cos(ang) * pr * 0.36, cy + Math.sin(ang) * pr * 0.36);
        g.lineTo(cx + Math.cos(ang) * pr * 0.93, cy + Math.sin(ang) * pr * 0.93);
        g.stroke();
        g.lineCap = 'butt';

        // centre label
        g.fillStyle = col;
        g.beginPath(); g.arc(cx, cy, pr * 0.3, 0, TAU); g.fill();
        g.fillStyle = '#fff';
        g.font = 'bold ' + Math.round(pr * 0.24) + 'px system-ui';
        g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(this.id, cx, cy + 1);
        g.textAlign = 'start'; g.textBaseline = 'alphabetic';
    };

    function drawMarker(g, x, H, color, label) {
        if (x < -20 || x > g.canvas.width + 20) return;
        x = Math.round(x);
        g.fillStyle = color;
        g.fillRect(x, 0, 2, H);
        g.beginPath(); g.moveTo(x - 6, 0); g.lineTo(x + 8, 0); g.lineTo(x + 1, 9); g.closePath(); g.fill();
        if (label) {
            var dpr = window.devicePixelRatio || 1;
            g.font = 'bold ' + Math.round(10 * dpr) + 'px system-ui';
            g.fillText(label, x + 4, H - 4);
        }
    }

    Deck.prototype.buildOverview = function () {
        var cv = this.ui.overview, W = cv.width, H = cv.height, w = this.wave;
        var off = document.createElement('canvas');
        off.width = W; off.height = H;
        var g = off.getContext('2d'), mid = H / 2, per = w.bins / W;
        for (var x = 0; x < W; x++) {
            var b0 = Math.floor(x * per), b1 = Math.max(b0 + 1, Math.floor((x + 1) * per));
            var l = 0, m = 0, h = 0, p = 0;
            for (var b = b0; b < b1 && b < w.bins; b++) {
                if (w.low[b] > l) l = w.low[b];
                if (w.mid[b] > m) m = w.mid[b];
                if (w.high[b] > h) h = w.high[b];
                if (w.peak[b] > p) p = w.peak[b];
            }
            var hh = p * mid * 0.95;
            g.fillStyle = bandColor(l, m, h);
            g.fillRect(x, mid - hh, 1, Math.max(1, hh * 2));
        }
        this.overview = off;
    };

    Deck.prototype.drawOverview = function (pos) {
        var cv = this.ui.overview;
        if (fitCanvas(cv)) this.overview = null;
        var g = cv.getContext('2d'), W = cv.width, H = cv.height;
        if (!W || !H) return; // hidden
        g.fillStyle = '#0a0b0d';
        g.fillRect(0, 0, W, H);
        if (!this.wave) return;
        if (!this.overview || this.overview.width !== W) this.buildOverview();
        g.drawImage(this.overview, 0, 0);
        var d = this.duration, px = function (s) { return s / d * W; };
        g.fillStyle = 'rgba(10,11,13,.55)';
        g.fillRect(0, 0, px(pos), H);
        if (this.loop.active) {
            g.fillStyle = 'rgba(54,211,153,.35)';
            g.fillRect(px(this.loop.start), 0, Math.max(2, px(this.loop.end - this.loop.start)), H);
        }
        g.fillStyle = '#f5c33f';
        g.fillRect(Math.round(px(this.meta.cue || 0)), 0, 2, H);
        for (var i = 0; i < this.meta.hotcues.length; i++) {
            var hc = this.meta.hotcues[i];
            if (hc != null) { g.fillStyle = HOTCUE_COLORS[i]; g.fillRect(Math.round(px(hc)), 0, 2, H); }
        }
        g.fillStyle = '#fff';
        g.fillRect(Math.round(px(pos)) - 1, 0, 2, H);
    };

    // ---- VU meters ----
    function drawVu(cv, analyser, data, state) {
        analyser.getFloatTimeDomainData(data);
        var pk = 0;
        for (var i = 0; i < data.length; i++) { var a = data[i] < 0 ? -data[i] : data[i]; if (a > pk) pk = a; }
        var db = pk > 0 ? 20 * Math.log10(pk) : -60;
        var level = clamp((db + 48) / 51, 0, 1); // -48 dB .. +3 dB
        state.vuHold = Math.max(level, (state.vuHold || 0) - 0.015);
        fitCanvas(cv);
        var g = cv.getContext('2d'), W = cv.width, H = cv.height;
        if (!W || !H) return;
        g.fillStyle = '#0a0b0d';
        g.fillRect(0, 0, W, H);
        var horizontal = W > H, len = horizontal ? W : H;
        var segs = Math.max(12, Math.min(32, Math.round(len / 7))), sh = len / segs;
        var lit = Math.round(state.vuHold * segs);
        for (var s = 0; s < segs; s++) {
            g.fillStyle = s >= segs - 2 ? '#e5484d' : s >= segs - 6 ? '#f5c33f' : '#52b54b';
            if (s >= lit) g.globalAlpha = 0.12;
            if (horizontal) g.fillRect(s * sh + 1, 0, sh - 1, H);
            else g.fillRect(0, H - (s + 1) * sh + 1, W, sh - 1);
            g.globalAlpha = 1;
        }
    }

    // ---- knobs ----
    function initKnob(el, def, onChange, initial) {
        var value = def;
        function set(v) {
            value = clamp(v, 0, 1);
            el.style.setProperty('--angle', (-135 + 270 * value) + 'deg');
            onChange(value);
        }
        var drag = null;
        el.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            el.setPointerCapture(e.pointerId);
            drag = { y: e.clientY, v: value };
        });
        el.addEventListener('pointermove', function (e) {
            if (!drag) return;
            var sens = e.shiftKey ? 600 : 150;
            set(drag.v + (drag.y - e.clientY) / sens);
        });
        el.addEventListener('pointerup', function () { drag = null; });
        el.addEventListener('dblclick', function () { set(def); });
        el.addEventListener('wheel', function (e) { e.preventDefault(); set(value + (e.deltaY < 0 ? 0.03 : -0.03)); }, { passive: false });
        set(initial != null ? initial : def);
        return { set: set, get: function () { return value; } };
    }

    // =====================================================================================
    // Mixer (crossfader + master)
    // =====================================================================================
    var decks = [];
    var xf = { value: 0.5, curve: 'smooth' };

    function applyCrossfader() {
        var x = xf.value, a, b;
        if (xf.curve === 'sharp') { a = Math.min(1, (1 - x) / 0.08); b = Math.min(1, x / 0.08); }
        else { a = Math.cos(x * Math.PI / 2); b = Math.sin(x * Math.PI / 2); a = Math.min(1, a * 1.41); b = Math.min(1, b * 1.41); }
        smooth(decks[0].xf.gain, a);
        smooth(decks[1].xf.gain, b);
    }

    function setCrossfader(v) {
        xf.value = clamp(v, 0, 1);
        $('#crossfader').value = xf.value;
        applyCrossfader();
    }

    // =====================================================================================
    // Library
    // =====================================================================================
    var lib = { parentId: '', search: '', sort: 'SortName', desc: false, start: 0, total: 0, loading: false, gen: 0,
        bpmPhase: false, genrePhase: false, genre: null, shown: {} };
    var libItemsById = {};
    var libRowsById = {};
    var PAGE = 100;

    function loadSources() {
        var sel = $('#libSource');
        sel.innerHTML = '';
        var all = document.createElement('option');
        all.value = '';
        all.textContent = t('allTracks');
        sel.appendChild(all);
        return Promise.all([
            apiJson('/Users/' + auth.userId + '/Views').catch(function () { return { Items: [] }; }),
            apiJson('/Users/' + auth.userId + '/Items', { IncludeItemTypes: 'Playlist', Recursive: true, SortBy: 'SortName' })
                .catch(function () { return { Items: [] }; })
        ]).then(function (r) {
            var libs = (r[0].Items || []).filter(function (v) { return v.CollectionType === 'music'; });
            var pls = (r[1].Items || []).filter(function (p) { return !p.MediaType || p.MediaType === 'Audio'; });
            function group(label, items) {
                if (!items.length) return;
                var og = document.createElement('optgroup');
                og.label = label;
                items.forEach(function (it) {
                    var o = document.createElement('option');
                    o.value = it.Id;
                    o.textContent = it.Name;
                    og.appendChild(o);
                });
                sel.appendChild(og);
            }
            if (libs.length > 1) group(t('libraries'), libs);
            group(t('playlists'), pls);
        });
    }

    function libReload() {
        lib.gen++;
        lib.start = 0;
        lib.total = 0;
        lib.loading = false;
        lib.bpmPhase = lib.sort === 'Bpm' && !lib.search;
        lib.genrePhase = lib.sort === 'Genre' && !lib.search;
        lib.genre = { list: null, i: 0, start: 0 };
        lib.shown = {};
        renderSortHeaders();
        $('#libBody').innerHTML = '';
        libRowsById = {};
        $('#libWrap').scrollTop = 0;
        return libMore();
    }

    // ---- search: title OR artist OR album -------------------------------------------------
    // Emby's SearchTerm on audio items only matches the title, and its filters combine with AND.
    // So three queries run in parallel (title match, tracks of matching artists, tracks of
    // matching albums), and the results are merged, de-duplicated and sorted here.
    var SEARCH_LIMIT = 400;

    function sortKey(item) {
        var artist = (item.AlbumArtist || artistOf(item) || '').toLowerCase();
        var album = (item.Album || '').toLowerCase();
        var name = (item.SortName || item.Name || '').toLowerCase();
        var num = function (n) { return ('0000' + (n || 0)).slice(-4); };
        if (lib.sort.indexOf('AlbumArtist') === 0) return artist + '\u0000' + album + '\u0000' + num(item.ParentIndexNumber) + num(item.IndexNumber) + name;
        if (lib.sort === 'ParentIndexNumber,IndexNumber,SortName') return num(item.ParentIndexNumber) + num(item.IndexNumber) + name;
        if (lib.sort.indexOf('Album') === 0) return album + '\u0000' + num(item.ParentIndexNumber) + num(item.IndexNumber) + name;
        return name;
    }

    function bpmOf(id) { var m = metaCache[id]; return m && m.bpm ? +m.bpm : 0; }

    function firstGenre(item) {
        var g = (item.Genres || []).slice().sort(function (a, b) { return a.localeCompare(b); })[0];
        return g ? g.toLowerCase() : '';
    }

    function sortResults(items) {
        if (lib.sort === 'Genre') {
            var withGenre = items.filter(function (it) { return firstGenre(it); });
            var without = items.filter(function (it) { return !firstGenre(it); });
            var keyed = withGenre.map(function (it) {
                return { k: firstGenre(it) + '\u0000' + (it.AlbumArtist || artistOf(it) || '').toLowerCase() + '\u0000' + (it.SortName || it.Name || '').toLowerCase(), it: it };
            });
            keyed.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
            if (lib.desc) keyed.reverse();
            return keyed.map(function (x) { return x.it; }).concat(without);
        }
        if (lib.sort === 'Bpm') {
            // tracks without a BPM always go last
            var dir = lib.desc ? -1 : 1;
            return items.slice().sort(function (a, b) {
                var x = bpmOf(a.Id), y = bpmOf(b.Id);
                if (!x || !y) return (x ? 0 : 1) - (y ? 0 : 1);
                return (x - y) * dir;
            });
        }
        var sorted = sortResultsAsc(items);
        return lib.desc && lib.sort !== 'Random' ? sorted.reverse() : sorted;
    }

    function sortResultsAsc(items) {
        if (lib.sort === 'Random') {
            for (var i = items.length - 1; i > 0; i--) { var j = Math.floor(Math.random() * (i + 1)), x = items[i]; items[i] = items[j]; items[j] = x; }
            return items;
        }
        if (lib.sort === 'DateCreated') {
            return items.sort(function (a, b) { return (a.DateCreated || '').localeCompare(b.DateCreated || ''); });
        }
        var keyed = items.map(function (it) { return { k: sortKey(it), it: it }; });
        keyed.sort(function (a, b) { return a.k < b.k ? -1 : a.k > b.k ? 1 : 0; });
        return keyed.map(function (x) { return x.it; });
    }

    function searchTracks(term) {
        var base = {
            IncludeItemTypes: 'Audio', Recursive: true, ParentId: lib.parentId, Limit: SEARCH_LIMIT,
            EnableUserData: false, EnableImageTypes: 'Primary', ImageTypeLimit: 1, Fields: 'DateCreated,SortName,Genres'
        };
        var itemsUrl = '/Users/' + auth.userId + '/Items';
        var none = { Items: [] };
        function tracksFor(key, list) {
            var ids = (list.Items || []).map(function (x) { return x.Id; });
            if (!ids.length) return Promise.resolve(none);
            var q = Object.assign({}, base);
            q[key] = ids.join(',');
            return apiJson(itemsUrl, q);
        }
        return Promise.all([
            apiJson(itemsUrl, Object.assign({}, base, { SearchTerm: term })),
            apiJson('/Artists', { SearchTerm: term, UserId: auth.userId, ParentId: lib.parentId, Limit: 25 })
                .then(function (r) { return tracksFor('ArtistIds', r); }).catch(function () { return none; }),
            apiJson(itemsUrl, { IncludeItemTypes: 'MusicAlbum', Recursive: true, SearchTerm: term, ParentId: lib.parentId, Limit: 25 })
                .then(function (r) { return tracksFor('AlbumIds', r); }).catch(function () { return none; }),
            apiJson('/MusicGenres', { SearchTerm: term, UserId: auth.userId, ParentId: lib.parentId, IncludeItemTypes: 'Audio', Recursive: true, Limit: 10 })
                .then(function (r) { return tracksFor('GenreIds', r); }).catch(function () { return none; })
        ]).then(function (results) {
            var seen = {}, merged = [];
            results.forEach(function (r) {
                (r.Items || []).forEach(function (it) { if (!seen[it.Id]) { seen[it.Id] = true; merged.push(it); } });
            });
            return merged;
        });
    }

    function libSearch(gen) {
        return searchTracks(lib.search).then(function (found) {
            // BPM values first: they are needed for sorting by BPM
            return fetchMeta(found.map(function (i) { return i.Id; })).then(function () { return sortResults(found); });
        }).then(function (items) {
            if (gen !== lib.gen) return;
            lib.total = lib.start = items.length;   // all results at once - no paging while searching
            appendRows(items);
            items.forEach(function (i) { updateLibraryBpm(i.Id); });
            $('#libCount').textContent = t('tracks', { n: items.length.toLocaleString('en-US') });
            $('#libMore').textContent = items.length === 0 ? t('noMatch') : '';
        });
    }

    function libMore() {
        if (lib.loading || (lib.start > 0 && lib.start >= lib.total)) return Promise.resolve();
        lib.loading = true;
        var gen = lib.gen;
        $('#libMore').textContent = t('loadingMore');
        if (lib.bpmPhase) {
            return libBpmPhase(gen).catch(function (e) {
                if (gen === lib.gen) $('#libMore').textContent = String(e.message || e);
            }).then(function () {
                if (gen !== lib.gen) return;
                lib.loading = false;
                lib.bpmPhase = false;
                return libMore();   // continue with the tracks without BPM
            });
        }
        if (lib.genrePhase) {
            return libGenrePage(gen).catch(function (e) {
                if (gen === lib.gen) { $('#libMore').textContent = String(e.message || e); lib.genrePhase = false; }
            }).then(function () {
                if (gen !== lib.gen) return;
                lib.loading = false;
                $('#libMore').textContent = '';
                if (!lib.genrePhase) return libMore();   // all genres listed: continue with the tracks without genre
            });
        }
        if (lib.search) {
            return libSearch(gen).catch(function (e) {
                if (gen === lib.gen) $('#libMore').textContent = String(e.message || e);
            }).then(function () {
                if (gen === lib.gen) lib.loading = false;
            });
        }
        var params = {
            IncludeItemTypes: 'Audio', Recursive: true, StartIndex: lib.start, Limit: PAGE,
            ParentId: lib.parentId, SearchTerm: lib.search, EnableUserData: false,
            EnableImageTypes: 'Primary', ImageTypeLimit: 1, Fields: 'Genres'
        };
        if (lib.sort === 'Random') params.SortBy = 'Random';
        else if (lib.sort === 'Bpm' || lib.sort === 'Genre') { params.SortBy = 'SortName'; params.SortOrder = 'Ascending'; } // the rest, after the BPM / genre phase
        else { params.SortBy = lib.sort; params.SortOrder = lib.desc ? 'Descending' : 'Ascending'; }

        return apiJson('/Users/' + auth.userId + '/Items', params).then(function (res) {
            if (gen !== lib.gen) return;
            var items = res.Items || [];
            lib.total = res.TotalRecordCount || 0;
            lib.start += items.length;
            if (!items.length) lib.total = lib.start;
            // in BPM / genre mode the tracks with a BPM / genre are already listed at the top
            items = items.filter(function (i) { return !lib.shown[i.Id]; });
            appendRows(items);
            $('#libCount').textContent = t('tracks', { n: lib.total.toLocaleString('en-US') });
            $('#libMore').textContent = lib.total === 0 ? t('noMusic') : '';
            return fetchMeta(items.map(function (i) { return i.Id; })).then(function () {
                items.forEach(function (i) { updateLibraryBpm(i.Id); });
            });
        }).catch(function (e) {
            if (gen === lib.gen) $('#libMore').textContent = String(e.message || e);
        }).then(function () {
            if (gen === lib.gen) lib.loading = false;
        });
    }

    // Sorting by BPM: BPM values only exist in EmbyDJ, not in Emby. So all tracks with a known BPM
    // (in the current library / playlist) are listed first, sorted by BPM; the remaining tracks
    // follow by title through the normal paging.
    function libBpmPhase(gen) {
        return apiJson('/EmbyDJ/Tracks', { All: true }).then(function (all) {
            var ids = Object.keys(all).filter(function (id) { return all[id] && all[id].bpm > 0; });
            ids.forEach(function (id) { metaCache[id] = all[id]; });
            ids.sort(function (a, b) { return (all[a].bpm - all[b].bpm) * (lib.desc ? -1 : 1); });
            var chunks = [];
            for (var i = 0; i < ids.length; i += 100) chunks.push(ids.slice(i, i + 100));
            return Promise.all(chunks.map(function (chunk) {
                return apiJson('/Users/' + auth.userId + '/Items', {
                    Ids: chunk.join(','), ParentId: lib.parentId, IncludeItemTypes: 'Audio', Recursive: true,
                    EnableUserData: false, EnableImageTypes: 'Primary', ImageTypeLimit: 1, Fields: 'Genres'
                }).then(function (r) { return r.Items || []; });
            })).then(function (parts) {
                if (gen !== lib.gen) return;
                var byId = {};
                parts.forEach(function (p) { p.forEach(function (it) { byId[it.Id] = it; }); });
                var items = ids.filter(function (id) { return byId[id]; }).map(function (id) { return byId[id]; });
                appendRows(items);
                items.forEach(function (it) { lib.shown[it.Id] = true; updateLibraryBpm(it.Id); });
            });
        });
    }

    // Sorting by genre: Emby cannot sort by genre, so the genres are listed alphabetically and the
    // tracks are loaded genre by genre (a track with several genres appears under the first one).
    // Tracks without a genre follow at the end through the normal paging.
    function libGenrePage(gen) {
        var g = lib.genre, appended = 0;
        var ready = g.list ? Promise.resolve() : Promise.all([
            apiJson('/MusicGenres', {
                UserId: auth.userId, ParentId: lib.parentId, IncludeItemTypes: 'Audio', Recursive: true,
                SortBy: 'SortName'
            }),
            apiJson('/Users/' + auth.userId + '/Items', { IncludeItemTypes: 'Audio', Recursive: true, ParentId: lib.parentId, Limit: 0 })
        ]).then(function (r) {
            // Emby ignores SortOrder for genres: sort here (case-insensitive), reverse for descending
            g.list = (r[0].Items || []).slice().sort(function (a, b) { return a.Name.localeCompare(b.Name, undefined, { sensitivity: 'base' }); });
            if (lib.desc) g.list.reverse();
            $('#libCount').textContent = t('tracks', { n: (r[1].TotalRecordCount || 0).toLocaleString('en-US') });
        });
        function step() {
            if (gen !== lib.gen) return;
            if (g.i >= g.list.length) { lib.genrePhase = false; return; }
            if (appended >= PAGE) return;            // enough for this scroll step
            var genre = g.list[g.i];
            return apiJson('/Users/' + auth.userId + '/Items', {
                IncludeItemTypes: 'Audio', Recursive: true, ParentId: lib.parentId, GenreIds: genre.Id,
                SortBy: 'AlbumArtist,Album,SortName', SortOrder: 'Ascending', StartIndex: g.start, Limit: PAGE,
                EnableUserData: false, EnableImageTypes: 'Primary', ImageTypeLimit: 1, Fields: 'Genres'
            }).then(function (r) {
                if (gen !== lib.gen) return;
                var all = r.Items || [];
                g.start += all.length;
                if (!all.length || g.start >= (r.TotalRecordCount || 0)) { g.i++; g.start = 0; }
                var items = all.filter(function (it) { return !lib.shown[it.Id]; });
                items.forEach(function (it) { lib.shown[it.Id] = true; });
                appendRows(items);
                appended += items.length;
                return fetchMeta(items.map(function (i) { return i.Id; })).then(function () {
                    items.forEach(function (i) { updateLibraryBpm(i.Id); });
                }).then(step);
            });
        }
        return ready.then(step);
    }

    function setSort(sort, desc) {
        lib.sort = sort;
        lib.desc = !!desc;
        $('#libSort').value = sort;
        libReload();
    }

    function renderSortHeaders() {
        document.querySelectorAll('.lib-table th.sortable').forEach(function (th) {
            var on = th.dataset.sort === lib.sort;
            toggle(th, 'sorted', on);
            toggle(th, 'desc', on && lib.desc);
            th.title = on ? (lib.desc ? 'Sorted descending - click for ascending' : 'Sorted ascending - click for descending') : 'Sort';
        });
    }

    function appendRows(items) {
        var body = $('#libBody'), frag = document.createDocumentFragment();
        items.forEach(function (item) {
            libItemsById[item.Id] = item;
            var tr = document.createElement('tr');
            tr.draggable = true;
            tr.dataset.id = item.Id;
            var img = imageUrl(item, 52);
            tr.innerHTML =
                '<td class="c-load"><button class="btn la">A</button> <button class="btn lb">B</button></td>' +
                '<td class="c-cover col-cover">' + (img ? '<img loading="lazy" alt="">' : '') + '</td>' +
                '<td class="c-num c-track col-track"></td><td class="col-title"></td><td class="col-artist"></td>' +
                '<td class="col-album"></td><td class="col-genre"></td><td class="c-num c-bpm col-bpm"></td><td class="c-num col-time"></td>';
            var cell = function (c) { return tr.querySelector('.col-' + c); };
            if (img) cell('cover').firstChild.src = img;
            var disc = item.ParentIndexNumber > 1 ? item.ParentIndexNumber + '-' : '';
            cell('track').textContent = item.IndexNumber ? disc + item.IndexNumber : '';
            cell('title').textContent = cell('title').title = item.Name || '';
            cell('artist').textContent = cell('artist').title = artistOf(item);
            cell('album').textContent = cell('album').title = item.Album || '';
            cell('genre').textContent = cell('genre').title = (item.Genres || []).join(', ');
            cell('time').textContent = fmtTime(ticksToSec(item.RunTimeTicks));
            libRowsById[item.Id] = tr;
            frag.appendChild(tr);
        });
        body.appendChild(frag);
        markLoadedRows();
        updateTrackSort();
    }

    // sorting by track number only makes sense for a list that contains a single album
    function singleAlbumList() {
        if (lib.start < lib.total) return false;
        var album = null, ok = true;
        document.querySelectorAll('#libBody tr').forEach(function (tr) {
            var it = libItemsById[tr.dataset.id];
            var a = it && it.AlbumId;
            if (!a) { ok = false; return; }
            if (album === null) album = a; else if (album !== a) ok = false;
        });
        return ok && album !== null;
    }

    function updateTrackSort() {
        var th = document.querySelector('.lib-table th.c-track');
        if (!th) return;
        var on = singleAlbumList();
        toggle(th, 'disabled', !on);
        if (!on && lib.sort !== 'ParentIndexNumber,IndexNumber,SortName') th.title = t('trackSortHint');
    }

    // ---- column chooser (button or right-click on the table header) ----
    var LIB_COLUMNS = ['cover', 'track', 'artist', 'album', 'genre', 'bpm', 'time'];

    function applyColumns(hidden) {
        var table = document.querySelector('.lib-table');
        LIB_COLUMNS.forEach(function (c) { toggle(table, 'hide-' + c, hidden.indexOf(c) >= 0); });
        document.querySelectorAll('#colMenu input').forEach(function (cb) { cb.checked = hidden.indexOf(cb.value) < 0; });
    }

    function hiddenColumns() {
        try { return JSON.parse(localStorage.getItem('embydj-hidden-columns') || '[]') || []; } catch (e) { return []; }
    }

    function bindColumns() {
        var menu = $('#colMenu');
        function open(x, y) {
            menu.classList.remove('hidden');
            var r = menu.getBoundingClientRect();
            menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
            menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
        }
        $('#colBtn').addEventListener('click', function (e) {
            var r = e.currentTarget.getBoundingClientRect();
            open(r.left, r.bottom + 4);
        });
        document.querySelector('.lib-table thead').addEventListener('contextmenu', function (e) {
            e.preventDefault();
            open(e.clientX, e.clientY);
        });
        menu.addEventListener('change', function () {
            var hidden = [];
            menu.querySelectorAll('input').forEach(function (cb) { if (!cb.checked) hidden.push(cb.value); });
            try { localStorage.setItem('embydj-hidden-columns', JSON.stringify(hidden)); } catch (e) { /* ignore */ }
            applyColumns(hidden);
        });
        document.addEventListener('pointerdown', function (e) {
            if (!menu.classList.contains('hidden') && !menu.contains(e.target) && e.target.id !== 'colBtn') menu.classList.add('hidden');
        }, true);
        applyColumns(hiddenColumns());
    }

    function updateLibraryBpm(id) {
        var tr = libRowsById[id];
        if (!tr) return;
        var m = metaCache[id];
        tr.querySelector('.c-bpm').textContent = m && m.bpm ? (+m.bpm).toFixed(1) : '';
    }

    function markLoadedRows() {
        Object.keys(libRowsById).forEach(function (id) {
            var tr = libRowsById[id];
            toggle(tr, 'loaded-a', !!(decks[0] && decks[0].item && decks[0].item.Id === id));
            toggle(tr, 'loaded-b', !!(decks[1] && decks[1].item && decks[1].item.Id === id));
        });
    }

    function loadToFreeDeck(item) {
        if (!decks[0].playing && (!decks[0].item || decks[1].playing)) return decks[0].load(item);
        if (!decks[1].playing) return decks[1].load(item);
        if (!decks[0].playing) return decks[0].load(item);
        toast(t('bothPlaying'));
    }

    function bindLibrary() {
        var body = $('#libBody');
        body.addEventListener('click', function (e) {
            var btn = e.target.closest('button');
            if (!btn) return;
            var item = libItemsById[btn.closest('tr').dataset.id];
            if (btn.classList.contains('la')) { manual(); decks[0].load(item); }
            else if (btn.classList.contains('lb')) { manual(); decks[1].load(item); }
        });
        body.addEventListener('dblclick', function (e) {
            if (e.target.closest('button')) return;
            var tr = e.target.closest('tr');
            if (tr) { manual(); loadToFreeDeck(libItemsById[tr.dataset.id]); }
        });
        body.addEventListener('dragstart', function (e) {
            var tr = e.target.closest('tr');
            if (!tr) return;
            e.dataTransfer.setData('text/x-embydj-id', tr.dataset.id);
            e.dataTransfer.effectAllowed = 'copy';
        });

        var searchTimer = null;
        $('#libSearch').addEventListener('input', function () {
            clearTimeout(searchTimer);
            searchTimer = setTimeout(function () { lib.search = $('#libSearch').value.trim(); libReload(); }, 300);
        });
        $('#libSort').addEventListener('change', function () { var v = $('#libSort').value; setSort(v, v === 'DateCreated'); });
        document.querySelectorAll('.lib-table th.sortable').forEach(function (th) {
            th.addEventListener('click', function () {
                var s = th.dataset.sort;
                if (th.classList.contains('disabled') && s !== lib.sort) { toast(t('trackSortHint')); return; }
                setSort(s, s === lib.sort ? !lib.desc : false);
            });
        });
        $('#libSource').addEventListener('change', function () { lib.parentId = $('#libSource').value; libReload(); });
        $('#libWrap').addEventListener('scroll', function () {
            var w = $('#libWrap');
            if (w.scrollTop + w.clientHeight > w.scrollHeight - 300) libMore();
        });
    }

    // =====================================================================================
    // Sampler: 4 banks x 9 pads, stored per user on the server
    //   pad = { name, color, mode: 'oneshot' | 'hold' | 'loop', vol, src }
    //   src = { type: 'sample', id }   uploaded file / loop capture (EmbyDJ/Sampler/Samples/{id})
    //       | { type: 'item', itemId } track from the Emby library
    // =====================================================================================
    var BANKS = 4, PADS = 9;
    var PAD_COLORS = ['#2fa8f0', '#f0503f', '#36d399', '#f5a623', '#c084fc', '#f06292', '#52b54b', '#e6e8ee'];
    var AUDIO_EXT = /\.(wav|mp3|flac|ogg|oga|opus|m4a|aac|webm|aif|aiff)$/i;
    var MAX_SAMPLE_BYTES = 10 * 1024 * 1024;

    var smp = {
        banks: [], bank: 0, vol: 0.8,
        buffers: {},        // key -> Promise<AudioBuffer>
        voices: {},         // "bank:pad" -> { src, gain, start, dur, loop }
        els: [],            // pad elements of the visible bank
        saveTimer: null,
        gain: null,
        menuPad: -1,
        filePad: -1
    };

    function emptyBanks() {
        var b = [];
        for (var i = 0; i < BANKS; i++) { var row = []; for (var j = 0; j < PADS; j++) row.push(null); b.push(row); }
        return b;
    }

    function padKey(pad) {
        if (!pad || !pad.src) return null;
        return pad.src.type === 'sample' ? 's:' + pad.src.id : 'i:' + pad.src.itemId;
    }

    function saveSampler() {
        clearTimeout(smp.saveTimer);
        smp.saveTimer = setTimeout(function () {
            apiFetch('/EmbyDJ/Sampler/Pads', null, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ Data: JSON.stringify({ v: 1, banks: smp.banks, bank: smp.bank, vol: smp.vol }) })
            }).catch(function (e) { toast(t('smpSaveFailed', { e: e.message })); });
        }, 400);
    }

    // decoded audio of a pad (cached)
    function padBuffer(pad) {
        var key = padKey(pad);
        if (!key) return Promise.reject(new Error('empty pad'));
        if (!smp.buffers[key]) {
            var p;
            if (pad.src.type === 'sample') {
                p = apiFetch('/EmbyDJ/Sampler/Samples/' + pad.src.id).then(function (r) { return r.arrayBuffer(); })
                    .then(function (ab) { return ctx.decodeAudioData(ab); });
            } else {
                var item = { Id: pad.src.itemId };
                p = fetchAudio(item, false, function () { }).then(function (ab) {
                    return ctx.decodeAudioData(ab).catch(function () {
                        return fetchAudio(item, true, function () { }).then(function (ab2) { return ctx.decodeAudioData(ab2); });
                    });
                });
            }
            smp.buffers[key] = p;
            p.catch(function () { delete smp.buffers[key]; });
        }
        return smp.buffers[key];
    }

    function sampleInUse(id) {
        return smp.banks.some(function (bank) {
            return bank.some(function (pad) { return pad && pad.src && pad.src.type === 'sample' && pad.src.id === id; });
        });
    }

    // put a pad into a slot; deletes the replaced uploaded sample on the server if nothing else uses it
    function setPad(bank, i, pad) {
        stopPad(bank, i, true);
        var old = smp.banks[bank][i];
        smp.banks[bank][i] = pad;
        if (old && old.src && old.src.type === 'sample' && !sampleInUse(old.src.id)) {
            apiFetch('/EmbyDJ/Sampler/Samples/' + old.src.id, null, { method: 'DELETE' }).catch(function () { /* ignore */ });
            delete smp.buffers['s:' + old.src.id];
        }
        saveSampler();
        renderPads();
        if (pad) padBuffer(pad).catch(function (e) { toast(t('smpLoadFailed', { e: e.message })); });
    }

    function newPad(name, src, i) {
        return { name: name, color: PAD_COLORS[i % PAD_COLORS.length], mode: 'oneshot', vol: 0.9, src: src };
    }

    function baseName(fileName) { return String(fileName).replace(/\.[^.]+$/, ''); }

    function uploadSample(blob, fileName) {
        if (blob.size > MAX_SAMPLE_BYTES) return Promise.reject(new Error(t('smpTooLarge')));
        return apiFetch('/EmbyDJ/Sampler/Samples', { Name: fileName }, {
            method: 'POST',
            headers: { 'Content-Type': 'application/octet-stream' },
            body: blob
        }).then(function (r) { return r.json(); }).then(function (r) { return r.Id; });
    }

    // local file -> upload -> pad
    function assignFile(i, file) {
        if (!AUDIO_EXT.test(file.name)) { toast(t('smpUnsupported', { n: file.name })); return Promise.resolve(); }
        if (file.size > MAX_SAMPLE_BYTES) { toast(t('smpTooLarge')); return Promise.resolve(); }
        var bank = smp.bank;
        markPadBusy(i, true);
        return uploadSample(file, file.name).then(function (id) {
            var pad = newPad(baseName(file.name), { type: 'sample', id: id }, i);
            // decode from the local copy - no need to download it again
            smp.buffers['s:' + id] = file.arrayBuffer().then(function (ab) { return ctx.decodeAudioData(ab); });
            setPad(bank, i, pad);
        }).catch(function (e) {
            toast(t('smpLoadFailed', { e: e.message }));
        }).then(function () { markPadBusy(i, false); });
    }

    // several files: fill from pad i onwards, using empty pads first
    function assignFiles(i, files) {
        var list = Array.prototype.slice.call(files).filter(function (f) { return AUDIO_EXT.test(f.name); });
        if (!list.length) { toast(t('smpUnsupported', { n: files[0] ? files[0].name : '' })); return; }
        var slots = [i];
        for (var k = 0; k < PADS && slots.length < list.length; k++) {
            if (k !== i && !smp.banks[smp.bank][k]) slots.push(k);
        }
        list.slice(0, slots.length).forEach(function (f, n) { assignFile(slots[n], f); });
    }

    function assignItem(i, item) {
        if (ticksToSec(item.RunTimeTicks) > 60) toast(t('smpLongTrack'));
        setPad(smp.bank, i, newPad(item.Name || 'Track', { type: 'item', itemId: item.Id }, i));
    }

    function nextFreePad() {
        var bank = smp.banks[smp.bank];
        for (var i = 0; i < PADS; i++) if (!bank[i]) return i;
        return -1;
    }

    // ---- WAV encoder for loop captures ----
    function encodeWav(L, R, sampleRate) {
        var ch = R ? 2 : 1, n = L.length, bytes = n * ch * 2;
        var buf = new ArrayBuffer(44 + bytes), v = new DataView(buf);
        function str(o, s) { for (var i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); }
        str(0, 'RIFF'); v.setUint32(4, 36 + bytes, true); str(8, 'WAVE');
        str(12, 'fmt '); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, ch, true);
        v.setUint32(24, sampleRate, true); v.setUint32(28, sampleRate * ch * 2, true); v.setUint16(32, ch * 2, true); v.setUint16(34, 16, true);
        str(36, 'data'); v.setUint32(40, bytes, true);
        var o = 44;
        for (var i = 0; i < n; i++) {
            for (var c = 0; c < ch; c++) {
                var x = clamp((c ? R : L)[i], -1, 1);
                v.setInt16(o, x < 0 ? x * 0x8000 : x * 0x7fff, true);
                o += 2;
            }
        }
        return new Blob([buf], { type: 'audio/wav' });
    }

    // active loop of a deck -> WAV -> upload -> next free pad
    function loopToPad(deck) {
        if (!deck.buffer || !deck.loop.active) { toast(t('smpNoLoop')); return; }
        var i = nextFreePad();
        if (i < 0) { toast(t('smpBankFull')); return; }
        var bank = smp.bank, start = deck.loop.start, end = deck.loop.end;
        var name = 'Loop ' + (deck.loop.beats >= 1 ? deck.loop.beats : '1/' + Math.round(1 / deck.loop.beats)) + ' – ' + (deck.item ? deck.item.Name : deck.id);
        markPadBusy(i, true);
        deck.engine.getSlice(start, end).then(function (s) {
            var wav = encodeWav(s.L, s.R, ctx.sampleRate);
            return uploadSample(wav, 'loop.wav').then(function (id) {
                var pad = newPad(name, { type: 'sample', id: id }, i);
                pad.mode = 'loop';
                pad.color = deck.color;
                smp.buffers['s:' + id] = wav.arrayBuffer().then(function (ab) { return ctx.decodeAudioData(ab); });
                setPad(bank, i, pad);
                toast(t('smpLoopSaved', { n: i + 1 }));
            });
        }).catch(function (e) {
            toast(t('smpLoadFailed', { e: e.message }));
        }).then(function () { markPadBusy(i, false); });
    }

    // ---- playback ----
    function voiceKey(bank, i) { return bank + ':' + i; }

    function stopPad(bank, i, immediate) {
        var k = voiceKey(bank, i), v = smp.voices[k];
        if (!v) return;
        delete smp.voices[k];
        var now = ctx.currentTime;
        v.gain.gain.setTargetAtTime(0, now, immediate ? 0.003 : 0.012);
        try { v.src.stop(now + 0.08); } catch (e) { /* ignore */ }
    }

    function startPad(bank, i) {
        var pad = smp.banks[bank][i];
        if (!pad) return;
        resumeAudio();
        padBuffer(pad).then(function (buf) {
            stopPad(bank, i, true);
            var src = ctx.createBufferSource(), g = ctx.createGain();
            src.buffer = buf;
            src.loop = pad.mode === 'loop';
            g.gain.value = pad.vol;
            src.connect(g); g.connect(smp.gain);
            var k = voiceKey(bank, i);
            var voice = { src: src, gain: g, start: ctx.currentTime, dur: buf.duration, loop: src.loop };
            src.onended = function () { if (smp.voices[k] === voice) delete smp.voices[k]; };
            src.start();
            smp.voices[k] = voice;
        }).catch(function (e) { toast(t('smpLoadFailed', { e: e.message })); });
    }

    // pad pressed / released (mouse, touch or numpad)
    function padDown(i) {
        var pad = smp.banks[smp.bank][i];
        if (!pad) { openFileFor(i); return; }
        var playing = !!smp.voices[voiceKey(smp.bank, i)];
        if (pad.mode === 'loop' && playing) stopPad(smp.bank, i);
        else startPad(smp.bank, i);
    }

    function padUp(i) {
        var pad = smp.banks[smp.bank][i];
        if (pad && pad.mode === 'hold') stopPad(smp.bank, i);
    }

    // ---- UI ----
    function markPadBusy(i, on) { if (smp.els[i]) smp.els[i].classList.toggle('busy', on); }

    function renderPads() {
        $('#smpBank').textContent = 'Bank ' + (smp.bank + 1);
        var bank = smp.banks[smp.bank];
        smp.els.forEach(function (el, i) {
            var pad = bank[i];
            el.classList.toggle('empty', !pad);
            el.style.setProperty('--pc', pad ? pad.color : '#2c303a');
            el.querySelector('.pad-name').textContent = pad ? pad.name : t('smpEmpty');
            el.querySelector('.pad-mode').textContent = pad ? { oneshot: 'ONE', hold: 'HOLD', loop: 'LOOP' }[pad.mode] : '';
            el.title = pad ? pad.name : t('smpEmptyHint');
        });
    }

    function renderSamplerFrame() {
        var now = ctx.currentTime;
        smp.els.forEach(function (el, i) {
            var v = smp.voices[voiceKey(smp.bank, i)];
            var p = 0;
            if (v) p = v.loop ? ((now - v.start) % v.dur) / v.dur : Math.min(1, (now - v.start) / v.dur);
            toggle(el, 'playing', !!v);
            var w = Math.round(p * 1000) / 10 + '%';
            if (el.style.getPropertyValue('--p') !== w) el.style.setProperty('--p', w);
        });
    }

    function openFileFor(i) {
        smp.filePad = i;
        var input = $('#smpFile');
        input.value = '';
        input.click();
    }

    // ---- pad context menu ----
    function openPadMenu(i, x, y) {
        closePadMenu();
        smp.menuPad = i;
        var pad = smp.banks[smp.bank][i];
        var m = $('#padMenu');
        m.querySelector('.pm-title').textContent = 'Pad ' + (i + 1) + (pad ? ' – ' + pad.name : '');
        m.querySelectorAll('.pm-needs-pad').forEach(function (el) { el.classList.toggle('hidden', !pad); });
        if (pad) {
            m.querySelectorAll('[data-mode]').forEach(function (b) { toggle(b, 'on', b.dataset.mode === pad.mode); });
            m.querySelector('.pm-vol').value = pad.vol;
            m.querySelectorAll('.pm-color').forEach(function (b) { toggle(b, 'on', b.dataset.color === pad.color); });
        }
        m.classList.remove('hidden');
        var r = m.getBoundingClientRect();
        m.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
        m.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
    }

    function closePadMenu() { $('#padMenu').classList.add('hidden'); smp.menuPad = -1; }

    function bindPadMenu() {
        var m = $('#padMenu');
        PAD_COLORS.forEach(function (c) {
            var b = document.createElement('button');
            b.className = 'pm-color';
            b.dataset.color = c;
            b.style.background = c;
            m.querySelector('.pm-colors').appendChild(b);
        });
        m.addEventListener('click', function (e) {
            var i = smp.menuPad, pad = i >= 0 ? smp.banks[smp.bank][i] : null;
            var b = e.target.closest('button');
            if (!b || i < 0) return;
            if (b.classList.contains('pm-load')) { closePadMenu(); openFileFor(i); return; }
            if (b.classList.contains('pm-folder')) { closePadMenu(); openFolderBrowser(); return; }
            if (!pad) return;
            if (b.dataset.mode) { stopPad(smp.bank, i); pad.mode = b.dataset.mode; saveSampler(); renderPads(); openPadMenu(i, parseFloat(m.style.left), parseFloat(m.style.top)); }
            else if (b.dataset.color) { pad.color = b.dataset.color; saveSampler(); renderPads(); openPadMenu(i, parseFloat(m.style.left), parseFloat(m.style.top)); }
            else if (b.classList.contains('pm-rename')) {
                var name = window.prompt(t('smpRename'), pad.name);
                if (name != null && name.trim()) { pad.name = name.trim().slice(0, 60); saveSampler(); renderPads(); }
                closePadMenu();
            } else if (b.classList.contains('pm-clear')) { closePadMenu(); setPad(smp.bank, i, null); }
        });
        m.querySelector('.pm-vol').addEventListener('input', function () {
            var pad = smp.menuPad >= 0 ? smp.banks[smp.bank][smp.menuPad] : null;
            if (!pad) return;
            pad.vol = +this.value;
            var v = smp.voices[voiceKey(smp.bank, smp.menuPad)];
            if (v) smooth(v.gain.gain, pad.vol);
            saveSampler();
        });
        document.addEventListener('pointerdown', function (e) {
            if (!m.classList.contains('hidden') && !m.contains(e.target)) closePadMenu();
        }, true);
    }

    // ---- drag & drop onto pads ----
    function handlePadDrop(i, e) {
        var dt = e.dataTransfer;
        var itemId = dt.getData('text/x-embydj-id');
        if (itemId && libItemsById[itemId]) { assignItem(i, libItemsById[itemId]); return; }
        var fIdx = dt.getData('text/x-embydj-folder');
        if (fIdx !== '' && folder.entries[+fIdx]) {
            folder.entries[+fIdx].handle.getFile().then(function (f) { assignFile(i, f); });
            return;
        }
        if (dt.files && dt.files.length) assignFiles(i, dt.files);
    }

    function bindSampler() {
        smp.gain = ctx.createGain();
        smp.gain.connect(masterGain);

        var grid = $('#smpGrid');
        for (var i = 0; i < PADS; i++) {
            var el = document.createElement('div');
            el.className = 'pad empty';
            el.dataset.i = i;
            el.innerHTML = '<span class="pad-num">' + (i + 1) + '</span><span class="pad-mode"></span><span class="pad-name"></span><span class="pad-bar"></span>';
            grid.appendChild(el);
            smp.els.push(el);
        }
        grid.addEventListener('pointerdown', function (e) {
            var el = e.target.closest('.pad');
            if (!el || e.button !== 0) return;
            e.preventDefault();
            padDown(+el.dataset.i);
            var up = function () { padUp(+el.dataset.i); window.removeEventListener('pointerup', up); };
            window.addEventListener('pointerup', up);
        });
        grid.addEventListener('contextmenu', function (e) {
            var el = e.target.closest('.pad');
            if (!el) return;
            e.preventDefault();
            openPadMenu(+el.dataset.i, e.clientX, e.clientY);
        });
        grid.addEventListener('dragover', function (e) {
            var el = e.target.closest('.pad');
            if (!el) return;
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
            smp.els.forEach(function (p) { toggle(p, 'drop', p === el); });
        });
        grid.addEventListener('dragleave', function (e) {
            if (!grid.contains(e.relatedTarget)) smp.els.forEach(function (p) { toggle(p, 'drop', false); });
        });
        grid.addEventListener('drop', function (e) {
            var el = e.target.closest('.pad');
            smp.els.forEach(function (p) { toggle(p, 'drop', false); });
            if (!el) return;
            e.preventDefault();
            handlePadDrop(+el.dataset.i, e);
        });

        $('#smpFile').addEventListener('change', function () {
            if (smp.filePad >= 0 && this.files.length) assignFiles(smp.filePad, this.files);
        });
        $('#smpPrev').addEventListener('click', function () { smp.bank = (smp.bank + BANKS - 1) % BANKS; renderPads(); preloadBank(); saveSampler(); });
        $('#smpNext').addEventListener('click', function () { smp.bank = (smp.bank + 1) % BANKS; renderPads(); preloadBank(); saveSampler(); });
        $('#smpStop').addEventListener('click', function () {
            Object.keys(smp.voices).forEach(function (k) { var p = k.split(':'); stopPad(+p[0], +p[1]); });
        });
        $('#smpFolder').addEventListener('click', openFolderBrowser);
        bindPadMenu();
        bindFolderBrowser();

        // numpad: 7 8 9 / 4 5 6 / 1 2 3  ->  pads 1-9 (same layout as the grid)
        var NUMPAD = { Numpad7: 0, Numpad8: 1, Numpad9: 2, Numpad4: 3, Numpad5: 4, Numpad6: 5, Numpad1: 6, Numpad2: 7, Numpad3: 8 };
        document.addEventListener('keydown', function (e) {
            if (!(e.code in NUMPAD) || e.repeat) return;
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' && e.target.type !== 'range' || tag === 'textarea') return;
            e.preventDefault();
            var i = NUMPAD[e.code];
            if (smp.banks[smp.bank][i]) padDown(i);
        });
        document.addEventListener('keyup', function (e) { if (e.code in NUMPAD) padUp(NUMPAD[e.code]); });

        smp.banks = emptyBanks();
        renderPads();
        apiJson('/EmbyDJ/Sampler/Pads').then(function (data) {
            if (data && Array.isArray(data.banks)) {
                smp.banks = emptyBanks();
                data.banks.slice(0, BANKS).forEach(function (bank, b) {
                    (bank || []).slice(0, PADS).forEach(function (pad, i) { smp.banks[b][i] = pad && pad.src ? pad : null; });
                });
                smp.bank = clamp(data.bank | 0, 0, BANKS - 1);
                if (typeof data.vol === 'number') smp.vol = data.vol;
            }
            smp.volKnob.set(smp.vol);
            renderPads();
            preloadBank();
        }).catch(function () { /* no pads yet */ }).then(function () { smp.loaded = true; });

        smp.volKnob = initKnob($('#smpVol'), 0.8, function (v) {
            smp.vol = v;
            smooth(smp.gain.gain, v * v / 0.64);
            if (smp.loaded) saveSampler();
        });
    }

    function preloadBank() {
        smp.banks[smp.bank].forEach(function (pad) { if (pad) padBuffer(pad).catch(function () { /* shown on play */ }); });
    }

    // =====================================================================================
    // Folder browser (File System Access API - Chrome / Edge, https or localhost only)
    // =====================================================================================
    var folder = { stack: [], entries: [], preview: null };
    var FOLDER_SUPPORTED = typeof window.showDirectoryPicker === 'function';

    // tiny IndexedDB store to remember the chosen folder between visits
    function idb(mode, fn) {
        return new Promise(function (resolve, reject) {
            var open = indexedDB.open('embydj', 1);
            open.onupgradeneeded = function () { open.result.createObjectStore('kv'); };
            open.onerror = function () { reject(open.error); };
            open.onsuccess = function () {
                var tx = open.result.transaction('kv', mode), req = fn(tx.objectStore('kv'));
                tx.oncomplete = function () { resolve(req && req.result); };
                tx.onerror = function () { reject(tx.error); };
            };
        });
    }
    function idbGet(key) { return idb('readonly', function (s) { return s.get(key); }); }
    function idbSet(key, val) { return idb('readwrite', function (s) { return s.put(val, key); }); }

    function openFolderBrowser() {
        if (!FOLDER_SUPPORTED) { toast(t('smpFolderUnsupported')); return; }
        $('#folderModal').classList.remove('hidden');
        if (folder.stack.length) { listFolder(); return; }
        idbGet('sampleFolder').then(function (h) {
            if (!h) { showFolderState('choose'); return; }
            folder.saved = h;
            h.queryPermission({ mode: 'read' }).then(function (perm) {
                if (perm === 'granted') { folder.stack = [h]; listFolder(); }
                else showFolderState('reconnect', h.name);
            });
        }).catch(function () { showFolderState('choose'); });
    }

    function showFolderState(state, name) {
        $('#fbPath').textContent = name || '';
        $('#fbList').innerHTML = '';
        $('#fbReconnect').classList.toggle('hidden', state !== 'reconnect');
        $('#fbEmpty').textContent = state === 'choose' ? t('smpFolderChoose') : state === 'reconnect' ? t('smpFolderReconnect') : '';
    }

    function chooseFolder() {
        window.showDirectoryPicker({ id: 'embydj-samples', mode: 'read' }).then(function (h) {
            folder.stack = [h];
            idbSet('sampleFolder', h).catch(function () { /* not remembered */ });
            listFolder();
        }).catch(function () { /* cancelled */ });
    }

    function listFolder() {
        var dir = folder.stack[folder.stack.length - 1];
        $('#fbPath').textContent = folder.stack.map(function (h) { return h.name; }).join(' / ');
        $('#fbUp').disabled = folder.stack.length < 2;
        $('#fbReconnect').classList.add('hidden');
        $('#fbEmpty').textContent = t('loadingMore');
        var entries = [];
        (async function () {
            for await (var entry of dir.values()) {
                if (entry.kind === 'directory' || AUDIO_EXT.test(entry.name)) entries.push({ name: entry.name, kind: entry.kind, handle: entry });
            }
        })().then(function () {
            entries.sort(function (a, b) {
                if (a.kind !== b.kind) return a.kind === 'directory' ? -1 : 1;
                return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' });
            });
            folder.entries = entries;
            renderFolder();
        }).catch(function (e) { $('#fbEmpty').textContent = String(e.message || e); });
    }

    function renderFolder() {
        var list = $('#fbList'), frag = document.createDocumentFragment();
        list.innerHTML = '';
        folder.entries.forEach(function (en, idx) {
            var row = document.createElement('div');
            row.className = 'fb-row ' + en.kind;
            row.dataset.idx = idx;
            if (en.kind === 'directory') {
                row.innerHTML = '<span class="fb-icon">&#128193;</span><span class="fb-name"></span>';
            } else {
                row.draggable = true;
                row.innerHTML = '<button class="btn tiny fb-play" title="Preview">&#9654;</button><span class="fb-name"></span>' +
                    '<button class="btn tiny fb-add" title="Load into the next free pad">&#8594; Pad</button>';
            }
            row.querySelector('.fb-name').textContent = en.name;
            frag.appendChild(row);
        });
        list.appendChild(frag);
        $('#fbEmpty').textContent = folder.entries.length ? '' : t('smpFolderEmpty');
    }

    function stopPreview() {
        if (folder.preview) { try { folder.preview.stop(); } catch (e) { /* ignore */ } folder.preview = null; }
    }

    function bindFolderBrowser() {
        $('#smpFolder').disabled = !FOLDER_SUPPORTED;
        if (!FOLDER_SUPPORTED) $('#smpFolder').title = t('smpFolderUnsupported');
        $('#fbChoose').addEventListener('click', chooseFolder);
        $('#fbReconnect').addEventListener('click', function () {
            var h = folder.saved;
            if (!h) return;
            h.requestPermission({ mode: 'read' }).then(function (perm) {
                if (perm === 'granted') { folder.stack = [h]; listFolder(); }
            });
        });
        $('#fbUp').addEventListener('click', function () { if (folder.stack.length > 1) { folder.stack.pop(); listFolder(); } });
        $('#fbClose').addEventListener('click', function () { stopPreview(); $('#folderModal').classList.add('hidden'); });
        var list = $('#fbList');
        list.addEventListener('click', function (e) {
            var row = e.target.closest('.fb-row');
            if (!row) return;
            var en = folder.entries[+row.dataset.idx];
            if (en.kind === 'directory') { folder.stack.push(en.handle); listFolder(); return; }
            if (e.target.closest('.fb-play')) {
                stopPreview();
                resumeAudio();
                en.handle.getFile().then(function (f) { return f.arrayBuffer(); }).then(function (ab) { return ctx.decodeAudioData(ab); })
                    .then(function (buf) {
                        var src = ctx.createBufferSource();
                        src.buffer = buf;
                        src.connect(smp.gain);
                        src.start();
                        folder.preview = src;
                    }).catch(function (err) { toast(t('smpLoadFailed', { e: err.message })); });
            } else if (e.target.closest('.fb-add')) {
                var i = nextFreePad();
                if (i < 0) { toast(t('smpBankFull')); return; }
                en.handle.getFile().then(function (f) { assignFile(i, f); });
            }
        });
        list.addEventListener('dragstart', function (e) {
            var row = e.target.closest('.fb-row.file');
            if (!row) return;
            e.dataTransfer.setData('text/x-embydj-folder', row.dataset.idx);
            e.dataTransfer.effectAllowed = 'copy';
        });
    }

    // =====================================================================================
    // Auto-Mix: plays one track after another with beat-matched transitions.
    //   - the next track is preloaded on the idle deck while the current one plays
    //   - tracks with a similar tempo (max. 8 % apart) are synced (tempo + beat phase),
    //     otherwise the transition is a plain crossfade
    //   - silence at the start / end of a track is skipped
    //   - start and crossfade are scheduled on the audio clock, so they stay exact even when
    //     the browser throttles timers in a background tab
    //   - any manual control of transport, crossfader or loading stops the Auto-Mix
    // =====================================================================================
    var AM_SYNC_LIMIT = 0.08;      // max. tempo difference for a beat-synced transition
    var AM_PLAIN_FADE = 8;         // seconds, transition without sync
    var AM_LEAD = 3;               // schedule the transition this many seconds ahead
    var AM_MIN_TRACK = 20;         // seconds, shorter tracks are skipped

    var am = {
        on: false, cur: -1, next: null, nextLoading: false, fade: null,
        played: {}, listIndex: -1, timer: null, finishTimer: null, glideTimer: null
    };

    function amDeck(i) { return decks[i]; }
    function amOther(i) { return i === 0 ? 1 : 0; }

    // audible range of a track (silence at the start / end skipped), in track seconds
    function audibleBounds(deck) {
        var w = deck.wave, dur = deck.duration;
        if (!w) return { start: 0, end: dur };
        var thrStart = 0.04, thrEnd = 0.06, s = 0, e = w.bins - 1;
        while (s < w.bins && w.peak[s] < thrStart) s++;
        while (e > s && w.peak[e] < thrEnd) e--;
        return { start: Math.min(s / w.fps, dur), end: Math.min((e + 1) / w.fps, dur) };
    }

    function amSetStatus() {
        toggle($('#amBtn'), 'on', am.on);
        var label = '';
        if (am.on) {
            if (am.next && am.next.item) label = t('amNext', { n: artistOf(am.next.item) + ' – ' + (am.next.item.Name || '') });
            else if (am.nextLoading) label = t('amLoading');
        }
        $('#amNext').textContent = label;
        $('#amNext').title = label;
    }

    // ---- choosing the next track ----
    function amListIds() {
        return Array.prototype.map.call(document.querySelectorAll('#libBody tr'), function (tr) { return tr.dataset.id; });
    }

    function amPickFromList() {
        var ids = amListIds();
        var cur = am.cur >= 0 && amDeck(am.cur).item ? amDeck(am.cur).item.Id : null;
        var idx = cur ? ids.indexOf(cur) : -1;
        if (idx < 0) idx = am.listIndex;
        var nextIdx = idx + 1;
        if (nextIdx >= ids.length) {
            if (lib.start < lib.total || lib.genrePhase) return libMore().then(amPickFromList);   // load the next page first
            nextIdx = 0;                                                       // end of the list: start over
        }
        if (!ids.length) return Promise.resolve(null);
        am.listIndex = nextIdx;
        var item = libItemsById[ids[nextIdx]];
        if (item && ticksToSec(item.RunTimeTicks) && ticksToSec(item.RunTimeTicks) < AM_MIN_TRACK && ids.length > 1) {
            return amPickFromList();
        }
        return Promise.resolve(item || null);
    }

    function amPickRandom() {
        function usable(it) {
            var len = ticksToSec(it.RunTimeTicks);
            return !am.played[it.Id] && (!len || len >= AM_MIN_TRACK) && !decks.some(function (d) { return d.item && d.item.Id === it.Id; });
        }
        if (lib.search) {
            // search results are all loaded: pick among them
            var pool = amListIds().map(function (id) { return libItemsById[id]; }).filter(function (it) { return it && usable(it); });
            if (!pool.length) { am.played = {}; pool = amListIds().map(function (id) { return libItemsById[id]; }).filter(Boolean); }
            return Promise.resolve(pool.length ? pool[Math.floor(Math.random() * pool.length)] : null);
        }
        return apiJson('/Users/' + auth.userId + '/Items', {
            IncludeItemTypes: 'Audio', Recursive: true, ParentId: lib.parentId, SortBy: 'Random', Limit: 10,
            EnableUserData: false, EnableImageTypes: 'Primary', ImageTypeLimit: 1, Fields: 'Genres'
        }).then(function (r) {
            var items = r.Items || [];
            var pick = items.filter(usable)[0] || items[0] || null;
            return pick;
        });
    }

    function amPickNext() { return $('#amMode').value === 'random' ? amPickRandom() : amPickFromList(); }

    // load the next track onto the idle deck
    function amPrepareNext() {
        if (!am.on || am.nextLoading || am.next) return;
        var target = amOther(am.cur), deck = amDeck(target);
        if (deck.playing) return;
        am.nextLoading = true;
        amSetStatus();
        amPickNext().then(function (item) {
            if (!am.on) return false;
            if (!item) { toast(t('amNoTrack')); amStop(); return false; }
            return deck.load(item).then(function (ok) { return ok ? item : false; });
        }).then(function (item) {
            am.nextLoading = false;
            if (!am.on || !item) { amSetStatus(); return; }
            am.played[item.Id] = true;
            am.next = { deck: target, item: item };
            amSetStatus();
        }).catch(function (e) {
            am.nextLoading = false;
            console.warn('EmbyDJ: Auto-Mix could not load the next track', e);
            amSetStatus();
        });
    }

    // ---- transition ----
    function amTransitionPlan(c, n, beats) {
        var plan = { tempo: 0, sync: false, fade: AM_PLAIN_FADE, startPos: audibleBounds(n).start };
        var bc = c.meta.bpm ? c.meta.bpm * c.rate : 0, bn = n.meta.bpm || 0;
        if (bc && bn) {
            var bnFold = bn;
            if (bc / bnFold > 1.4) bnFold *= 2; else if (bc / bnFold < 0.7) bnFold /= 2;
            var needed = bc / bnFold - 1;
            if (Math.abs(needed) <= AM_SYNC_LIMIT) {
                plan.sync = true;
                plan.tempo = needed;
                plan.bnFold = bnFold;
                plan.fade = beats * 60 / bc;
            }
        }
        return plan;
    }

    function amScheduleXfade(from, to, T, dur) {
        var steps = 64, a = new Float32Array(steps), b = new Float32Array(steps);
        for (var i = 0; i < steps; i++) {
            var p = i / (steps - 1);
            a[i] = Math.cos(p * Math.PI / 2);
            b[i] = Math.sin(p * Math.PI / 2);
        }
        var now = ctx.currentTime;
        [from.xf.gain, to.xf.gain].forEach(function (g) { g.cancelScheduledValues(now); });
        from.xf.gain.setValueAtTime(1, now);
        to.xf.gain.setValueAtTime(0, now);
        from.xf.gain.setValueCurveAtTime(a, T, dur);
        to.xf.gain.setValueCurveAtTime(b, T, dur);
    }

    function amStartTransition(T, beats) {
        if (!am.next || am.fade) return;
        var c = amDeck(am.cur), n = amDeck(am.next.deck);
        var plan = amTransitionPlan(c, n, beats);
        var now = ctx.currentTime;
        T = Math.max(T, now + 0.15);

        // keep the transition inside the rest of the current track
        var remain = c.playing ? (audibleBounds(c).end - c.position()) / c.rate - (T - now) : 0;
        var fade = Math.max(1, Math.min(plan.fade, remain > 2 ? remain : plan.fade));

        // tempo of the incoming deck
        if (plan.sync) {
            var needed = plan.tempo;
            if (Math.abs(needed) > n.range) n.setRange(Math.abs(needed) <= 0.16 ? 0.16 : 0.5);
            n.setTempo(needed / n.range);
        } else {
            n.setTempo(0);
        }

        // start position: in phase with the beat of the outgoing deck at time T
        var startPos = plan.startPos;
        if (plan.sync && c.meta.bpm) {
            var beatC = 60 / c.meta.bpm, beatN = 60 / plan.bnFold;
            var pcT = c.position() + (T - now) * c.rate;
            var phase = frac((pcT - (c.meta.offset || 0)) / beatC);
            var offN = n.meta.offset || 0;
            var k = Math.ceil((plan.startPos - offN) / beatN - phase);
            startPos = offN + (k + phase) * beatN;
        }

        n.playAt(startPos, T);
        amScheduleXfade(c, n, T, fade);
        am.fade = { T: T, dur: fade, from: am.cur, to: am.next.deck };
        clearTimeout(am.finishTimer);
        am.finishTimer = setTimeout(amFinishTransition, (T - now + fade) * 1000 + 150);
    }

    function amFinishTransition() {
        var f = am.fade;
        if (!f) return;
        am.fade = null;
        var out = amDeck(f.from), inc = amDeck(f.to);
        out.pause();
        out.xf.gain.cancelScheduledValues(ctx.currentTime);
        inc.xf.gain.cancelScheduledValues(ctx.currentTime);
        setCrossfader(f.to === 0 ? 0 : 1);
        am.cur = f.to;
        am.next = null;
        amGlideTempo(inc);
        amSetStatus();
        amPrepareNext();
    }

    // after a synced transition, bring the tempo slowly back to 0 % (about 8 s)
    function amGlideTempo(deck) {
        clearInterval(am.glideTimer);
        var start = deck.tempo, steps = 32, i = 0;
        if (!start) return;
        am.glideTimer = setInterval(function () {
            if (!am.on) { clearInterval(am.glideTimer); return; }
            i++;
            deck.setTempo(start * (1 - i / steps));
            if (i >= steps) clearInterval(am.glideTimer);
        }, 250);
    }

    function amTick() {
        if (!am.on || am.fade || am.cur < 0) return;   // cur < 0: the first track is still loading
        var c = amDeck(am.cur);
        if (!c.playing) {
            // the current track ended before a transition was possible: start the next one right away
            if (am.next) amStartTransition(ctx.currentTime + 0.1, 4);
            else amPrepareNext();
            return;
        }
        if (!am.next) { amPrepareNext(); return; }
        var beats = +$('#amLen').value;
        var plan = amTransitionPlan(c, amDeck(am.next.deck), beats);
        var remain = (audibleBounds(c).end - c.position()) / c.rate;   // seconds until the audible end
        var untilStart = remain - plan.fade;
        if (untilStart <= AM_LEAD) amStartTransition(ctx.currentTime + Math.max(0.15, untilStart), beats);
    }

    function amStart() {
        if (am.on) return;
        resumeAudio();
        am.on = true;
        am.played = {};
        am.next = null;
        am.fade = null;
        var playing = decks.filter(function (d) { return d.playing; });
        if (playing.length) {
            // continue from the deck that is currently heard most
            var cur = playing.length === 2 ? (xf.value < 0.5 ? 0 : 1) : decks.indexOf(playing[0]);
            am.cur = cur;
            if (playing.length === 2) amDeck(amOther(cur)).pause();
            if (amDeck(cur).item) am.played[amDeck(cur).item.Id] = true;
            setCrossfader(cur === 0 ? 0 : 1);
            amSetStatus();
            amPrepareNext();
        } else {
            am.cur = -1;          // no current track: the list starts at the top
            am.listIndex = -1;
            am.nextLoading = true;
            amSetStatus();
            // amPickFromList() also skips very short tracks (interludes)
            var first = $('#amMode').value === 'random' ? amPickRandom() : amPickFromList();
            first.then(function (item) {
                am.cur = 0;
                if (!am.on) return null;
                if (!item) { toast(t('amNoTrack')); amStop(); return null; }
                return decks[0].load(item).then(function (ok) { return ok ? item : null; });
            }).then(function (item) {
                am.nextLoading = false;
                if (!am.on || !item) { amSetStatus(); return; }
                am.played[item.Id] = true;
                setCrossfader(0);
                decks[0].playAt(audibleBounds(decks[0]).start, ctx.currentTime + 0.05);
                amSetStatus();
                amPrepareNext();
            });
        }
        clearInterval(am.timer);
        am.timer = setInterval(amTick, 250);
    }

    function amStop(manual) {
        if (!am.on) return;
        am.on = false;
        clearInterval(am.timer);
        clearInterval(am.glideTimer);
        clearTimeout(am.finishTimer);
        if (am.fade) {
            // freeze the crossfader where the transition currently is
            var p = clamp((ctx.currentTime - am.fade.T) / am.fade.dur, 0, 1);
            var to = am.fade.to;
            decks.forEach(function (d) { d.xf.gain.cancelScheduledValues(ctx.currentTime); });
            setCrossfader(to === 0 ? 1 - p : p);
            am.fade = null;
        }
        am.next = null;
        am.nextLoading = false;
        amSetStatus();
        if (manual) toast(t('amStopped'));
    }

    // manual control of transport / crossfader / loading takes over from the Auto-Mix
    function manual() { if (am.on) amStop(true); }

    function amSkip() {
        if (!am.on) return;
        if (am.fade) return;
        if (!am.next) { toast(t('amLoading')); return; }
        amStartTransition(ctx.currentTime + 0.15, 4);
    }

    // crossfader position while a transition runs (display only)
    function amRender() {
        if (!am.fade) return;
        var p = clamp((ctx.currentTime - am.fade.T) / am.fade.dur, 0, 1);
        var v = am.fade.to === 0 ? 1 - p : p;
        if (ctx.currentTime >= am.fade.T) { xf.value = v; $('#crossfader').value = v; }
    }

    function bindAutoMix() {
        $('#amBtn').addEventListener('click', function () { if (am.on) amStop(); else amStart(); });
        $('#amSkip').addEventListener('click', amSkip);
        $('#amMode').addEventListener('change', function () {
            // a different mode only affects the track after the one already loaded
            amSetStatus();
        });
        amSetStatus();
    }

    // =====================================================================================
    // Keyboard
    // =====================================================================================
    var KEYMAP = {
        KeyQ: [0, 'cue'], KeyW: [0, 'play'], KeyE: [0, 'sync'], KeyR: [0, 'loop'], KeyA: [0, 'nudgeDown'], KeyS: [0, 'nudgeUp'], KeyF: [0, 'fx'], KeyZ: [0, 'backspin'], KeyX: [0, 'brake'], KeyC: [0, 'forwardspin'],
        Digit1: [0, 'hc0'], Digit2: [0, 'hc1'], Digit3: [0, 'hc2'], Digit4: [0, 'hc3'],
        KeyO: [1, 'cue'], KeyP: [1, 'play'], KeyI: [1, 'sync'], KeyU: [1, 'loop'], KeyK: [1, 'nudgeDown'], KeyL: [1, 'nudgeUp'], KeyJ: [1, 'fx'], KeyM: [1, 'backspin'], Comma: [1, 'brake'], Period: [1, 'forwardspin'],
        Digit7: [1, 'hc0'], Digit8: [1, 'hc1'], Digit9: [1, 'hc2'], Digit0: [1, 'hc3']
    };

    function bindKeyboard() {
        document.addEventListener('keydown', function (e) {
            var tag = (e.target.tagName || '').toLowerCase();
            if (tag === 'input' && e.target.type !== 'range' || tag === 'select' || tag === 'textarea') return;
            if (e.ctrlKey || e.metaKey || e.altKey) return;
            if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
                e.preventDefault();
                var dir = e.code === 'ArrowLeft' ? -1 : 1;
                manual();
                setCrossfader(e.shiftKey ? (dir < 0 ? 0 : 1) : xf.value + dir * 0.05);
                return;
            }
            var m = KEYMAP[e.code];
            if (!m) return;
            e.preventDefault();
            var d = decks[m[0]], act = m[1];
            if (e.repeat && act !== 'nudgeDown' && act !== 'nudgeUp') return;
            if (act === 'cue') { manual(); d.cueDown(); }
            else if (act === 'play') { manual(); d.togglePlay(); }
            else if (act === 'sync') d.syncTo(d.other);
            else if (act === 'loop') d.toggleBeatLoop();
            else if (act === 'fx') d.toggleFx();
            else if (act === 'backspin') d.backspin();
            else if (act === 'brake') d.brake();
            else if (act === 'forwardspin') d.forwardspin();
            else if (act === 'nudgeDown') d.setNudge(0.96);
            else if (act === 'nudgeUp') d.setNudge(1.04);
            else if (act.indexOf('hc') === 0) {
                var i = +act.charAt(2);
                if (e.shiftKey) d.deleteHotcue(i); else d.hotcue(i);
            }
        });
        document.addEventListener('keyup', function (e) {
            var m = KEYMAP[e.code];
            if (!m) return;
            var d = decks[m[0]], act = m[1];
            if (act === 'cue') d.cueUp();
            else if (act === 'nudgeDown' || act === 'nudgeUp') d.setNudge(1);
        });
    }

    // =====================================================================================
    // Init
    // =====================================================================================
    function showFatal(title, hint) {
        document.body.innerHTML = '';
        var box = document.createElement('div');
        box.className = 'fatal';
        var h = document.createElement('h2'); h.textContent = title;
        var p = document.createElement('p'); p.textContent = hint;
        var a = document.createElement('a'); a.href = BASE.replace(/\/emby$/i, '') + '/web/index.html'; a.textContent = t('openEmby');
        box.appendChild(h); box.appendChild(p); box.appendChild(a);
        document.body.appendChild(box);
    }

    function frame() {
        requestAnimationFrame(frame); // first, so one failing frame never stops the loop
        try {
            decks[0].render();
            decks[1].render();
            drawBand();
            renderSamplerFrame();
            amRender();
            drawVu($('#masterVu'), masterAnalyser, masterVuData, masterVuState);
            toggle($('#limiterLed'), 'on', limiter.reduction < -1);
        } catch (e) {
            console.error('EmbyDJ: render failed', e);
        }
    }
    var masterVuData = new Float32Array(masterAnalyser.fftSize), masterVuState = {};

    // release channel shown next to the version number in the top bar
    var RELEASE_TAG = 'beta';

    function showVersion() {
        fetch(BASE + '/EmbyDJ/Version', { cache: 'no-store' })
            .then(function (r) { return r.json(); })
            .then(function (v) { $('#version').textContent = 'v' + v.Version + (RELEASE_TAG ? ' ' + RELEASE_TAG : ''); })
            .catch(function () { /* label stays empty */ });
    }

    // ---- shared waveform band: lane A on top, lane B below, common centre playhead ----
    function drawBand() {
        var cv = $('#bandWave');
        fitCanvas(cv);
        var g = cv.getContext('2d'), W = cv.width, H = cv.height;
        if (!W || !H) return;
        g.fillStyle = '#0a0b0d';
        g.fillRect(0, 0, W, H);
        var laneH = Math.floor(H / 2), spp = ZOOM.seconds / W;
        decks[0].drawLane(g, 0, W, laneH, decks[0].position(), spp);
        decks[1].drawLane(g, H - laneH, W, laneH, decks[1].position(), spp);
        g.fillStyle = '#2c303a';
        g.fillRect(0, laneH - 1, W, 2);
        g.fillStyle = '#fff';
        g.fillRect(Math.round(W / 2) - 1, 0, 2, H);
    }

    function bindBand() {
        var cv = $('#bandWave'), drag = null;
        cv.addEventListener('pointerdown', function (e) {
            var r = cv.getBoundingClientRect();
            var d = decks[(e.clientY - r.top) < r.height / 2 ? 0 : 1];
            if (!d.buffer) return;
            cv.setPointerCapture(e.pointerId);
            var wasPlaying = d.playing;
            d.pause();
            drag = { deck: d, x: e.clientX, pos: d.pos, wasPlaying: wasPlaying };
        });
        cv.addEventListener('pointermove', function (e) {
            if (!drag) return;
            var d = drag.deck, w = cv.getBoundingClientRect().width;
            d.pos = clamp(drag.pos - (e.clientX - drag.x) / w * ZOOM.seconds, 0, d.duration);
            if (d.loop.active && (d.pos < d.loop.start || d.pos >= d.loop.end)) d.loop.active = false;
        });
        function end() {
            if (!drag) return;
            var d = drag.deck, resume = drag.wasPlaying;
            drag = null;
            if (resume) d.play();
        }
        cv.addEventListener('pointerup', end);
        cv.addEventListener('pointercancel', end);
        cv.addEventListener('wheel', function (e) {
            e.preventDefault();
            ZOOM.seconds = clamp(ZOOM.seconds * (e.deltaY > 0 ? 1.15 : 1 / 1.15), 2, 40);
        }, { passive: false });
    }

    function init() {
        auth = findAuth();
        if (!auth) { showFatal(t('noAuth'), t('noAuthHint')); return; }
        try { sessionStorage.setItem('embydj-auth', JSON.stringify(auth)); } catch (e) { /* ignore */ }

        applyI18n(document);
        document.documentElement.lang = LANG;

        loadEngine().then(function () { startApp(); });
    }

    // AudioWorklet needs a secure context (https or localhost); otherwise use the fallback engine.
    function loadEngine() {
        if (!ctx.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve();
        return ctx.audioWorklet.addModule('deck-worklet.js?v=' + Date.now())
            .then(function () { USE_WORKLET = true; })
            .catch(function (e) { console.warn('EmbyDJ: AudioWorklet unavailable, using fallback engine', e); });
    }

    function startApp() {
        decks = [new Deck('A', $('#deckA'), $('#chA')), new Deck('B', $('#deckB'), $('#chB'))];
        decks[0].other = decks[1];
        decks[1].other = decks[0];

        showVersion();
        bindBand();
        bindSampler();
        initKnob($('#masterKnob'), 0.8, function (v) { smooth(masterGain.gain, v * v / 0.64); });
        $('#crossfader').addEventListener('input', function () { manual(); setCrossfader(+$('#crossfader').value); });
        $('#crossfader').addEventListener('dblclick', function () { manual(); setCrossfader(0.5); });
        $('#xfCurve').addEventListener('change', function () { xf.curve = $('#xfCurve').value; applyCrossfader(); });
        setCrossfader(0.5);

        if (window.parent !== window) {
            // Embedded in the Emby dashboard: offer a full-window version (audio here stops when it opens).
            var nt = $('#newTabBtn');
            nt.classList.remove('hidden');
            nt.addEventListener('click', function () {
                decks.forEach(function (d) { d.pause(); });
                window.open(location.pathname + '?v=' + Date.now(), '_blank');
            });
        }
        $('#helpBtn').addEventListener('click', function () { $('#help').classList.remove('hidden'); });
        $('#helpClose').addEventListener('click', function () { $('#help').classList.add('hidden'); });

        bindLibrary();
        bindColumns();
        bindAutoMix();
        toggle($('#autoGainBtn'), 'on', autoGain);
        $('#autoGainBtn').addEventListener('click', function () {
            autoGain = !autoGain;
            try { localStorage.setItem('embydj-autogain', autoGain ? 'on' : 'off'); } catch (e) { /* ignore */ }
            toggle($('#autoGainBtn'), 'on', autoGain);
            decks.forEach(function (d) { d.applyAutoGain(); });
        });
        // no browser context menu except in text fields (pads, hot cues and the table header have their own)
        document.addEventListener('contextmenu', function (e) {
            if (!e.target.closest('input[type=search], input[type=text], textarea')) e.preventDefault();
        });
        bindKeyboard();
        requestAnimationFrame(frame);

        apiJson('/Users/' + auth.userId).then(function (u) {
            $('#status').textContent = t('ready', { u: u.Name }) + ' · ' + ctx.sampleRate + ' Hz · ' + (USE_WORKLET ? 'Engine: Worklet' : t('noScratch'));
        }).catch(function (e) {
            if (/401/.test(String(e.message))) { sessionStorage.removeItem('embydj-auth'); showFatal(t('noAuth'), t('noAuthHint')); }
        });
        loadSources().then(libReload);
    }

    init();
})();
