import { getCustomPlaylist } from '../_utils/store.js';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let id = req.query?.id || '';
  if (Array.isArray(id)) id = id[0];
  id = id.replace(/\.m3u8$/i, '');

  const content = getCustomPlaylist(id);
  if (!content) {
    return res.status(404).send('#EXTM3U\n# Error: Custom playlist expired or not found');
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  return res.status(200).send(content);
}
