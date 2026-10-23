import fs from 'fs';
import path from 'path';
import os from 'os';

export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const list = [];
  const seen = new Set();

  try {
    const downloadsDir = path.join(os.homedir(), 'Downloads');
    if (fs.existsSync(downloadsDir)) {
      const files = fs.readdirSync(downloadsDir)
        .filter((file) => (file.startsWith('StreamPlay_') || file.startsWith('Class_')) && (file.endsWith('.mp4') || file.endsWith('.webm')));

      for (const file of files) {
        try {
          const full = path.join(downloadsDir, file);
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

    // Check tmp directory for any files recorded during this session
    const tmpDir = '/tmp';
    if (fs.existsSync(tmpDir)) {
      try {
        const tmpFiles = fs.readdirSync(tmpDir)
          .filter((file) => (file.startsWith('StreamPlay_') || file.startsWith('Class_')) && (file.endsWith('.mp4') || file.endsWith('.webm')) && !seen.has(file));
        for (const file of tmpFiles) {
          try {
            const full = path.join(tmpDir, file);
            const stats = fs.statSync(full);
            list.push({
              filename: file,
              sizeBytes: stats.size,
              folder: 'cloud',
              modifiedAt: stats.mtime
            });
          } catch (e) {}
        }
      } catch (e) {}
    }

    list.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt));
  } catch (err) {}

  // Always return 200 with list (prevents 404 console errors on Vercel)
  return res.status(200).json({ recordings: list });
}
