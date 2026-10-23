import React, { useRef } from 'react';

function formatTime(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '00:00';
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  if (hrs > 0) {
    return `${hrs}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export function VideoPlayer({
  videoRef,
  status,
  error,
  isLive,
  duration,
  currentTime,
  canSeek,
  seekableRange,
  onSkip,
  onJumpToLive,
  currentUrl
}) {
  const containerRef = useRef(null);

  const toggleFullscreen = () => {
    const video = videoRef.current;
    if (!video) return;

    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    } else if (containerRef.current?.requestFullscreen) {
      containerRef.current.requestFullscreen().catch(() => {
        // fallback to webkit video fullscreen on iOS / Safari
        if (video.webkitEnterFullscreen) {
          video.webkitEnterFullscreen();
        }
      });
    } else if (video.webkitEnterFullscreen) {
      video.webkitEnterFullscreen();
    }
  };

  const handlePlayPause = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => {});
    } else {
      video.pause();
    }
  };

  const isLiveEdge = isLive && seekableRange && (seekableRange.end - currentTime < 5);

  return (
    <div className="player-container">
      <div className="video-card" ref={containerRef}>
        <video
          ref={videoRef}
          className="video-element"
          controls
          playsInline
          crossOrigin="anonymous"
        />

        {/* Loading Overlay */}
        {status === 'loading' && (
          <div className="player-overlay">
            <div className="loading-spinner" />
            <div style={{ fontSize: '0.9375rem', fontWeight: 500 }}>
              Connecting to HLS stream...
            </div>
            <div style={{ fontSize: '0.8125rem', color: '#94a3b8', marginTop: 4 }}>
              Loading playlist and buffering initial segments
            </div>
          </div>
        )}

        {/* Error Overlay */}
        {status === 'error' && error && (
          <div className="player-overlay">
            <div className="error-banner">
              <div className="error-banner-header">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
                </svg>
                {error.title}
              </div>
              <div className="error-banner-message">{error.message}</div>
              {error.help && <div className="error-banner-help">{error.help}</div>}
            </div>
          </div>
        )}

        {/* Empty / Ready State when no URL is loaded */}
        {status === 'ready' && !currentUrl && (
          <div className="player-overlay" style={{ background: 'rgba(15, 23, 42, 0.95)' }}>
            <div className="empty-state">
              <div className="empty-state-icon">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-8 12.5v-9l6 4.5-6 4.5z"/>
                </svg>
              </div>
              <div style={{ fontWeight: 600, color: '#f8fafc', fontSize: '1rem' }}>
                No Video Loaded
              </div>
              <div className="empty-state-text">
                Paste an HLS stream URL (ending in <code>.m3u8</code>) above and press <strong>Play</strong>.
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Quick Playback Bar */}
      <div className="quick-controls">
        <div className="controls-group">
          <button
            type="button"
            className="control-btn"
            onClick={() => onSkip(-10)}
            disabled={!canSeek || status === 'loading' || status === 'error' || status === 'ready'}
            title={canSeek ? "Jump backward 10 seconds" : "Seeking not supported for this stream"}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M11 18V6l-8.5 6 8.5 6zm.5-6l8.5 6V6l-8.5 6z" />
            </svg>
            -10s
          </button>

          <button
            type="button"
            className="control-btn"
            onClick={handlePlayPause}
            disabled={status === 'loading' || status === 'error' || status === 'ready'}
            title={status === 'playing' ? "Pause" : "Play"}
          >
            {status === 'playing' ? (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M6 19h4V5H6v14zm8-14v14h4V5h-4z" />
                </svg>
                Pause
              </>
            ) : (
              <>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M8 5v14l11-7z" />
                </svg>
                Play
              </>
            )}
          </button>

          <button
            type="button"
            className="control-btn"
            onClick={() => onSkip(10)}
            disabled={!canSeek || status === 'loading' || status === 'error' || status === 'ready'}
            title={canSeek ? "Jump forward 10 seconds" : "Seeking not supported for this stream"}
          >
            +10s
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M4 18l8.5-6L4 6v12zm9-12v12l8.5-6L13 6z" />
            </svg>
          </button>
        </div>

        <div className="controls-group">
          {/* Live Stream Indicator & Edge Sync Button */}
          {isLive ? (
            <button
              type="button"
              className={`live-badge-button ${isLiveEdge ? 'at-live-edge' : ''}`}
              onClick={onJumpToLive}
              title="Click to jump to live edge"
            >
              <span className="status-dot" style={{ background: 'currentColor' }} />
              LIVE
            </button>
          ) : null}

          {/* Time Display */}
          <div className="time-display">
            <span className="time-current">{formatTime(currentTime)}</span>
            {duration > 0 ? (
              <span> / {formatTime(duration)}</span>
            ) : isLive ? (
              <span style={{ color: 'var(--text-subtle)' }}> (Live stream)</span>
            ) : null}
          </div>

          {/* Fullscreen Button */}
          <button
            type="button"
            className="control-btn"
            onClick={toggleFullscreen}
            title="Toggle Fullscreen"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M7 14H5v5h5v-2H7v-3zm-2-4h2V7h3V5H5v5zm12 7h-3v2h5v-5h-2v3zM14 5v2h3v3h2V5h-5z" />
            </svg>
            Fullscreen
          </button>
        </div>
      </div>
    </div>
  );
}
