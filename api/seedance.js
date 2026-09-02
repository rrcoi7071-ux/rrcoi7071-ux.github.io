const { Readable } = require('node:stream');
const { applyCors, originAllowed } = require('../lib/cors');

const TASKS_ENDPOINT = 'https://ark.ap-southeast.bytepluses.com/api/v3/contents/generations/tasks';

async function readPayload(response) {
  const raw = await response.text();
  try { return raw ? JSON.parse(raw) : {}; }
  catch { return { error: { message: raw || `BytePlus API ${response.status}` } }; }
}

async function bytePlus(path, options = {}) {
  const apiKey = process.env.BYTEPLUS_API_KEY;
  if (!apiKey) throw new Error('サーバーにBYTEPLUS_API_KEYが設定されていません');
  return fetch(`${TASKS_ENDPOINT}${path}`, {
    ...options,
    headers: { ...(options.body ? { 'Content-Type': 'application/json' } : {}), Authorization: `Bearer ${apiKey}` },
  });
}

module.exports = async function handler(req, res) {
  applyCors(req, res);
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (!originAllowed(req)) return res.status(403).json({ error: { message: '許可されていないサイトからのアクセスです' } });

  try {
    if (req.method === 'POST') {
      const response = await bytePlus('', { method: 'POST', body: JSON.stringify(req.body || {}) });
      return res.status(response.status).json(await readPayload(response));
    }

    if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
    const taskId = String(req.query.taskId || '');
    if (!/^[A-Za-z0-9_-]{1,200}$/.test(taskId)) return res.status(400).json({ error: { message: 'taskIdが不正です' } });

    const statusResponse = await bytePlus(`/${encodeURIComponent(taskId)}`, { method: 'GET' });
    const task = await readPayload(statusResponse);
    if (!statusResponse.ok) return res.status(statusResponse.status).json(task);

    if (req.query.download !== '1') {
      if (task?.content?.video_url) {
        delete task.content.video_url;
        task.video_ready = true;
      }
      return res.status(200).json(task);
    }

    const videoUrl = task?.content?.video_url;
    if (String(task?.status || '').toLowerCase() !== 'succeeded' || !videoUrl) {
      return res.status(409).json({ error: { message: '動画はまだダウンロードできません' } });
    }
    const videoResponse = await fetch(videoUrl);
    if (!videoResponse.ok || !videoResponse.body) {
      return res.status(502).json({ error: { message: `BytePlus動画の取得に失敗しました (${videoResponse.status})` } });
    }
    res.status(200);
    res.setHeader('Content-Type', videoResponse.headers.get('content-type') || 'video/mp4');
    const length = videoResponse.headers.get('content-length');
    if (length) res.setHeader('Content-Length', length);
    return Readable.fromWeb(videoResponse.body).pipe(res);
  } catch (error) {
    console.error('Seedance proxy error', error);
    return res.status(502).json({ error: { message: error?.message || 'BytePlusへの接続に失敗しました' } });
  }
};
