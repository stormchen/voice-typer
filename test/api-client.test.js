const test = require('node:test');
const assert = require('node:assert/strict');
const ASRClient = require('../src/components/api-client');

const { friendlyError, isRetryable, retryDelayMs } = ASRClient;

function responseError(status, headers = {}, data = {}) {
  const error = new Error(`Request failed with status code ${status}`);
  error.response = { status, headers, data };
  return error;
}

function networkError(code) {
  const error = new Error('network failure');
  error.code = code;
  return error;
}

test('friendlyError 將常見狀態碼轉為中文訊息', () => {
  assert.equal(friendlyError(responseError(429), 'Groq API'), '已達 Groq API 的速率限制（429），重試後仍被限制，請稍後再試');
  assert.equal(friendlyError(responseError(401), 'Gemini API'), 'Gemini API拒絕存取（401），請檢查 API Key');
  assert.equal(friendlyError(responseError(404), 'vLLM 伺服器'), 'vLLM 伺服器找不到辨識端點（404），請確認地址與模型名稱');
  assert.equal(friendlyError(responseError(413)), '音頻檔案過大（413），請縮短錄音長度');
  assert.equal(friendlyError(responseError(500, {}, { detail: 'busy' })), '伺服器錯誤（500）: busy');
  assert.equal(friendlyError(responseError(502)), '伺服器錯誤（502）');
});

test('friendlyError 區分網路層錯誤', () => {
  assert.equal(friendlyError(networkError('ECONNREFUSED'), 'vLLM 伺服器'), '無法連線到 vLLM 伺服器，請確認服務可達且地址正確');
  assert.equal(friendlyError(networkError('ENOTFOUND')), '找不到 伺服器 的主機，請檢查地址');
  assert.equal(friendlyError(networkError('ECONNABORTED')), '請求逾時，伺服器可能忙碌或網路不穩');
  assert.equal(friendlyError(networkError('ECONNRESET')), '連線被重置，請重試');
  assert.equal(friendlyError(new Error('boom')), 'boom');
});

test('isRetryable 只重試網路錯誤、429 與 5xx', () => {
  assert.equal(isRetryable(responseError(400)), false);
  assert.equal(isRetryable(responseError(401)), false);
  assert.equal(isRetryable(responseError(404)), false);
  assert.equal(isRetryable(responseError(429)), true);
  assert.equal(isRetryable(responseError(500)), true);
  assert.equal(isRetryable(responseError(503)), true);
  assert.equal(isRetryable(networkError('ETIMEDOUT')), true);
});

test('retryDelayMs 優先尊重 Retry-After，並上限 60 秒', () => {
  assert.equal(retryDelayMs(responseError(429, { 'retry-after': '2' }), 0), 2000);
  assert.equal(retryDelayMs(responseError(429, { 'retry-after': '0' }), 0), 0);
  assert.equal(retryDelayMs(responseError(429, { 'retry-after': '61' }), 0), 60000);
  assert.equal(retryDelayMs(responseError(429, { 'retry-after': 'not-a-number' }), 1), 2000);

  const future = new Date(Date.now() + 3000).toUTCString();
  const delay = retryDelayMs(responseError(429, { 'retry-after': future }), 0);
  assert.ok(delay >= 2000 && delay <= 3000, `HTTP-date 退避应在 2000-3000ms，實得 ${delay}`);

  const past = new Date(Date.now() - 5000).toUTCString();
  assert.equal(retryDelayMs(responseError(429, { 'retry-after': past }), 0), 0);
});

test('_timeoutFor 依音頻長度估算，上限 300 秒', () => {
  const client = new ASRClient();
  assert.equal(client._timeoutFor(Buffer.alloc(32000)), 32000);   // 1 秒音頻
  assert.equal(client._timeoutFor(Buffer.alloc(32000 * 60)), 150000); // 60 秒
  assert.equal(client._timeoutFor(Buffer.alloc(32000 * 200)), 300000); // 超過上限
});

test('updateConfig 保留未傳入的既有設定', () => {
  const client = new ASRClient({ backend: 'groq', apiKey: 'k', model: 'm' });
  client.updateConfig({ apiKey: 'k2' });
  assert.equal(client.config.backend, 'groq');
  assert.equal(client.config.model, 'm');
  assert.equal(client.config.apiKey, 'k2');
  assert.equal(client.config.apiUrl, 'http://localhost:8000');
  client.updateConfig({ apiUrl: 'http://example.com/v1/' });
  assert.equal(client.config.apiUrl, 'http://example.com/v1');
});
