// 音頻錄製器（渲染進程）
// 使用 Web Audio API 擷取 16kHz 單聲道 PCM，並編碼為 WAV
// VibeVoice-ASR 要求 16kHz 取樣率
class WebAudioRecorder {
  constructor(sampleRate = 16000) {
    this.targetRate = sampleRate;
    this.chunks = [];
    this.stream = null;
    this.audioContext = null;
    this.processor = null;
    this.source = null;
    this.recording = false;
  }

  async start() {
    if (this.recording) return;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        noiseSuppression: true,
        echoCancellation: true
      }
    });

    this.audioContext = new AudioContext();
    // 渲染進程可能以 suspended 狀態建立 AudioContext，未 resume 時不會產生 onaudioprocess
    await this.audioContext.resume();
    this.source = this.audioContext.createMediaStreamSource(this.stream);

    // ScriptProcessor 相容性最佳（AudioWorklet 需額外檔案）
    this.processor = this.audioContext.createScriptProcessor(4096, 1, 1);
    this.chunks = [];

    this.processor.onaudioprocess = (e) => {
      if (!this.recording) return;
      this.chunks.push(new Float32Array(e.inputBuffer.getChannelData(0)));
    };

    this.source.connect(this.processor);
    this.processor.connect(this.audioContext.destination);
    this.recording = true;
  }

  // 停止錄音並回傳 WAV 的 ArrayBuffer
  async stop() {
    if (!this.recording) return null;
    this.recording = false;

    const inputRate = this.audioContext.sampleRate;

    // 逐項清理，任一失敗不影響後續資源釋放
    try { this.source.disconnect(); } catch (_) {}
    try { this.processor.disconnect(); } catch (_) {}
    try { this.stream.getTracks().forEach((t) => t.stop()); } catch (_) {}
    try { await this.audioContext.close(); } catch (_) {}
    this.source = null;
    this.processor = null;
    this.stream = null;
    this.audioContext = null;

    // 合併所有音頻塊
    const totalLength = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const merged = new Float32Array(totalLength);
    let offset = 0;
    for (const chunk of this.chunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }
    this.chunks = [];

    // 重新採樣到 16kHz
    const resampled = this._resample(merged, inputRate, this.targetRate);

    // 標準化音量，避免過度削波
    const normalized = this._normalize(resampled);

    return this._encodeWav(normalized, this.targetRate);
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
