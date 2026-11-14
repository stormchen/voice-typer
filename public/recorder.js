// 音頻錄製器（渲染進程）
// 使用 Web Audio API 擷取 16kHz 單聲道 PCM，並編碼為 WAV
// VibeVoice-ASR 要求 16kHz 取樣率
const recorderWorkletUrl = new URL('recorder-worklet.js', document.currentScript.src).href;
const AUDIO_CLOSE_TIMEOUT_MS = 5000;

class WebAudioRecorder {
  constructor(sampleRate = 16000) {
    this.targetRate = sampleRate;
    this.chunks = [];
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.recording = false;
    this._session = null;
    this._pendingStart = null;
  }

  start(onError, id) {
    const previous = this._session;
    if (previous) {
      if (id !== undefined && previous.id !== id) {
        return Promise.reject(new Error('前次錄音尚未結束，請稍後再試'));
      }
      if (previous.state === 'starting' || previous.state === 'recording') {
        return previous.startPromise;
      }
      if (this._pendingStart) return this._pendingStart.promise;
      const finishing = previous.stopPromise || previous.cleanupPromise;
      const pending = { cancelled: false };
      pending.promise = finishing.catch(() => {}).then(() => {
        if (this._pendingStart === pending) this._pendingStart = null;
        if (pending.cancelled) return;
        if (this._session === previous) this._session = null;
        return this.start(onError, id);
      });
      this._pendingStart = pending;
      return pending.promise;
    }

    let cancel;
    const session = {
      state: 'starting',
      id,
      cancelled: false,
      onError,
      chunks: [],
      cancelPromise: new Promise((resolve) => { cancel = resolve; }),
      cancel
    };
    this._session = session;
    session.startPromise = this._startSession(session);
    return session.startPromise;
  }

