export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  let targetUrl = req.query?.url;
  if (!targetUrl && req.url) {
    try {
      const parsed = new URL(req.url, 'http://localhost');
      targetUrl = parsed.searchParams.get('url');
    } catch (e) {}
  }

  if (!targetUrl) {
    return res.status(400).send('Missing target url query parameter');
  }

  try {
    const targetUrlObj = new URL(targetUrl);
    const targetOrigin = targetUrlObj.origin;
    const referer = req.query?.referer || `${targetOrigin}/`;

    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': referer,
      'Origin': targetOrigin,
      'Accept': '*/*'
    };

    if (req.headers?.range) {
      headers['Range'] = req.headers.range;
    }

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
