# vLLM 伺服器部署指南（方案 A：遠端伺服器）

VoiceTyper 透過 OpenAI 相容 REST API 與 vLLM 伺服器通信。伺服器需在具備 GPU 的機器上運行 VibeVoice-ASR 模型。

## 安裝

```bash
# 在 VibeVoice 環境中
cd /path/to/vibevoice
pip install vllm
```

## 啟動伺服器

```bash
python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --tensor-parallel-size 2 \
  --gpu-memory-utilization 0.8 \
  --port 8000 \
  --host 0.0.0.0
```

參數說明：`--tensor-parallel-size` 為 GPU 數量，`--gpu-memory-utilization` 為 GPU 記憶體使用率上限，`--host 0.0.0.0` 允許遠端連接。

## 模型量化（記憶體不足時）

```bash
python -m vllm.entrypoints.openai.api_server \
  --model microsoft/vibevoice-asr \
  --quantization awq \
  --gpu-memory-utilization 0.5 \
  --port 8000
```

## 驗證伺服器

```bash
# 列出可用模型
curl http://localhost:8000/v1/models

# 測試轉錄
curl http://localhost:8000/v1/audio/transcriptions \
  -F file=@test.wav \
  -F model=vibevoice-asr \
  -F language=zh-TW
```

## 故障排查

vLLM 無法啟動時依序檢查：

```bash
# Python 環境
python -m vllm --version

# 模型是否可下載
python -c "from transformers import AutoModelForCausalLM; AutoModelForCausalLM.from_pretrained('microsoft/vibevoice-asr')"

# GPU 記憶體
nvidia-smi
```

VoiceTyper 連不上伺服器時：確認防火牆已開放 8000 端口、伺服器以 `--host 0.0.0.0` 啟動、VoiceTyper 設定面板中的地址正確（含 `http://` 前綴，不含結尾斜線）。

## 部署檢查清單

- [ ] VibeVoice 環境已安裝
- [ ] vLLM 伺服器可正常啟動
- [ ] `curl /v1/models` 回傳模型列表
- [ ] 防火牆已開放 8000 端口（遠端伺服器）
- [ ] VoiceTyper 設定面板「測試連接」成功
- [ ] 音頻轉錄測試成功