  async _startSession(session) {
    try {
      const streamPromise = navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          noiseSuppression: true,
          echoCancellation: true
        }
      }).then((stream) => {
        // getUserMedia 無法取消；若停止後才取得串流，仍須釋放。
        if (session.cancelled) this._stopTracks(stream);
        else this.stream = session.stream = stream;
        return stream;
      });
      const stream = await Promise.race([streamPromise, session.cancelPromise]);
      if (session.cancelled) return;

      const context = this.audioContext = session.audioContext = new AudioContext();
      // 隱藏視窗也可能以 suspended 狀態建立 AudioContext。
      await Promise.race([context.resume(), session.cancelPromise]);
      if (session.cancelled) return;
      await Promise.race([context.audioWorklet.addModule(recorderWorkletUrl), session.cancelPromise]);
      if (session.cancelled) return;

      const source = this.source = session.source = context.createMediaStreamSource(stream);
      const processor = this.processor = session.processor = new AudioWorkletNode(context, 'voice-typer-recorder', {
        channelCount: 1,
        channelCountMode: 'explicit'
      });
      this.chunks = session.chunks;
      processor.port.onmessage = ({ data }) => {
        if (data.type === 'chunk') session.chunks.push(data.samples);
        else if (data.type === 'stopped' && session.resolveDrain) session.resolveDrain();
      };
      processor.onprocessorerror = () => {
        session.error = new Error('AudioWorklet processor failed');
        if (session.state === 'stopping' && session.rejectDrain) {
          session.rejectDrain(session.error);
        } else if (session.state === 'recording') {
          session.state = 'failed';
          session.chunks = [];
          this.chunks = [];
          this._cleanupSession(session).then(() => {
            // 已主動回報錯誤時，資源釋放後允許新的工作階段開始。
            if (session.errorNotified && this._session === session) this._session = null;
          });
          if (typeof session.onError === 'function') {
            // 回呼可能同步呼叫 stop，先標記以免重複回報。
            session.errorNotified = true;
            const onError = session.onError;
            onError(session.error);
          }
        }
      };

      source.connect(processor);
      // 不輸出聲音，但保持節點連至 destination，讓隱藏視窗持續處理音訊。
      processor.connect(context.destination);
      session.state = 'recording';
      this.recording = true;
    } catch (error) {
      session.state = 'failed';
      session.error = error;
      await this._cleanupSession(session);
      if (!session.cancelled) {
        if (this._session === session) this._session = null;
        throw error;
      }
    }
  }

  // 停止錄音並回傳 WAV 的 ArrayBuffer
  stop(id) {
    const session = this._session;
    if (id !== undefined && session && session.id !== id) return Promise.resolve(null);
    if (this._pendingStart) {
      this._pendingStart.cancelled = true;
      this._pendingStart = null;
    }
    if (!session) return Promise.resolve(null);
    if (session.state === 'stopping') return session.stopPromise;

    const wasStarting = session.state === 'starting';
    const error = session.error;
    session.state = 'stopping';
    this.recording = false;
    if (wasStarting) {
      session.cancelled = true;
      session.cancel();
    }

    session.stopPromise = (async () => {
      try {
        if (wasStarting || error) {
          await this._cleanupSession(session);
          if (error && !session.errorNotified) throw error;
          return null;
        }
        return await this._stopSession(session);
      } finally {
        if (this._session === session) this._session = null;
      }
    })();
    return session.stopPromise;
  }

  async _stopSession(session) {
    const inputRate = session.audioContext.sampleRate;
    let timer;
    try {
      // 同一 MessagePort 的先後順序確保 stopped 之前的所有音訊已接收。
      await new Promise((resolve, reject) => {
        session.resolveDrain = resolve;
        session.rejectDrain = reject;
        timer = setTimeout(() => reject(new Error('AudioWorklet stop timed out')), 5000);
        try { session.processor.port.postMessage({ type: 'stop' }); } catch (error) { reject(error); }
      });
    } catch (error) {
      session.chunks = [];
      if (this._session === session) this.chunks = [];
      throw error;
    } finally {
      clearTimeout(timer);
      session.resolveDrain = null;
      session.rejectDrain = null;
      await this._cleanupSession(session);
    }

    // 合併所有音頻塊
    const totalLength = session.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of session.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    session.chunks = [];
    this.chunks = [];

    // 重新採樣到 16kHz
    const resampled = this._resample(merged, inputRate, this.targetRate);

    // 標準化音量，避免過度削波
    const normalized = this._normalize(resampled);

    return this._encodeWav(normalized, this.targetRate);
  }

  _stopTracks(stream) {
    if (!stream) return;
    try {
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch (_) {}
      }
    } catch (_) {}
  }

  _cleanupSession(session) {
    if (session.cleanupPromise) return session.cleanupPromise;
    const { source, processor, stream, audioContext } = session;
    session.source = session.processor = session.stream = session.audioContext = null;
    if (this._session === session) {
      this.source = this.processor = this.stream = this.audioContext = null;
      this.recording = false;
    }
    session.cleanupPromise = (async () => {
      try { if (source) source.disconnect(); } catch (_) {}
      try { if (processor) processor.disconnect(); } catch (_) {}
      if (processor) {
        processor.port.onmessage = null;
        processor.onprocessorerror = null;
        try { processor.port.close(); } catch (_) {}
      }
      this._stopTracks(stream);
      let timer;
      try {
        if (audioContext) {
          await Promise.race([
            audioContext.close(),
            new Promise((resolve) => { timer = setTimeout(resolve, AUDIO_CLOSE_TIMEOUT_MS); })
          ]);
        }
      } catch (_) {
        // 麥克風 tracks 已停止；關閉失敗不應阻塞下一次錄音。
      } finally {
        if (timer) clearTimeout(timer);
      }
    })();
    return session.cleanupPromise;
  }

  // 線性插值重新採樣
  _resample(samples, fromRate, toRate) {
    if (fromRate === toRate) return samples;
    const ratio = fromRate / toRate;
    const newLength = Math.round(samples.length / ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const pos = i * ratio;
      const idx = Math.floor(pos);
      const frac = pos - idx;
      const a = samples[idx] || 0;
      const b = samples[idx + 1] !== undefined ? samples[idx + 1] : a;
      result[i] = a + (b - a) * frac;
    }
    return result;
  }

  // 標準化振幅到 95%
  _normalize(samples) {
    let max = 0;
    for (let i = 0; i < samples.length; i++) {
      const abs = Math.abs(samples[i]);
      if (abs > max) max = abs;
    }
    if (max === 0 || max >= 0.95) return samples;
    const gain = 0.95 / max;
    const result = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      result[i] = samples[i] * gain;
    }
    return result;
  }

  // 編碼為 16-bit PCM WAV
  _encodeWav(samples, sampleRate) {
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);

    const writeString = (offset, str) => {
      for (let i = 0; i < str.length; i++) {
        view.setUint8(offset + i, str.charCodeAt(i));
      }
    };

    writeString(0, 'RIFF');
    view.setUint32(4, 36 + samples.length * 2, true);
    writeString(8, 'WAVE');
    writeString(12, 'fmt ');
    view.setUint32(16, 16, true);          // fmt chunk 大小
    view.setUint16(20, 1, true);           // PCM 格式
    view.setUint16(22, 1, true);           // 單聲道
    view.setUint32(24, sampleRate, true);  // 取樣率
    view.setUint32(28, sampleRate * 2, true); // byte rate
    view.setUint16(32, 2, true);           // block align
    view.setUint16(34, 16, true);          // 16 bits
    writeString(36, 'data');
    view.setUint32(40, samples.length * 2, true);

    // Float32 → Int16
    let offset = 44;
    for (let i = 0; i < samples.length; i++, offset += 2) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    }

    return buffer;
  }
}

window.WebAudioRecorder = WebAudioRecorder;
