/**
 * StreamPlay HLS Rewriter Utility
 * Rewrites .m3u8 playlists so all nested playlists, chunks, encryption keys,
 * and media segments are routed through StreamPlay's proxy to bypass CORS,
 * token restrictions, and mixed-content blocking.
 */

export function rewriteM3u8Content(content, baseUrl) {
  let parentUrlObj;
  try {
    parentUrlObj = new URL(baseUrl);
  } catch (e) {
    parentUrlObj = { search: '', origin: '', pathname: '' };
  }

  const lines = content.split('\n');
  let isVariantNext = false;

  const rewritten = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    // Check for HLS variant stream tags (#EXT-X-STREAM-INF / #EXT-X-I-FRAME-STREAM-INF)
    // The line following these tags is always a sub-playlist URL
    if (trimmed.startsWith('#EXT-X-STREAM-INF') || trimmed.startsWith('#EXT-X-I-FRAME-STREAM-INF')) {
      isVariantNext = true;
    }

    // Process tags with URI="..." (e.g. #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA)
    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (match, uri) => {
        try {
          const abs = new URL(uri, baseUrl);
          // Preserve authentication tokens / query parameters if segment has none
          if (!abs.search && parentUrlObj.search) {
            abs.search = parentUrlObj.search;
          }
          const pathname = abs.pathname.toLowerCase();
          const proxyPath = pathname.endsWith('.m3u8') ? '/api/proxy/playlist' : '/api/proxy/segment';
          return `URI="${proxyPath}?url=${encodeURIComponent(abs.toString())}"`;
        } catch (e) {
          return match;
        }
      });
    }

    // Process sub-playlist URL or media segment URL line
    try {
      const abs = new URL(trimmed, baseUrl);
      if (!abs.search && parentUrlObj.search) {
        abs.search = parentUrlObj.search;
      }

      if (isVariantNext) {
        isVariantNext = false;
        return `/api/proxy/playlist?url=${encodeURIComponent(abs.toString())}`;
      }

      const pathname = abs.pathname.toLowerCase();
      if (pathname.endsWith('.m3u8')) {
        return `/api/proxy/playlist?url=${encodeURIComponent(abs.toString())}`;
      }
      return `/api/proxy/segment?url=${encodeURIComponent(abs.toString())}`;
    } catch (e) {
      isVariantNext = false;
      return line;
    }
  });

  return rewritten.join('\n');
}
