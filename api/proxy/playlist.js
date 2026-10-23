import { rewriteM3u8Content } from '../_utils/rewriter.js';

export default async function handler(req, res) {
  // Global CORS headers for cross-origin player access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Extract targetUrl from query or raw URL
  let targetUrl = req.query?.url;
  if (!targetUrl && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      targetUrl = parsed.searchParams.get('url');
    } catch (e) {}
  }

  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target url query parameter' });
  }

  try {
    const targetUrlObj = new URL(targetUrl);
    const targetOrigin = targetUrlObj.origin;
    const referer = req.query?.referer || `${targetOrigin}/`;

    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': referer,
        'Origin': targetOrigin,
        'Accept': '*/*'
      },
      redirect: 'follow'
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      return res.status(upstreamRes.status).json({
        error: `Upstream playlist error (${upstreamRes.status})`,
        details: errText || upstreamRes.statusText
      });
    }

    const playlistText = await upstreamRes.text();
    // Use the final redirected URL (if redirected) so relative segments resolve correctly
    const finalBaseUrl = upstreamRes.url || targetUrl;
    const rewritten = rewriteM3u8Content(playlistText, finalBaseUrl);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.status(200).send(rewritten);
  } catch (err) {
    return res.status(502).json({ error: `Proxy playlist failed: ${err.message}` });
  }
}
