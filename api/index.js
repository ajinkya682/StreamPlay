// Suppress internal runtime deprecation warnings so Vercel doesn't mark stderr as an Error
if (typeof process !== 'undefined') {
  process.noDeprecation = true;
}

import { rewriteM3u8Content } from '../lib/rewriter.js';
import { saveCustomPlaylist, getCustomPlaylist } from '../lib/store.js';

function buildUpstreamHeaders(targetUrl, customReferer, reqHeaders) {
  let targetUrlObj;
  try {
    targetUrlObj = new URL(targetUrl);
  } catch (e) {
    targetUrlObj = { origin: '', hostname: '', pathname: '' };
  }

  const headers = {
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': '*/*'
  };

  // Extract tenant name from path like /videos/ignite247-data/...
  const match = (targetUrlObj.pathname || '').match(/\/videos\/([a-zA-Z0-9_-]+)-data\//i);
  const tenant = match ? match[1] : '';

  // If URL belongs to ClassX or related student portals, use the exact tenant portal Referer & Origin
  if (targetUrlObj.hostname && (targetUrlObj.hostname.includes('classx.co.in') || targetUrlObj.hostname.includes('classx'))) {
    if (customReferer) {
      headers['Referer'] = customReferer;
      try { headers['Origin'] = new URL(customReferer).origin; } catch (e) {}
    } else if (tenant) {
      headers['Referer'] = `https://${tenant}.classx.co.in/`;
      headers['Origin'] = `https://${tenant}.classx.co.in`;
    } else {
      headers['Referer'] = 'https://classx.co.in/';
      headers['Origin'] = 'https://classx.co.in';
    }
  } else if (customReferer) {
    headers['Referer'] = customReferer;
  }

  if (reqHeaders?.['range']) {
    headers['Range'] = reqHeaders['range'];
  }
  if (reqHeaders?.['authorization']) {
    headers['Authorization'] = reqHeaders['authorization'];
  }
  if (reqHeaders?.['cookie']) {
    headers['Cookie'] = reqHeaders['cookie'];
  }

  return headers;
}

async function tryResolveM3u8FromSegment(segmentUrl, headers) {
  let urlObj;
  try {
    urlObj = new URL(segmentUrl);
  } catch (e) {
    return null;
  }

  const pathname = urlObj.pathname;
  if (!pathname.toLowerCase().endsWith('.ts')) {
    return null;
  }

  const candidates = [];
  const sameDirMaster = pathname.replace(/\/[^/]+\.ts$/i, '/master.m3u8');
  candidates.push(new URL(sameDirMaster + urlObj.search, urlObj.origin).toString());

  const parentDirMaster = pathname.replace(/\/(?:[0-9]+p|hls|video|stream)\/[^/]+\.ts$/i, '/master.m3u8');
  if (parentDirMaster !== sameDirMaster) {
    candidates.push(new URL(parentDirMaster + urlObj.search, urlObj.origin).toString());
  }

  const sameDirIndex = pathname.replace(/\/[^/]+\.ts$/i, '/index.m3u8');
  candidates.push(new URL(sameDirIndex + urlObj.search, urlObj.origin).toString());

  const parentDirIndex = pathname.replace(/\/(?:[0-9]+p|hls|video|stream)\/[^/]+\.ts$/i, '/index.m3u8');
  if (parentDirIndex !== sameDirIndex) {
    candidates.push(new URL(parentDirIndex + urlObj.search, urlObj.origin).toString());
  }

  for (const cand of candidates) {
    try {
      const testRes = await fetch(cand, {
        method: 'GET',
        headers,
        signal: AbortSignal.timeout(3000)
      });
      if (testRes.ok) {
        const text = await testRes.text();
        if (text.includes('#EXTM3U')) {
          return { resolvedUrl: cand, content: text };
        }
      }
    } catch (e) {
      // Ignore
    }
  }

  return null;
}

export default async function handler(req, res) {
  // Global CORS headers for cross-origin player access
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // Parse incoming request URL and query
  const host = req.headers.host || 'localhost';
  let pathname = '';
  let searchParams = new URLSearchParams();

  try {
    const parsed = new URL(req.url, `http://${host}`);
    pathname = parsed.pathname;
    searchParams = parsed.searchParams;
  } catch (e) {
    pathname = req.url || '';
  }

  // Normalise path (handle both /api/... and direct routing)
  const cleanPath = pathname.replace(/\/+$/, '') || '/';

  // 1. ROUTE: /api/proxy/playlist
  if (cleanPath === '/api/proxy/playlist' || cleanPath === '/proxy/playlist') {
    let targetUrl = searchParams.get('url') || req.query?.url;
    if (!targetUrl) {
      return res.status(400).json({ error: 'Missing target url query parameter' });
    }

    const isSegment = /\.ts(\?.*)?$/i.test(targetUrl);
    const customReferer = searchParams.get('referer') || req.query?.referer;
    const headers = buildUpstreamHeaders(targetUrl, customReferer, req.headers);

    // If user passed a .ts file, attempt to automatically resolve to .m3u8
    if (isSegment) {
      const resolved = await tryResolveM3u8FromSegment(targetUrl, headers);
      if (resolved) {
        const rewritten = rewriteM3u8Content(resolved.content, resolved.resolvedUrl);
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
        return res.status(200).send(rewritten);
      }
    }

    try {
      const upstreamRes = await fetch(targetUrl, {
        method: 'GET',
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(9000)
      });

      if (!upstreamRes.ok) {
        const errText = await upstreamRes.text().catch(() => '');
        let errorTitle = `Upstream playlist error (${upstreamRes.status})`;
        let help = '';

        if (isSegment) {
          errorTitle = 'Video Segment (.ts) Entered';
          help = 'You provided a temporary .ts video chunk instead of an .m3u8 playlist. HLS requires the master playlist. In your browser DevTools (Network tab), filter by "m3u8" to copy the master.m3u8 link.';
        } else if (errText.includes('Google-Edge-Cache') || upstreamRes.status === 404) {
          help = 'The stream token or playlist was not found on Google Edge Cache. Refresh your student portal to generate a fresh link.';
        } else if (upstreamRes.status === 403) {
          help = 'Access forbidden. The stream token has expired or is unauthorized.';
        }

        return res.status(upstreamRes.status).json({
          error: errorTitle,
          details: errText || upstreamRes.statusText,
          isSegment,
          help
        });
      }

      const playlistText = await upstreamRes.text();

      if (!playlistText.includes('#EXTM3U') && isSegment) {
        return res.status(400).json({
          error: 'Video Segment (.ts) Entered',
          details: 'The URL returned raw binary video instead of an M3U8 playlist manifest.',
          isSegment: true,
          help: 'You copied a .ts video segment chunk. HLS players need the master .m3u8 playlist file. In Chrome DevTools > Network tab, filter for "m3u8" and copy that link.'
        });
      }

      const finalBaseUrl = upstreamRes.url || targetUrl;
      const rewritten = rewriteM3u8Content(playlistText, finalBaseUrl);

      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      return res.status(200).send(rewritten);
    } catch (err) {
      const isTimeout = err.name === 'TimeoutError' || err.message?.includes('timeout');
      return res.status(502).json({
        error: isTimeout ? 'Stream Connection Timed Out' : `Proxy playlist failed: ${err.message}`,
        details: err.message,
        isSegment,
        help: isSegment
          ? 'You entered a .ts video segment. HLS requires the master.m3u8 playlist file.'
          : 'The streaming server did not respond within 9 seconds. Verify the stream is online or check your token.'
      });
    }
  }

  // 2. ROUTE: /api/proxy/segment
  if (cleanPath === '/api/proxy/segment' || cleanPath === '/proxy/segment') {
    let targetUrl = searchParams.get('url') || req.query?.url;
    if (!targetUrl) {
      return res.status(400).send('Missing target url query parameter');
    }

    try {
      const customReferer = searchParams.get('referer') || req.query?.referer;
      const headers = buildUpstreamHeaders(targetUrl, customReferer, req.headers);

      const upstreamRes = await fetch(targetUrl, {
        method: req.method === 'HEAD' ? 'HEAD' : 'GET',
        headers,
        redirect: 'follow'
      });

      res.status(upstreamRes.status);
      const contentType = upstreamRes.headers.get('content-type') || 'video/MP2T';
      res.setHeader('Content-Type', contentType);

      const contentLength = upstreamRes.headers.get('content-length');
      if (contentLength) res.setHeader('Content-Length', contentLength);

      const contentRange = upstreamRes.headers.get('content-range');
      if (contentRange) res.setHeader('Content-Range', contentRange);

      const acceptRanges = upstreamRes.headers.get('accept-ranges') || 'bytes';
      res.setHeader('Accept-Ranges', acceptRanges);

      if (req.method === 'HEAD') {
        return res.end();
      }

      const arrayBuffer = await upstreamRes.arrayBuffer();
      const buffer = Buffer.from(arrayBuffer);
      return res.end(buffer);
    } catch (err) {
      if (!res.headersSent) {
        return res.status(502).send(`Proxy segment failed: ${err.message}`);
      }
    }
  }

  // 3. ROUTE: /api/proxy/health
  if (cleanPath === '/api/proxy/health' || cleanPath === '/proxy/health') {
    return res.status(200).json({ ok: true, online: true, platform: 'vercel' });
  }

  // 4. ROUTE: /api/proxy/paste-playlist
  if (cleanPath === '/api/proxy/paste-playlist' || cleanPath === '/proxy/paste-playlist') {
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

  // 5. ROUTE: /api/proxy/custom/:id or /api/proxy/custom?id=...
  if (cleanPath.startsWith('/api/proxy/custom') || cleanPath.startsWith('/proxy/custom')) {
    let id = searchParams.get('id') || req.query?.id || '';
    if (!id) {
      const match = cleanPath.match(/\/custom\/(.+)$/);
      if (match) id = match[1];
    }
    id = String(id).replace(/\.m3u8$/i, '');

    const content = getCustomPlaylist(id);
    if (!content) {
      return res.status(404).send('#EXTM3U\n# Error: Custom playlist expired or not found');
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    return res.status(200).send(content);
  }

  // 6. ROUTE: /api/record/status
  if (cleanPath === '/api/record/status' || cleanPath === '/record/status') {
    return res.status(200).json({
      isRecording: false,
      filename: null,
      startTime: null,
      durationSeconds: 0,
      sizeBytes: 0,
      error: null,
      ffmpegAvailable: false,
      isCloud: true
    });
  }

  // 7. ROUTE: /api/record/list
  if (cleanPath === '/api/record/list' || cleanPath === '/record/list') {
    return res.status(200).json({ recordings: [] });
  }

  // 8. ROUTE: /api/record/save-browser
  if (cleanPath === '/api/record/save-browser' || cleanPath === '/record/save-browser') {
    const ext = searchParams.get('ext') || req.query?.ext || 'mp4';
    const now = new Date();
    const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
    return res.status(200).json({
      success: true,
      cloud: true,
      filename: `StreamPlay_Recording_${dateStr}.${ext}`,
      message: 'Processed via client download'
    });
  }

  // 9. All other /api/record/* endpoints
  if (cleanPath.startsWith('/api/record') || cleanPath.startsWith('/record')) {
    return res.status(200).json({
      success: true,
      message: 'Cloud mode active. Browser recording saves directly to your computer.'
    });
  }

  return res.status(404).json({ error: `Not found: ${cleanPath}` });
}
