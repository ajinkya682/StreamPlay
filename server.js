import express from 'express';
import cors from 'cors';
import { spawn, exec } from 'child_process';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { fileURLToPath } from 'url';
import ffmpegInstaller from '@ffmpeg-installer/ffmpeg';

import { rewriteM3u8Content } from './api/_utils/rewriter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3001;

// Standard macOS Downloads directory for the user
const DOWNLOADS_DIR = path.join(os.homedir(), 'Downloads');
const RECORDINGS_DIR = path.join(__dirname, 'recordings');

if (!fs.existsSync(RECORDINGS_DIR)) {
  fs.mkdirSync(RECORDINGS_DIR, { recursive: true });
}

app.use(cors());

// Raw body parser for uploaded video blobs up to 2GB
app.use('/api/record/save-browser', express.raw({ type: '*/*', limit: '2048mb' }));
app.use(express.json());

// --- In-Memory Store for pasted playlists ---
const customPlaylists = new Map();

// Health check
app.get('/api/proxy/health', (req, res) => {
  res.json({ ok: true, activePlaylists: customPlaylists.size });
});

// Proxy .m3u8 playlists, rewrite relative segments, bypass CORS
app.get('/api/proxy/playlist', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).json({ error: 'Missing target url query parameter' });
  }

  try {
    const targetOrigin = new URL(targetUrl).origin;
    const upstreamRes = await fetch(targetUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': req.query.referer || `${targetOrigin}/`,
        'Origin': targetOrigin,
        'Accept': '*/*'
      }
    });

    if (!upstreamRes.ok) {
      const errText = await upstreamRes.text().catch(() => '');
      return res.status(upstreamRes.status).json({
        error: `Upstream playlist error (${upstreamRes.status})`,
        details: errText || upstreamRes.statusText
      });
    }

    const playlistText = await upstreamRes.text();
    const finalBaseUrl = upstreamRes.url || targetUrl;
    const rewritten = rewriteM3u8Content(playlistText, finalBaseUrl);

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.send(rewritten);
  } catch (err) {
    return res.status(502).json({ error: `Proxy playlist failed: ${err.message}` });
  }
});

// Proxy media segments (.ts chunks / keys / init files)
app.get('/api/proxy/segment', async (req, res) => {
  const targetUrl = req.query.url;
  if (!targetUrl) {
    return res.status(400).send('Missing target url query parameter');
  }

  try {
    const targetOrigin = new URL(targetUrl).origin;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Referer': req.query.referer || `${targetOrigin}/`,
      'Origin': targetOrigin,
      'Accept': '*/*'
    };

    if (req.headers.range) {
      headers['Range'] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, {
      method: 'GET',
      headers,
      redirect: 'follow'
    });

    res.status(upstreamRes.status);
    const contentType = upstreamRes.headers.get('content-type') || 'video/MP2T';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');

    const contentLength = upstreamRes.headers.get('content-length');
    if (contentLength) res.setHeader('Content-Length', contentLength);

    const contentRange = upstreamRes.headers.get('content-range');
    if (contentRange) res.setHeader('Content-Range', contentRange);

    const acceptRanges = upstreamRes.headers.get('accept-ranges') || 'bytes';
    res.setHeader('Accept-Ranges', acceptRanges);

    const arrayBuffer = await upstreamRes.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    res.end(buffer);
  } catch (err) {
    if (!res.headersSent) {
      res.status(502).send(`Proxy segment failed: ${err.message}`);
    }
  }
});

