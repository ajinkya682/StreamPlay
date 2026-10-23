import React, { useState, useEffect } from 'react';

const STORAGE_KEY = 'streamplay_last_url';
const REMEMBER_KEY = 'streamplay_remember_pref';

// Curated public test streams for quick validation
const SAMPLE_STREAMS = [
  {
    name: 'Select a sample test stream...',
    url: ''
  },
  {
    name: 'Tears of Steel (VOD / Seekable)',
    url: 'https://test-streams.mux.dev/tos_straight/master.m3u8'
  },
  {
    name: 'Big Buck Bunny (VOD / Multi-bitrate)',
    url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8'
  },
  {
    name: 'Apple BipBop (VOD / Basic)',
    url: 'https://devstreaming-cdn.apple.com/videos/streaming/examples/bipbop_4x3/bipbop_4x3.m3u8'
  },
  {
    name: 'Akamai Live Test (Live Stream)',
    url: 'https://cph-p2p-msl.akamaized.net/hls/live/2000341/test/master.m3u8'
  }
];

export function UrlInput({ currentUrl, onPlay, onStop, isPlaying, isLoading }) {
  const [url, setUrl] = useState('');
  const [rememberUrl, setRememberUrl] = useState(true);
  const [useProxy, setUseProxy] = useState(true);
  const [validationError, setValidationError] = useState('');
  const [hasSavedUrl, setHasSavedUrl] = useState(false);

  // Raw M3U8 modal state
  const [showRawModal, setShowRawModal] = useState(false);
  const [rawM3u8Text, setRawM3u8Text] = useState('');
  const [rawBaseUrl, setRawBaseUrl] = useState('');
  const [rawLoading, setRawLoading] = useState(false);
  const [rawError, setRawError] = useState('');

  // Load saved URL and preference on initial mount
  useEffect(() => {
    try {
      const savedPref = localStorage.getItem(REMEMBER_KEY);
      if (savedPref !== null) {
        setRememberUrl(savedPref === 'true');
      }

      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        setUrl(saved);
        setHasSavedUrl(true);
      }
    } catch (e) {
      // localStorage might be unavailable or disabled
    }
  }, []);

  const handlePlaySubmit = (e) => {
    if (e) e.preventDefault();
    setValidationError('');

    const trimmed = url.trim();
    if (!trimmed) {
      setValidationError('Please enter a video URL.');
      return;
    }

    if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://') && !trimmed.startsWith('/api/')) {
      setValidationError('URL must start with http:// or https://');
      return;
    }

    // Save URL if preference is enabled
    if (rememberUrl) {
      try {
        localStorage.setItem(STORAGE_KEY, trimmed);
        setHasSavedUrl(true);
      } catch (e) {}
    }

    onPlay(trimmed, useProxy);
  };

  const handleClear = () => {
    setUrl('');
    setValidationError('');
  };

  const handleClearSaved = () => {
    try {
      localStorage.removeItem(STORAGE_KEY);
      setHasSavedUrl(false);
    } catch (e) {}
  };

  const handleToggleRemember = (e) => {
    const val = e.target.checked;
    setRememberUrl(val);
    try {
      localStorage.setItem(REMEMBER_KEY, String(val));
      if (!val) {
        localStorage.removeItem(STORAGE_KEY);
        setHasSavedUrl(false);
      } else if (url.trim()) {
        localStorage.setItem(STORAGE_KEY, url.trim());
        setHasSavedUrl(true);
      }
    } catch (e) {}
  };

  const handleSelectSample = (e) => {
    const selected = e.target.value;
    if (selected) {
      setUrl(selected);
      setValidationError('');
    }
  };

  const handlePasteModalSubmit = async (e) => {
    e.preventDefault();
    setRawError('');

    if (!rawM3u8Text.trim()) {
      setRawError('Please paste your #EXTM3U playlist content.');
      return;
    }
    if (!rawBaseUrl.trim()) {
      setRawError('Please provide the original URL where this playlist was fetched from.');
      return;
    }

    setRawLoading(true);
    try {
      const res = await fetch('/api/proxy/paste-playlist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content: rawM3u8Text.trim(),
          baseUrl: rawBaseUrl.trim()
        })
      });

      const data = await res.json();
      if (!res.ok || !data.playlistUrl) {
        throw new Error(data.error || 'Failed to process custom playlist.');
      }

      setShowRawModal(false);
      setUrl(rawBaseUrl.trim());
      onPlay(data.playlistUrl, false);
    } catch (err) {
      setRawError(err.message);
    } finally {
      setRawLoading(false);
    }
  };

  return (
    <div className="input-card">
      <form onSubmit={handlePlaySubmit} className="input-row">
        <div className="input-wrapper">
          <input
            type="text"
            className="url-input"
            value={url}
            onChange={(e) => {
              setUrl(e.target.value);
              if (validationError) setValidationError('');
            }}
            placeholder="Paste your .m3u8 video URL here..."
            autoComplete="off"
            spellCheck="false"
          />
          {url && (
            <button
              type="button"
              className="clear-input-btn"
              onClick={handleClear}
              title="Clear input text"
            >
              ✕
            </button>
          )}
        </div>

        <button
          type="submit"
          className="btn btn-primary"
          disabled={isLoading || !url.trim()}
          title="Play Stream (Enter)"
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
            <path d="M8 5v14l11-7z" />
          </svg>
          {isLoading ? 'Connecting...' : 'Play'}
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={onStop}
          disabled={!currentUrl && !isPlaying && !isLoading}
          title="Stop Playback"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <rect x="6" y="6" width="12" height="12" rx="2" />
          </svg>
          Stop
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          onClick={() => {
            handleClear();
            onStop();
          }}
          title="Clear URL and reset player"
        >
          Clear
        </button>

        <button
          type="button"
          className="btn btn-secondary"
          style={{ background: 'rgba(56, 189, 248, 0.1)', color: '#38bdf8', borderColor: 'rgba(56, 189, 248, 0.3)' }}
          onClick={() => {
            setRawBaseUrl(url || '');
            setShowRawModal(true);
          }}
          title="Paste raw #EXTM3U response text directly if URL is protected"
        >
          📋 Paste M3U8 Text
        </button>
      </form>

      {validationError && (
        <div style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginTop: '-4px' }}>
          ⚠️ {validationError}
        </div>
      )}

      <div className="input-meta-row">
        <div style={{ display: 'flex', alignItems: 'center', gap: '16px' }}>
          <label className="remember-toggle">
            <input
              type="checkbox"
              checked={rememberUrl}
              onChange={handleToggleRemember}
            />
            Remember last URL
          </label>

          <label className="remember-toggle" title="Routes media segments through local proxy to bypass browser CORS blocking">
            <input
              type="checkbox"
              checked={useProxy}
              onChange={(e) => setUseProxy(e.target.checked)}
            />
            <span style={{ color: useProxy ? '#38bdf8' : 'inherit', fontWeight: useProxy ? 500 : 400 }}>
              ⚡ Bypass CORS via Proxy
            </span>
          </label>
        </div>

        <div className="saved-actions">
          {hasSavedUrl && (
            <button
              type="button"
              className="text-btn"
              onClick={handleClearSaved}
              title="Remove stored URL from browser storage"
            >
              Clear Saved URL
            </button>
          )}

          <div className="samples-dropdown">
            <span style={{ fontSize: '0.75rem', color: 'var(--text-subtle)' }}>Samples:</span>
            <select
              className="sample-select"
              onChange={handleSelectSample}
              value=""
              title="Select a public test HLS stream"
            >
              {SAMPLE_STREAMS.map((s, idx) => (
                <option key={idx} value={s.url} disabled={!s.url}>
                  {s.name}
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Raw M3U8 Content Modal */}
      {showRawModal && (
        <div className="player-overlay" style={{ background: 'rgba(15, 23, 42, 0.85)', backdropFilter: 'blur(8px)', zIndex: 100, position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          <div style={{ background: '#1e293b', border: '1px solid #334155', borderRadius: '12px', padding: '24px', width: '90%', maxWidth: '640px', boxShadow: '0 20px 25px -5px rgba(0, 0, 0, 0.5)' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px' }}>
              <h3 style={{ margin: 0, fontSize: '1.125rem', color: '#f8fafc', fontWeight: 600 }}>
                📋 Paste Raw M3U8 Playlist Content
              </h3>
              <button
                type="button"
                className="clear-input-btn"
                onClick={() => setShowRawModal(false)}
                style={{ fontSize: '1.25rem' }}
              >
                ✕
              </button>
            </div>

            <p style={{ fontSize: '0.8125rem', color: '#94a3b8', margin: '0 0 16px 0', lineHeight: 1.5 }}>
              If your video portal restricts direct playlist requests, open browser <strong>DevTools → Network tab</strong>, copy the <code>#EXTM3U</code> response text, and paste it here with the original URL.
            </p>

            <form onSubmit={handlePasteModalSubmit} style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', color: '#cbd5e1', marginBottom: '6px', fontWeight: 500 }}>
                  Original Video URL (needed to resolve .ts chunks):
                </label>
                <input
                  type="text"
                  className="url-input"
                  style={{ width: '100%', boxSizing: 'border-box' }}
                  value={rawBaseUrl}
                  onChange={(e) => setRawBaseUrl(e.target.value)}
                  placeholder="https://transcoded-videos.classx.co.in/videos/.../master.m3u8?..."
                  required
                />
              </div>

              <div>
                <label style={{ display: 'block', fontSize: '0.8125rem', color: '#cbd5e1', marginBottom: '6px', fontWeight: 500 }}>
                  Raw M3U8 Text Content (starts with #EXTM3U):
                </label>
                <textarea
                  className="url-input"
                  style={{ width: '100%', height: '140px', boxSizing: 'border-box', fontFamily: 'monospace', fontSize: '0.75rem', resize: 'vertical' }}
                  value={rawM3u8Text}
                  onChange={(e) => setRawM3u8Text(e.target.value)}
                  placeholder={'#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:12\n#EXTINF:11.500000,\nmaster-4115149.7976618280.ts?...'}
                  required
                />
              </div>

              {rawError && (
                <div style={{ color: '#ef4444', fontSize: '0.8125rem' }}>
                  ⚠️ {rawError}
                </div>
              )}

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginTop: '8px' }}>
                <button
                  type="button"
                  className="btn btn-secondary"
                  onClick={() => setShowRawModal(false)}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="btn btn-primary"
                  disabled={rawLoading || !rawM3u8Text.trim()}
                >
                  {rawLoading ? 'Processing...' : '▶ Load & Play Stream'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
