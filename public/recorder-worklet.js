// 在音訊執行緒收集單聲道資料，停止時先送出最後一塊再確認。
class RecorderProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(4096);
    this.length = 0;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data.type !== 'stop' || this.stopped) return;
      this.stopped = true;
      this.flush();
      this.port.postMessage({ type: 'stopped' });
    };
  }

  flush() {
    if (!this.length) return;
    const samples = this.length === this.buffer.length
      ? this.buffer : this.buffer.slice(0, this.length);
    this.port.postMessage({ type: 'chunk', samples }, [samples.buffer]);
    this.buffer = new Float32Array(4096);
    this.length = 0;
  }

  process(inputs) {
    if (this.stopped) return false;
    const samples = inputs[0] && inputs[0][0];
    if (samples) {
      let offset = 0;
      while (offset < samples.length) {
        const count = Math.min(samples.length - offset, this.buffer.length - this.length);
        this.buffer.set(samples.subarray(offset, offset + count), this.length);
        this.length += count;
        offset += count;
        if (this.length === this.buffer.length) this.flush();
      }
    }
    return true;
  }
}

registerProcessor('voice-typer-recorder', RecorderProcessor);
