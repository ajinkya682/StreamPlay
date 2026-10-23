export default function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // In cloud environment, client-side download is used to avoid server upload limits
  const now = new Date();
  const dateStr = now.toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const isWebm = (req.query?.ext || '').toLowerCase() === 'webm';
  const filename = `StreamPlay_Recording_${dateStr}.${isWebm ? 'webm' : 'mp4'}`;

  return res.status(200).json({
    success: true,
    cloud: true,
    filename,
    message: 'Processed via client download'
  });
}
