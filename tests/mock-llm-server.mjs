/**
 * tests/mock-llm-server.mjs — MiMo ASR/TTS + DeepSeek Chat 的本地 Mock（完成度批次2）
 * 语音链路 E2E 不再依赖真实 XIAOMI_MIMO_API_KEY；同时校验 Bearer 头接线正确。
 */
import http from 'node:http';

const ASR_TEXT = '测试语音转写内容';
const TTS_AUDIO = Buffer.from('mockAudioBytes').toString('base64');
const CHAT_REPLY = '（mock）好的，我在听。';

export function startMockLlmServer() {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      if (!/^Bearer .+/.test(req.headers.authorization || '')) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ error: 'missing bearer' }));
      }
      let payload = {};
      try { payload = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { /* ignore */ }
      const model = payload.model || '';
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (model === 'mimo-v2.5-asr') {
        return res.end(JSON.stringify({ choices: [{ message: { content: ASR_TEXT } }] }));
      }
      if (model === 'mimo-v2.5-tts') {
        return res.end(JSON.stringify({ choices: [{ message: { audio: { data: TTS_AUDIO } } }] }));
      }
      // deepseek chat 形态
      return res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: CHAT_REPLY } }] }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, url: `http://127.0.0.1:${server.address().port}`, ASR_TEXT, TTS_AUDIO, CHAT_REPLY }));
  });
}
