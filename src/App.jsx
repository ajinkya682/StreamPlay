import React, { useRef } from 'react';
import { UrlInput } from './components/UrlInput';
import { VideoPlayer } from './components/VideoPlayer';
import { RecorderControls } from './components/RecorderControls';
import { useHlsPlayer } from './hooks/useHlsPlayer';

export function App() {
  const videoRef = useRef(null);
  const {
    status,
    error,
    isLive,
    duration,
    currentTime,
    seekableRange,
    canSeek,
    currentUrl,
    loadStream,
    stopStream,
    skip,
    jumpToLiveEdge
  } = useHlsPlayer(videoRef);

  // Status badge display logic
  const getStatusBadge = () => {
    switch (status) {
      case 'loading':
        return (
          <span className="header-status-badge status-loading">
            <span className="status-dot" />
            Loading
          </span>
        );
      case 'playing':
        if (isLive) {
          return (
            <span className="header-status-badge status-live">
              <span className="status-dot" />
              Live
            </span>
          );
        }
        return (
          <span className="header-status-badge status-playing">
            <span className="status-dot" />
            Playing
          </span>
        );
      case 'paused':
        return (
          <span className="header-status-badge status-paused">
            <span className="status-dot" />
            Paused
          </span>
        );
      case 'error':
        return (
          <span className="header-status-badge status-error">
            <span className="status-dot" />
            Error
          </span>
        );
      case 'ready':
      default:
        return (
          <span className="header-status-badge status-ready">
            <span className="status-dot" />
            Ready
          </span>
        );
    }
  };

  return (
    <div className="app-container">
      {/* Header */}
      <header className="app-header">
        <div className="brand">
          <div className="brand-icon">
            <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          </div>
          <div>
            <h1 className="brand-title">StreamPlay</h1>
            <p className="brand-subtitle">Simple HLS Video Player</p>
          </div>
        </div>
        <div>{getStatusBadge()}</div>
      </header>

      {/* URL Input Section */}
      <main style={{ display: 'flex', flexDirection: 'column', gap: '18px' }}>
        <UrlInput
          currentUrl={currentUrl}
          onPlay={loadStream}
          onStop={stopStream}
          isPlaying={status === 'playing'}
          isLoading={status === 'loading'}
        />

        {/* Central Video Player */}
        <VideoPlayer
          videoRef={videoRef}
          status={status}
          error={error}
          isLive={isLive}
          duration={duration}
          currentTime={currentTime}
          seekableRange={seekableRange}
          canSeek={canSeek}
          onSkip={skip}
          onJumpToLive={jumpToLiveEdge}
          currentUrl={currentUrl}
        />

        {/* Video Recording Controls */}
        <RecorderControls
          videoRef={videoRef}
          currentUrl={currentUrl}
          isPlaying={status === 'playing'}
        />

        {/* Daily Live Link Workflow Guide */}
        <section className="guide-card">
          <h2 className="guide-title">Daily Live Link Workflow</h2>
          <div className="guide-steps">
            <div className="guide-step">
              <div className="guide-step-num">Step 1</div>
              <div>Copy today’s <code>.m3u8</code> stream link from your authorized class player or browser DevTools.</div>
            </div>
            <div className="guide-step">
              <div className="guide-step-num">Step 2</div>
              <div>Paste the link into the URL field above and hit <strong>Play</strong> (or press Enter).</div>
            </div>
            <div className="guide-step">
              <div className="guide-step-num">Step 3</div>
              <div>Watch with full controls. When tomorrow brings a new link, paste it directly without restarting the app!</div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

export default App;