// Create a custom stream from pasted M3U8 text content
app.post('/api/proxy/paste-playlist', (req, res) => {
  const { content, baseUrl } = req.body;
  if (!content || !baseUrl) {
    return res.status(400).json({ error: 'Both content and baseUrl are required.' });
  }

  const id = `custom_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
  const rewritten = rewriteM3u8Content(content, baseUrl);
  customPlaylists.set(id, rewritten);

  // Auto clean up after 4 hours
  setTimeout(() => customPlaylists.delete(id), 4 * 3600 * 1000);

  return res.json({
    success: true,
    id,
    playlistUrl: `/api/proxy/custom/${id}.m3u8`
  });
});

// Serve custom stored playlist
app.get('/api/proxy/custom/:id.m3u8', (req, res) => {
  const id = req.params.id;
  const content = customPlaylists.get(id);
  if (!content) {
    return res.status(404).send('#EXTM3U\n# Error: Custom playlist expired or not found');
  }

  res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'no-cache, no-store');
  res.send(content);
});

const FFMPEG_PATH = ffmpegInstaller.path;

let activeRecording = {
  isRecording: false,
  process: null,
  filename: null,
  downloadsPath: null,
  url: null,
  startTime: null,
  durationSeconds: 0,
  sizeBytes: 0,
  error: null
};

// --- In-Browser Video Upload & Convert to True MP4 Directly into Downloads ---
app.post('/api/record/save-browser', async (req, res) => {
  const isWebm = (req.query.ext || '').toLowerCase() === 'webm';
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const baseName = `StreamPlay_Recording_${dateStr}`;
  const finalMp4Name = `${baseName}.mp4`;
  const targetDownloadsPath = path.join(DOWNLOADS_DIR, finalMp4Name);
  const tempPath = path.join(RECORDINGS_DIR, `${baseName}.${isWebm ? 'webm' : 'mp4'}`);

  try {
    const videoBuffer = req.body;
    if (!videoBuffer || videoBuffer.length === 0) {
      return res.status(400).json({ error: 'No video data received.' });
    }

    fs.writeFileSync(tempPath, videoBuffer);

    // If recorded in WebM by browser, convert or remux to QuickTime-compatible MP4 using FFmpeg
    if (isWebm) {
      const convertArgs = [
        '-y',
        '-i', tempPath,
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-crf', '22',
        '-c:a', 'aac',
        '-b:a', '192k',
        '-movflags', '+faststart',
        targetDownloadsPath
      ];

      const convertProc = spawn(FFMPEG_PATH, convertArgs);
      convertProc.on('close', (code) => {
        try { fs.unlinkSync(tempPath); } catch (e) {}

        if (code === 0 && fs.existsSync(targetDownloadsPath)) {
          const stat = fs.statSync(targetDownloadsPath);
          return res.json({
            success: true,
            filename: finalMp4Name,
            downloadsPath: targetDownloadsPath,
            sizeBytes: stat.size
          });
        } else {
          // If conversion had an issue, copy original directly to Downloads
          const fallbackWebm = path.join(DOWNLOADS_DIR, `${baseName}.webm`);
          fs.writeFileSync(fallbackWebm, videoBuffer);
          return res.json({
            success: true,
            filename: `${baseName}.webm`,
            downloadsPath: fallbackWebm,
            sizeBytes: videoBuffer.length
          });
        }
      });
    } else {
      // Input is already MP4: write directly to user's Downloads folder!
      fs.writeFileSync(targetDownloadsPath, videoBuffer);
      try { fs.unlinkSync(tempPath); } catch (e) {}

      return res.json({
        success: true,
        filename: finalMp4Name,
        downloadsPath: targetDownloadsPath,
        sizeBytes: videoBuffer.length
      });
    }
  } catch (err) {
    return res.status(500).json({ error: `Save failed: ${err.message}` });
  }
});

// --- Reveal / Highlight specific file in macOS Finder ---
app.post('/api/record/reveal', (req, res) => {
  const filename = path.basename(req.body.filename || '');
  let targetPath = path.join(DOWNLOADS_DIR, filename);

  if (!fs.existsSync(targetPath)) {
    targetPath = path.join(RECORDINGS_DIR, filename);
  }

  if (fs.existsSync(targetPath)) {
    // open -R reveals and selects the file in Finder!
    exec(`open -R "${targetPath}"`, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, path: targetPath });
    });
  } else {
    // Fallback to opening Downloads folder
    exec(`open "${DOWNLOADS_DIR}"`, (err) => {
      if (err) return res.status(500).json({ error: err.message });
      res.json({ success: true, folder: DOWNLOADS_DIR });
    });
  }
});

// --- Open macOS Downloads Folder in Finder ---
app.post('/api/record/open-downloads', (req, res) => {
  exec(`open "${DOWNLOADS_DIR}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ success: true, folder: DOWNLOADS_DIR });
  });
});

