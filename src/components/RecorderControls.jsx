import React, { useState, useEffect, useRef } from 'react';

function formatDuration(seconds) {
  if (!seconds || seconds < 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (!bytes || bytes === 0) return '0 MB';
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

export function RecorderControls({ videoRef, currentUrl, isPlaying }) {
  const [recordMode, setRecordMode] = useState('browser'); // 'browser' | 'backend'
  const [isRecording, setIsRecording] = useState(false);
  const [recordDuration, setRecordDuration] = useState(0);
  const [recordedBytes, setRecordedBytes] = useState(0);
  const [savedRecordings, setSavedRecordings] = useState([]);
  const [statusMessage, setStatusMessage] = useState('');
  const [lastSavedFile, setLastSavedFile] = useState(null); // { filename, downloadUrl, downloadsPath }
  const [ffmpegAvailable, setFfmpegAvailable] = useState(true);

  // In-Browser MediaRecorder refs
  const mediaRecorderRef = useRef(null);
  const chunksRef = useRef([]);
  const timerIntervalRef = useRef(null);

  // Fetch backend recording status and list on mount & periodically
  useEffect(() => {
    fetchSavedRecordings();
    checkBackendStatus();

    const interval = setInterval(() => {
      if (recordMode === 'backend') {
        checkBackendStatus();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [recordMode]);

  const checkBackendStatus = async () => {
    try {
      const res = await fetch('/api/record/status');
      if (res.ok) {
        const data = await res.json();
        setFfmpegAvailable(data.ffmpegAvailable);
        if (recordMode === 'backend') {
          setIsRecording(data.isRecording);
          if (data.isRecording) {
            setRecordDuration(data.durationSeconds || 0);
            setRecordedBytes(data.sizeBytes || 0);
          }
        }
      }
    } catch (e) {
      // Backend might be offline
    }
  };

  const fetchSavedRecordings = async () => {
    try {
      const res = await fetch('/api/record/list');
      if (res.ok) {
        const data = await res.json();
        setSavedRecordings(data.recordings || []);
      }
    } catch (e) {}
  };

  // Reveal and highlight the exact file in macOS Finder
  // Reveal and highlight the exact file in macOS Finder (or notify about Downloads in cloud mode)
  const revealInFinder = async (filename) => {
    if (!ffmpegAvailable) {
      setStatusMessage(`📂 "${filename}" is saved in your browser's default Downloads folder.`);
      return;
    }
    try {
      await fetch('/api/record/reveal', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename })
      });
      setStatusMessage(`📂 Highlighted "${filename}" in your Mac Downloads folder!`);
    } catch (e) {
      setStatusMessage('Check your Downloads folder: ~/Downloads');
    }
  };

  // Open the general Downloads folder
  const openDownloadsFolder = async () => {
    if (!ffmpegAvailable) {
      setStatusMessage('📂 Recorded videos are saved directly into your computer’s default Downloads folder.');
      return;
    }
    try {
      await fetch('/api/record/open-downloads', { method: 'POST' });
      setStatusMessage('📂 Opened your Mac Downloads folder in Finder');
    } catch (e) {
      setStatusMessage('Check your Downloads folder: ~/Downloads');
    }
  };

  // --- In-Browser Clean Video Capture (Pure video track, zero cursor/screen capture) ---
  const startBrowserRecording = () => {
    const video = videoRef.current;
    if (!video) {
      setStatusMessage('Error: Video player is not ready.');
      return;
    }

    if (video.paused && !isPlaying) {
      setStatusMessage('Please press Play on the video before recording.');
      return;
    }

    try {
      const stream = video.captureStream ? video.captureStream(30) : video.mozCaptureStream?.(30);

      if (!stream) {
        setStatusMessage('Browser video capture not supported. Try the FFmpeg mode.');
        return;
      }

      let mimeType = 'video/webm';
      let fileExt = 'webm';

      if (typeof MediaRecorder !== 'undefined') {
        if (MediaRecorder.isTypeSupported('video/mp4;codecs=avc1,mp4a.40.2')) {
          mimeType = 'video/mp4;codecs=avc1,mp4a.40.2';
          fileExt = 'mp4';
        } else if (MediaRecorder.isTypeSupported('video/mp4')) {
          mimeType = 'video/mp4';
          fileExt = 'mp4';
        } else if (MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus')) {
          mimeType = 'video/webm;codecs=vp9,opus';
          fileExt = 'webm';
        }
      }

      const recorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 6000000 // 6 Mbps high quality
      });

      mediaRecorderRef.current = recorder;
      chunksRef.current = [];
      setRecordedBytes(0);
      setRecordDuration(0);
      setLastSavedFile(null);

      recorder.ondataavailable = (event) => {
        if (event.data && event.data.size > 0) {
          chunksRef.current.push(event.data);
          setRecordedBytes((prev) => prev + event.data.size);
        }
      };

      recorder.onstop = async () => {
        clearInterval(timerIntervalRef.current);
        const blob = new Blob(chunksRef.current, { type: mimeType });
        const now = new Date();
        const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
        const fallbackName = `StreamPlay_Recording_${dateStr}.${fileExt}`;

        // In cloud / online mode, trigger instant direct download to user's browser
        if (!ffmpegAvailable) {
          const localUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = localUrl;
          a.download = fallbackName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          setLastSavedFile({
            filename: fallbackName,
            downloadUrl: localUrl
          });
          setSavedRecordings((prev) => [
            {
              filename: fallbackName,
              sizeBytes: blob.size,
              folder: 'Downloads',
              modifiedAt: new Date().toISOString(),
              localBlobUrl: localUrl
            },
            ...prev
          ]);
          setStatusMessage(`✅ Saved ${fallbackName} (${formatBytes(blob.size)}) directly to your Downloads folder!`);
          setIsRecording(false);
          return;
        }

        setStatusMessage('⏳ Converting and saving MP4 to your Mac Downloads folder...');

        try {
          const res = await fetch(`/api/record/save-browser?ext=${fileExt}`, {
            method: 'POST',
            body: blob
          });

          if (res.ok) {
            const data = await res.json();
            const savedName = data.filename || fallbackName;
            setLastSavedFile({
              filename: savedName,
              downloadUrl: `/api/record/download/${savedName}`
            });
            setStatusMessage(`✅ Saved ${savedName} (${formatBytes(blob.size)}) directly in your Mac Downloads folder!`);
            fetchSavedRecordings();
          } else {
            throw new Error('Server returned error');
          }
        } catch (e) {
          // Fallback to local blob download
          const localUrl = URL.createObjectURL(blob);
          const a = document.createElement('a');
          a.href = localUrl;
          a.download = fallbackName;
          document.body.appendChild(a);
          a.click();
          document.body.removeChild(a);

          setLastSavedFile({
            filename: fallbackName,
            downloadUrl: localUrl
          });
          setSavedRecordings((prev) => [
            {
              filename: fallbackName,
              sizeBytes: blob.size,
              folder: 'Downloads',
              modifiedAt: new Date().toISOString(),
              localBlobUrl: localUrl
            },
            ...prev
          ]);
          setStatusMessage(`✅ Recording complete (${formatBytes(blob.size)}). Saved to your Downloads folder.`);
        }

        setIsRecording(false);
      };

      recorder.start(1000);
      setIsRecording(true);
      setStatusMessage('🔴 Recording video stream. You can switch tabs or minimize; your cursor and other windows are NOT captured!');

      const startTime = Date.now();
      timerIntervalRef.current = setInterval(() => {
        setRecordDuration(Math.floor((Date.now() - startTime) / 1000));
      }, 1000);
    } catch (err) {
      setStatusMessage(`Recording failed: ${err.message}`);
    }
  };

  const stopBrowserRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
  };

  // --- Backend FFmpeg Stream Recording directly into Downloads ---
  const startBackendRecording = async () => {
    if (!currentUrl) {
      setStatusMessage('Please load and play an HLS stream URL first.');
      return;
    }

    if (!ffmpegAvailable) {
      setStatusMessage('Notice: FFmpeg local mode requires running StreamPlay on Mac/PC. Switched to In-Browser clean video capture.');
      setRecordMode('browser');
      startBrowserRecording();
      return;
    }

    try {
      setStatusMessage('Starting FFmpeg recording on your Mac...');
      const res = await fetch('/api/record/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          url: currentUrl,
          filename: `StreamPlay_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}`
        })
      });

      const data = await res.json();
      if (res.ok) {
        setIsRecording(true);
        setLastSavedFile(null);
        setStatusMessage(`🔴 FFmpeg recording started: ${data.filename}`);
      } else {
        setStatusMessage(`Error: ${data.error}`);
      }
    } catch (e) {
      setStatusMessage(`Failed to contact recording server: ${e.message}`);
    }
  };

  const stopBackendRecording = async () => {
    try {
      setStatusMessage('Finalizing MP4 file directly into Downloads...');
      const res = await fetch('/api/record/stop', { method: 'POST' });
      const data = await res.json();
      if (res.ok) {
        setIsRecording(false);
        const savedName = data.file.filename;
        setLastSavedFile({
          filename: savedName,
          downloadUrl: `/api/record/download/${savedName}`
        });
        setStatusMessage(`✅ Saved ${savedName} (${formatBytes(data.file.sizeBytes)}) directly into your Downloads folder!`);
        fetchSavedRecordings();
      } else {
        setStatusMessage(`Error stopping: ${data.error}`);
      }
    } catch (e) {
      setStatusMessage(`Error: ${e.message}`);
    }
  };

  const handleDeleteBackendRecording = async (filename) => {
    if (!confirm(`Delete ${filename}?`)) return;
    try {
      await fetch(`/api/record/${filename}`, { method: 'DELETE' });
      fetchSavedRecordings();
    } catch (e) {}
  };

  const toggleRecording = () => {
    if (isRecording) {
      if (recordMode === 'browser') {
        stopBrowserRecording();
      } else {
        stopBackendRecording();
      }
    } else {
      if (recordMode === 'browser') {
        startBrowserRecording();
      } else {
        startBackendRecording();
      }
    }
  };

  return (
    <div className="recorder-card">
      <div className="recorder-header">
        <div className="recorder-title-group">
          <div className="recorder-icon">
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8zm0-14c-3.31 0-6 2.69-6 6s2.69 6 6 6 6-2.69 6-6-2.69-6-6-6z" />
            </svg>
          </div>
          <div>
            <h3 className="recorder-title">High-Quality Video Recording</h3>
            <p className="recorder-subtitle">
              Saves straight to your <strong>Downloads</strong> folder — no cursor, no desktop, pure video.
            </p>
          </div>
        </div>

        {/* Mode Selector & Open Folder */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          {ffmpegAvailable ? (
            <button
              type="button"
              className="control-btn"
              onClick={openDownloadsFolder}
              title="Open your Mac's Downloads folder in Finder"
            >
              📂 Open Downloads Folder
            </button>
          ) : (
            <span
              style={{
                fontSize: '0.75rem',
                fontWeight: 600,
                padding: '4px 10px',
                borderRadius: '6px',
                background: 'rgba(56, 189, 248, 0.12)',
                color: '#38bdf8',
                border: '1px solid rgba(56, 189, 248, 0.25)',
                display: 'inline-flex',
                alignItems: 'center',
                gap: 4
              }}
            >
              ☁️ Cloud / Vercel Online
            </span>
          )}

          <div className="recorder-mode-tabs">
            <button
              type="button"
              className={`mode-tab-btn ${recordMode === 'browser' ? 'active' : ''}`}
              onClick={() => !isRecording && setRecordMode('browser')}
              disabled={isRecording}
              title="Records playing video in browser directly to your Downloads folder"
            >
              In-Browser Video Capture
            </button>
            <button
              type="button"
              className={`mode-tab-btn ${recordMode === 'backend' ? 'active' : ''}`}
              onClick={() => !isRecording && setRecordMode('backend')}
              disabled={isRecording || !ffmpegAvailable}
              title={ffmpegAvailable ? "Saves direct HLS stream to MP4 via local FFmpeg" : "FFmpeg mode is available when running locally on Mac/PC with local server"}
            >
              FFmpeg Direct MP4 {!ffmpegAvailable ? '(Local only)' : ''}
            </button>
          </div>
        </div>
      </div>

      {/* Main Action Bar */}
      <div className="recorder-action-bar">
        <button
          type="button"
          className={`btn ${isRecording ? 'btn-danger' : 'btn-primary'}`}
          onClick={toggleRecording}
          disabled={!currentUrl && !isPlaying && !isRecording}
          style={{ minWidth: 160 }}
        >
          {isRecording ? (
            <>
              <span className="recording-pulse-dot" />
              Stop Recording
            </>
          ) : (
            <>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="12" r="8" />
              </svg>
              Start Recording
            </>
          )}
        </button>

        {/* Live stats when recording */}
        {isRecording && (
          <div className="recording-live-stats">
            <span className="live-stat-badge">
              <span className="status-dot" style={{ background: '#ef4444', animation: 'pulse 1s infinite' }} />
              RECORDING
            </span>
            <span className="live-stat-text">
              ⏱ {formatDuration(recordDuration)}
            </span>
            <span className="live-stat-text">
              📦 {formatBytes(recordedBytes)}
            </span>
          </div>
        )}

        {/* Explanation text */}
        {!isRecording && !lastSavedFile && (
          <div className="recorder-mode-hint">
            {recordMode === 'browser' ? (
              <span>
                💡 <strong>Tab-safe:</strong> You can switch to other pages or work on something else. Only the playing video & audio will be saved to your <strong>Downloads</strong> folder as a playable .mp4.
              </span>
            ) : (
              <span>
                ⚡ <strong>Lossless FFmpeg:</strong> Copies raw video/audio segments directly to an MP4 file in your <strong>Downloads</strong> folder.
              </span>
            )}
          </div>
        )}
      </div>

      {/* Prominent Action Bar for the Last Saved Video */}
      {lastSavedFile && !isRecording && (
        <div style={{
          background: 'var(--success-light)',
          border: '1.5px solid var(--success)',
          borderRadius: 'var(--radius-md)',
          padding: '12px 16px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          flexWrap: 'wrap',
          gap: 12
        }}>
          <div>
            <div style={{ fontWeight: 600, color: 'var(--text-main)', fontSize: '0.875rem' }}>
              🎬 Video Ready: {lastSavedFile.filename}
            </div>
            <div style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', marginTop: 2 }}>
              {ffmpegAvailable ? (
                <>Saved in your Mac Downloads folder! Click <strong>Open in Finder</strong> to highlight it.</>
              ) : (
                <>Downloaded directly to your browser's Downloads folder.</>
              )}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <a
              href={lastSavedFile.downloadUrl}
              download={lastSavedFile.filename}
              className="btn btn-primary"
              style={{ fontSize: '0.8125rem', padding: '6px 14px' }}
            >
              ⬇ Download Video File
            </a>
            {ffmpegAvailable && (
              <button
                type="button"
                className="btn btn-secondary"
                onClick={() => revealInFinder(lastSavedFile.filename)}
                style={{ fontSize: '0.8125rem', padding: '6px 14px' }}
              >
                📂 Open in Finder
              </button>
            )}
          </div>
        </div>
      )}

      {/* Status or Success Notification */}
      {statusMessage && (
        <div className="recorder-status-message">
          {statusMessage}
        </div>
      )}

      {/* Saved Files List */}
      {savedRecordings.length > 0 && (
        <div className="saved-recordings-section">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="saved-recordings-title">Saved Recordings</span>
            {ffmpegAvailable && (
              <button
                type="button"
                className="text-btn"
                onClick={openDownloadsFolder}
              >
                📂 Open Downloads Folder
              </button>
            )}
          </div>
          <div className="saved-recordings-list">
            {savedRecordings.map((rec) => (
              <div key={rec.filename} className="saved-recording-item">
                <div className="saved-recording-info">
                  <span className="saved-recording-name">🎬 {rec.filename}</span>
                  <span className="saved-recording-size">{formatBytes(rec.sizeBytes)}</span>
                </div>
                <div className="saved-recording-actions">
                  {ffmpegAvailable && (
                    <button
                      type="button"
                      className="control-btn"
                      onClick={() => revealInFinder(rec.filename)}
                      title="Highlight file in macOS Finder"
                    >
                      📂 Show in Finder
                    </button>
                  )}
                  <a
                    href={rec.localBlobUrl || `/api/record/download/${rec.filename}`}
                    className="control-btn"
                    download={rec.filename}
                    title="Download video to computer"
                  >
                    ⬇ Download
                  </a>
                  <button
                    type="button"
                    className="control-btn"
                    onClick={() => handleDeleteBackendRecording(rec.filename)}
                    title="Delete file"
                    style={{ color: 'var(--danger)' }}
                  >
                    ✕
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
