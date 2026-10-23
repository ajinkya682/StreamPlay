export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const isVercel = Boolean(process.env.VERCEL);

  return res.status(200).json({
    isRecording: false,
    filename: null,
    startTime: null,
    durationSeconds: 0,
    sizeBytes: 0,
    error: null,
    ffmpegAvailable: !isVercel,
    isCloud: isVercel
  });
}
