/**
 * CosyVoice 复刻音色合成(2026-07-19)——DashScope WebSocket SpeechSynthesizer。
 * 复刻链路:样本上传 OSS → voice-enrollment(target cosyvoice-v2)→ voice_id;
 * 合成只走 WS(REST /audio/tts 与 multimodal-generation 对 cosyvoice 均不可用,
 * 网关实测报 url error/Access denied)。返回 mp3 Buffer,调用方自行落盘。
 */
import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';

export class CosyVoiceError extends Error {}

export function cosyvoiceSynthesize(opts: {
  /** DashScope 网关 base(https://…),内部转 wss。 */
  baseUrl: string;
  apiKey: string;
  /** 复刻音色 id(cosyvoice-v2-… 开头)。 */
  voice: string;
  text: string;
  timeoutMs?: number;
}): Promise<Buffer> {
  const wsUrl = `${opts.baseUrl.replace(/^https:\/\//, 'wss://').replace(/\/$/, '')}/api-ws/v1/inference`;
  const taskId = randomUUID();
  return new Promise<Buffer>((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { Authorization: `bearer ${opts.apiKey}` } });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* ignore */ }
      reject(new CosyVoiceError('复刻音色合成超时'));
    }, opts.timeoutMs ?? 120_000);
    const fail = (msg: string) => {
      clearTimeout(timer);
      try { ws.close(); } catch { /* ignore */ }
      reject(new CosyVoiceError(msg));
    };
    ws.on('open', () => {
      ws.send(JSON.stringify({
        header: { action: 'run-task', task_id: taskId, streaming: 'duplex' },
        payload: {
          task_group: 'audio', task: 'tts', function: 'SpeechSynthesizer',
          model: 'cosyvoice-v2',
          parameters: { voice: opts.voice, format: 'mp3', sample_rate: 22050 },
          input: {},
        },
      }));
    });
    ws.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) { chunks.push(Buffer.from(data)); return; }
      let msg: { header?: { event?: string; error_message?: string } };
      try { msg = JSON.parse(data.toString()); } catch { return; }
      const ev = msg.header?.event;
      if (ev === 'task-started') {
        ws.send(JSON.stringify({ header: { action: 'continue-task', task_id: taskId, streaming: 'duplex' }, payload: { input: { text: opts.text } } }));
        ws.send(JSON.stringify({ header: { action: 'finish-task', task_id: taskId, streaming: 'duplex' }, payload: { input: {} } }));
      } else if (ev === 'task-finished') {
        clearTimeout(timer);
        try { ws.close(); } catch { /* ignore */ }
        if (!chunks.length) return reject(new CosyVoiceError('复刻音色合成没有返回音频'));
        resolve(Buffer.concat(chunks));
      } else if (ev === 'task-failed') {
        fail(`复刻音色合成失败:${msg.header?.error_message ?? '未知错误'}`);
      }
    });
    ws.on('error', (e) => fail(`复刻音色合成连接失败:${e instanceof Error ? e.message : String(e)}`));
  });
}