// --- FFmpeg Direct Stream Recording (Backend) directly into Downloads ---
app.post('/api/record/start', (req, res) => {
  const { url, filename } = req.body;

  if (!url || (!url.startsWith('http://') && !url.startsWith('https://'))) {
    return res.status(400).json({ error: 'Valid HTTP/HTTPS stream URL is required.' });
  }

  if (activeRecording.isRecording) {
    return res.status(409).json({ error: 'A recording is already running.' });
  }

  const safeName = (filename || `Class_${new Date().toISOString().slice(0, 10)}_${Date.now().toString().slice(-4)}`)
    .replace(/[^a-zA-Z0-9_-]/g, '_');
  const targetFile = `${safeName}.mp4`;
  const targetDownloads = path.join(DOWNLOADS_DIR, targetFile);

  const ffmpegArgs = [
    '-y',
    '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    '-i', url,
    '-c', 'copy',
    '-bsf:a', 'aac_adtstoasc',
    '-movflags', '+faststart',
    targetDownloads
  ];

  try {
    const proc = spawn(FFMPEG_PATH, ffmpegArgs, {
      stdio: ['pipe', 'pipe', 'pipe']
    });

    activeRecording = {
      isRecording: true,
      process: proc,
      filename: targetFile,
      downloadsPath: targetDownloads,
      url,
      startTime: Date.now(),
      durationSeconds: 0,
      sizeBytes: 0,
      error: null
    };

    proc.stderr.on('data', (data) => {
      const text = data.toString();
      const timeMatch = text.match(/time=(\d{2}):(\d{2}):(\d{2}\.\d+)/);
      if (timeMatch) {
        const hours = parseInt(timeMatch[1], 10);
        const mins = parseInt(timeMatch[2], 10);
        const secs = parseFloat(timeMatch[3]);
        activeRecording.durationSeconds = Math.round(hours * 3600 + mins * 60 + secs);
      }
      try {
        if (fs.existsSync(targetDownloads)) {
          activeRecording.sizeBytes = fs.statSync(targetDownloads).size;
        }
      } catch (e) {}
    });

    proc.on('close', () => {
      activeRecording.isRecording = false;
      activeRecording.process = null;
      try {
        if (fs.existsSync(targetDownloads)) {
          activeRecording.sizeBytes = fs.statSync(targetDownloads).size;
        }
      } catch (e) {}
    });

    return res.json({
      success: true,
      message: 'Recording started directly into Downloads',
      filename: targetFile
    });
  } catch (err) {
    activeRecording.isRecording = false;
    activeRecording.process = null;
    return res.status(500).json({ error: `Could not start recording: ${err.message}` });
  }
});

app.post('/api/record/stop', (req, res) => {
  if (!activeRecording.isRecording || !activeRecording.process) {
    return res.status(400).json({ error: 'No active recording to stop.' });
  }

  const { filename, downloadsPath, durationSeconds } = activeRecording;
  const proc = activeRecording.process;

  const finalize = () => {
    let finalSize = 0;
    try {
      if (fs.existsSync(downloadsPath)) {
        finalSize = fs.statSync(downloadsPath).size;
      }
    } catch (e) {}

    activeRecording.isRecording = false;
    activeRecording.process = null;

    res.json({
      success: true,
      file: {
        filename,
        downloadsPath,
        sizeBytes: finalSize,
        durationSeconds
      }
    });
  };

  proc.once('close', () => {
    finalize();
  });

  try {
    proc.stdin.write('q\n');
  } catch (e) {
    try { proc.kill('SIGINT'); } catch (e2) {}
  }

  // Safety fallback if 'q' doesn't exit within 3 seconds
  setTimeout(() => {
    if (activeRecording.isRecording && activeRecording.process) {
      try { activeRecording.process.kill('SIGTERM'); } catch (e) {}
      finalize();
    }
  }, 3000);
});

