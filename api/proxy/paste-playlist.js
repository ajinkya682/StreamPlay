import { rewriteM3u8Content } from '../_utils/rewriter.js';
import { saveCustomPlaylist } from '../_utils/store.js';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method Not Allowed' });
  }

  // Parse body if string
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch (e) {}
  }

  const { content, baseUrl } = body || {};
  if (!content || !baseUrl) {
    return res.status(400).json({ error: 'Both content and baseUrl are required.' });
  }

  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const rewritten = rewriteM3u8Content(content, baseUrl);
  saveCustomPlaylist(id, rewritten);

  return res.status(200).json({
    success: true,
    id,
    playlistUrl: `/api/proxy/custom/${id}.m3u8`
  });
}
