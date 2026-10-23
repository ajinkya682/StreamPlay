import fs from 'fs';
import path from 'path';

// In-memory fallback
const memoryStore = new Map();

export function saveCustomPlaylist(id, content) {
  memoryStore.set(id, content);
  try {
    const tmpFile = path.join('/tmp', `streamplay_custom_${id}.m3u8`);
    fs.writeFileSync(tmpFile, content, 'utf8');
  } catch (e) {}
}

export function getCustomPlaylist(id) {
  if (memoryStore.has(id)) {
    return memoryStore.get(id);
  }
  try {
    const tmpFile = path.join('/tmp', `streamplay_custom_${id}.m3u8`);
    if (fs.existsSync(tmpFile)) {
      return fs.readFileSync(tmpFile, 'utf8');
    }
  } catch (e) {}
  return null;
}
