import { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';

/**
 * Custom hook to manage HLS and native video playback lifecycle.
 * Supports hls.js for Chrome/Firefox and native HLS fallback (Safari/iOS).
 */
export function useHlsPlayer(videoRef) {
  const hlsRef = useRef(null);
  const retryCountRef = useRef(0);
  const loadingTimeoutRef = useRef(null);
  const isProxyActiveRef = useRef(false);
  const maxRetries = 2; // prevent infinite loops on failing streams

  const [status, setStatus] = useState('ready'); // 'ready' | 'loading' | 'playing' | 'paused' | 'error'
  const [error, setError] = useState(null);
  const [isLive, setIsLive] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [seekableRange, setSeekableRange] = useState(null);
  const [canSeek, setCanSeek] = useState(false);
  const [currentUrl, setCurrentUrl] = useState('');

  // Helper to destroy HLS instance and reset media
  const cleanup = useCallback(() => {
    if (loadingTimeoutRef.current) {
      clearTimeout(loadingTimeoutRef.current);
      loadingTimeoutRef.current = null;
    }

    if (hlsRef.current) {
      try {
        hlsRef.current.stopLoad();
        hlsRef.current.detachMedia();
        hlsRef.current.destroy();
      } catch (err) {
        // ignore cleanup errors
      }
      hlsRef.current = null;
    }

    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute('src');
      video.load();
    }

    retryCountRef.current = 0;
    isProxyActiveRef.current = false;
    setIsLive(false);
    setDuration(0);
    setCurrentTime(0);
    setSeekableRange(null);
    setCanSeek(false);
  }, [videoRef]);

  // Update time and seekable range from the video element
  const updatePlaybackProgress = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;

    setCurrentTime(video.currentTime || 0);

    // Compute seekable range
    if (video.seekable && video.seekable.length > 0) {
      const start = video.seekable.start(0);
      const end = video.seekable.end(video.seekable.length - 1);
      setSeekableRange({ start, end });
      // Can seek if seekable range span is at least 3 seconds
      setCanSeek(end - start > 3);
    } else {
      setSeekableRange(null);
      setCanSeek(false);
    }

    // Check duration (Infinity or NaN indicate live without duration)
    const dur = video.duration;
    if (Number.isFinite(dur) && dur > 0) {
      setDuration(dur);
    } else {
      setDuration(0);
    }
  }, [videoRef]);

  // Load and play a given HLS URL
  const loadStream = useCallback((url, forceProxy = false) => {
    if (!url || typeof url !== 'string') {
      setError({
        title: 'Invalid URL',
        message: 'Please provide a valid HLS stream URL.'
      });
      setStatus('error');
      return;
    }

    const trimmedUrl = url.trim();
    const isHttp = trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://');
    const isLocalApi = trimmedUrl.startsWith('/api/');

    if (!isHttp && !isLocalApi) {
      setError({
        title: 'Unsupported Protocol',
        message: 'URL must start with http:// or https://'
      });
      setStatus('error');
      return;
    }

    // Clean up previous playback session completely
    cleanup();
    setCurrentUrl(trimmedUrl);
    setError(null);
    setStatus('loading');

    const video = videoRef.current;
    if (!video) return;

    // Check HLS.js support (Primary for Chrome, Firefox, Edge)
    if (Hls.isSupported()) {
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: true,
        backBufferLength: 60,
        maxBufferLength: 30,
        manifestLoadingTimeOut: 10000,
        manifestLoadingMaxRetry: 2,
        levelLoadingMaxRetry: 2,
        fragLoadingMaxRetry: 2,
        xhrSetup: (xhr) => {
          xhr.withCredentials = false;
        }
      });

      hlsRef.current = hls;

      const initialSource = forceProxy && isHttp && !trimmedUrl.includes('/api/proxy')
        ? `/api/proxy/playlist?url=${encodeURIComponent(trimmedUrl)}`
        : trimmedUrl;

      if (initialSource.includes('/api/proxy/')) {
        isProxyActiveRef.current = true;
      }

      // Safeguard: 12-second loading timeout watchdog
      loadingTimeoutRef.current = setTimeout(() => {
        if (!hlsRef.current) return;
        if (!isProxyActiveRef.current && isHttp) {
          console.warn('[StreamPlay] Direct stream timed out. Auto-switching to local proxy...');
          isProxyActiveRef.current = true;
          retryCountRef.current = 0;
          hls.loadSource(`/api/proxy/playlist?url=${encodeURIComponent(trimmedUrl)}`);
        } else {
          cleanup();
          setStatus('error');
          setError({
            title: 'Stream Loading Timed Out',
            message: 'The stream took too long to connect or the server is unresponsive.',
            help: 'Check if the link token is still active, or try pasting the raw M3U8 content.'
          });
        }
      }, 12000);

      hls.on(Hls.Events.MEDIA_ATTACHED, () => {
        hls.loadSource(initialSource);
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
        if (loadingTimeoutRef.current) {
          clearTimeout(loadingTimeoutRef.current);
          loadingTimeoutRef.current = null;
        }
        setStatus('playing');
        video.play().catch(() => {
          // Autoplay policy: pause state is expected if browser blocked autoplay with sound
          setStatus('paused');
        });
      });

      hls.on(Hls.Events.LEVEL_LOADED, (event, data) => {
        if (loadingTimeoutRef.current) {
          clearTimeout(loadingTimeoutRef.current);
          loadingTimeoutRef.current = null;
        }
        const live = data.details?.live ?? false;
        setIsLive(live);
        if (data.details?.totalduration && Number.isFinite(data.details.totalduration)) {
          setDuration(data.details.totalduration);
        }
      });

      hls.on(Hls.Events.ERROR, (event, data) => {
        if (!data.fatal) {
          // Non-fatal error, e.g. temporary fragment buffer stall
          return;
        }

        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR: {
            const httpStatus = data.response?.code;

            // If direct stream hit CORS restriction or failed to load manifest, try proxy automatically!
            if (!isProxyActiveRef.current && isHttp && (httpStatus === 0 || !httpStatus || data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR)) {
              console.warn('[StreamPlay] Direct stream failed (CORS/Network). Switching automatically to local proxy...');
              isProxyActiveRef.current = true;
              retryCountRef.current = 0;
              const proxyUrl = `/api/proxy/playlist?url=${encodeURIComponent(trimmedUrl)}`;
              hls.loadSource(proxyUrl);
              return;
            }

            const responseText = data.response?.text || '';
            let explanation = 'Unable to load stream playlist or video segments.';
            let customErrorHelp = '';

            if (responseText.includes('Google-Edge-Cache') || responseText.includes('Upstream playlist error')) {
              explanation = 'ClassX Video Token Expired (Google-Edge-Cache: Not Found).';
              customErrorHelp = 'The video token from your ClassX / Ignite portal has expired (tokens typically expire after 10–15 minutes). Open your student portal, refresh your class video to generate a fresh link, and paste the new URL.';
            } else if (httpStatus === 403) {
              explanation = 'HTTP 403 Forbidden: The stream URL token has expired or requires authorization.';
              customErrorHelp = 'Signed stream tokens are temporary. Open your portal and copy a fresh link generated right now.';
            } else if (httpStatus === 404) {
              explanation = 'HTTP 404 Not Found: The stream playlist was not found on the streaming server.';
              customErrorHelp = 'The video server returned 404. If this is a live lecture or class recording, get a new link from your portal.';
            } else if (httpStatus === 0 || !httpStatus) {
              explanation = 'Network error or CORS restriction: The streaming server does not allow direct browser playback.';
            }

            if (retryCountRef.current < maxRetries) {
              retryCountRef.current += 1;
              if (data.details === Hls.ErrorDetails.MANIFEST_LOAD_ERROR) {
                const src = isProxyActiveRef.current ? `/api/proxy/playlist?url=${encodeURIComponent(trimmedUrl)}` : trimmedUrl;
                hls.loadSource(src);
              } else {
                hls.startLoad();
              }
            } else {
              cleanup();
              setStatus('error');
              setError({
                title: 'Stream Connection Failed',
                message: explanation,
                help: customErrorHelp || (isProxyActiveRef.current
                  ? 'The proxy connected to the streaming server, but the link token has expired or is invalid.'
                  : 'Ensure today’s link is fresh and that the video token is valid.')
              });
            }
            break;
          }
          case Hls.ErrorTypes.MEDIA_ERROR: {
            if (retryCountRef.current < maxRetries) {
              retryCountRef.current += 1;
              hls.recoverMediaError();
            } else {
              cleanup();
              setStatus('error');
              setError({
                title: 'Media Decode Error',
                message: 'An error occurred while decoding the video stream format.',
                help: 'The stream format or codec may not be supported by this browser.'
              });
            }
            break;
          }
          default: {
            cleanup();
            setStatus('error');
            setError({
              title: 'Playback Error',
              message: 'An unrecoverable playback error occurred.',
              help: data.details || 'Check console or verify the HLS link.'
            });
            break;
          }
        }
      });

      hls.attachMedia(video);
    } 
    // Fallback for Safari / Apple native HLS playback
    else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      const src = forceProxy && isHttp ? `/api/proxy/playlist?url=${encodeURIComponent(trimmedUrl)}` : trimmedUrl;
      video.src = src;
      video.play().catch(() => {
        setStatus('paused');
      });
    } else {
      setStatus('error');
      setError({
        title: 'Unsupported Browser',
        message: 'Your browser does not support HLS playback (neither MediaSource nor native HLS is available).'
      });
    }
  }, [cleanup, videoRef]);

  // Stop playback explicitly
  const stopStream = useCallback(() => {
    cleanup();
    setStatus('ready');
    setCurrentUrl('');
    setError(null);
  }, [cleanup]);

  // Jump by relative offset (+10s or -10s) respecting actual seekable range
  const skip = useCallback((seconds) => {
    const video = videoRef.current;
    if (!video || !seekableRange) return;

    const targetTime = video.currentTime + seconds;
    const boundedTime = Math.max(seekableRange.start, Math.min(seekableRange.end, targetTime));
    video.currentTime = boundedTime;
  }, [seekableRange, videoRef]);

  // Jump to live edge if stream is live
  const jumpToLiveEdge = useCallback(() => {
    const video = videoRef.current;
    if (!video || !seekableRange) return;
    // Seek to 1 second before end to stay in buffer
    const target = Math.max(seekableRange.start, seekableRange.end - 1);
    video.currentTime = target;
  }, [seekableRange, videoRef]);

  // Attach standard HTML5 video event listeners
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const handlePlay = () => setStatus('playing');
    const handlePause = () => {
      // Don't override 'error' or 'loading' status with 'paused'
      setStatus((prev) => (prev === 'playing' ? 'paused' : prev));
    };
    const handleWaiting = () => {
      setStatus((prev) => (prev !== 'error' && prev !== 'ready' ? 'loading' : prev));
    };
    const handlePlaying = () => setStatus('playing');
    const handleTimeUpdate = () => updatePlaybackProgress();
    const handleProgress = () => updatePlaybackProgress();
    const handleDurationChange = () => {
      const dur = video.duration;
      if (dur === Infinity) {
        setIsLive(true);
      } else if (Number.isFinite(dur) && dur > 0) {
        setDuration(dur);
      }
    };
    const handleNativeError = () => {
      // In native mode (e.g. Safari) or media source failures
      if (!hlsRef.current) {
        setStatus('error');
        setError({
          title: 'Playback Error',
          message: 'The video could not be loaded or played back.',
          help: 'Check network connectivity or verify if the .m3u8 link is active.'
        });
      }
    };

    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('waiting', handleWaiting);
    video.addEventListener('playing', handlePlaying);
    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('progress', handleProgress);
    video.addEventListener('durationchange', handleDurationChange);
    video.addEventListener('error', handleNativeError);

    return () => {
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('waiting', handleWaiting);
      video.removeEventListener('playing', handlePlaying);
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('progress', handleProgress);
      video.removeEventListener('durationchange', handleDurationChange);
      video.removeEventListener('error', handleNativeError);
    };
  }, [updatePlaybackProgress, videoRef]);

  // Clean up on component unmount
  useEffect(() => {
    return () => {
      cleanup();
    };
  }, [cleanup]);

  return {
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
  };
}