// Status endpoint
app.get('/api/record/status', (req, res) => {
  if (activeRecording.isRecording && activeRecording.downloadsPath) {
    try {
      if (fs.existsSync(activeRecording.downloadsPath)) {
        activeRecording.sizeBytes = fs.statSync(activeRecording.downloadsPath).size;
      }
    } catch (e) {}
  }

  res.json({
    isRecording: activeRecording.isRecording,
    filename: activeRecording.filename,
    startTime: activeRecording.startTime,
    durationSeconds: activeRecording.durationSeconds,
    sizeBytes: activeRecording.sizeBytes,
    error: activeRecording.error,
    ffmpegAvailable: true
  });
});

// List recordings from user's Downloads folder
app.get('/api/record/list', (req, res) => {
  try {
    const list = [];
    const seen = new Set();

    // Check Downloads directory for StreamPlay_ and Class_ files
    if (fs.existsSync(DOWNLOADS_DIR)) {
      const files = fs.readdirSync(DOWNLOADS_DIR)
        .filter((file) => (file.startsWith('StreamPlay_') || file.startsWith('Class_')) && (file.endsWith('.mp4') || file.endsWith('.webm')));

      for (const file of files) {
        try {
          const full = path.join(DOWNLOADS_DIR, file);
          const stats = fs.statSync(full);
          seen.add(file);
          list.push({
            filename: file,
            sizeBytes: stats.size,
            folder: 'Downloads',
            modifiedAt: stats.mtime
          });
        } catch (e) {}
      }
    }

    // Also check recordings folder for any legacy recordings
    if (fs.existsSync(RECORDINGS_DIR)) {
      const recFiles = fs.readdirSync(RECORDINGS_DIR)
        .filter((file) => (file.endsWith('.mp4') || file.endsWith('.webm')) && !seen.has(file));

      for (const file of recFiles) {
        try {
          const full = path.join(RECORDINGS_DIR, file);
          const stats = fs.statSync(full);
          list.push({
            filename: file,
            sizeBytes: stats.size,
            folder: 'recordings',
            modifiedAt: stats.mtime
          });
        } catch (e) {}
      }
    }

    list.sort((a, b) => b.modifiedAt - a.modifiedAt);
    res.json({ recordings: list });
  } catch (err) {
    res.status(500).json({ error: 'Failed to list recordings.' });
  }
});

// Download recording directly with strict headers
app.get('/api/record/download/:filename', (req, res) => {
  const file = req.params.filename;
  const safeName = path.basename(file);

  let targetPath = path.join(DOWNLOADS_DIR, safeName);
  if (!fs.existsSync(targetPath)) {
    targetPath = path.join(RECORDINGS_DIR, safeName);
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File not found in Downloads or recordings.' });
  }

  res.setHeader('Content-Type', 'video/mp4');
  res.setHeader('Content-Disposition', `attachment; filename="${safeName}"`);
  const stream = fs.createReadStream(targetPath);
  stream.pipe(res);
});

// Delete recording
app.delete('/api/record/:filename', (req, res) => {
  const file = req.params.filename;
  const safeName = path.basename(file);

  let targetPath = path.join(DOWNLOADS_DIR, safeName);
  if (!fs.existsSync(targetPath)) {
    targetPath = path.join(RECORDINGS_DIR, safeName);
  }

  if (!fs.existsSync(targetPath)) {
    return res.status(404).json({ error: 'File not found.' });
  }

  try {
    fs.unlinkSync(targetPath);
    res.json({ success: true, message: 'File deleted.' });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete file.' });
  }
});

app.listen(PORT, () => {
  console.log(`StreamPlay Recorder Backend running on http://localhost:${PORT}`);
  console.log(`Saving recordings directly to: ${DOWNLOADS_DIR}`);
});
