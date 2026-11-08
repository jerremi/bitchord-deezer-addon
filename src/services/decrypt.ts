import crypto from 'node:crypto';
import pkg from 'egoroof-blowfish';

const Blowfish: any = (pkg as any).Blowfish || pkg;

const DEEZER_BLOWFISH_SECRET = 'g4el58wc0zvf9na1';
const DEEZER_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
export const CHUNK_SIZE = 2048;

/**
 * Derives the 16-byte Blowfish key for a Deezer track ID.
 */
export function getBlowfishKey(trackId: string | number): Buffer {
  const hash = crypto
    .createHash('md5')
    .update(String(trackId), 'ascii')
    .digest('hex');

  const key = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) {
    key[i] =
      hash.charCodeAt(i) ^
      hash.charCodeAt(i + 16) ^
      DEEZER_BLOWFISH_SECRET.charCodeAt(i);
  }
  return key;
}

/**
 * Decrypts a full or partial Deezer audio buffer.
 * @param buffer Raw buffer from Deezer CDN
 * @param trackId Track ID
 * @param startOffset Byte offset of this buffer within the whole file (default 0)
 */
export function decryptDeezerBuffer(
  buffer: Buffer,
  trackId: string | number,
  startOffset: number = 0
): Buffer {
  const key = getBlowfishKey(trackId);
  const bf = new Blowfish(key, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);

  const decryptedChunks: Buffer[] = [];
  const totalLength = buffer.length;

  for (let pos = 0; pos < totalLength; pos += CHUNK_SIZE) {
    const chunkLength = Math.min(CHUNK_SIZE, totalLength - pos);
    const chunk = buffer.subarray(pos, pos + chunkLength);
    const absoluteChunkIndex = Math.floor((startOffset + pos) / CHUNK_SIZE);

    // Every 3rd chunk (0, 3, 6, ...) of exactly 2048 bytes is encrypted
    if (absoluteChunkIndex % 3 === 0 && chunkLength === CHUNK_SIZE) {
      try {
        bf.setIv(DEEZER_IV);
        const decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
        decryptedChunks.push(decrypted);
      } catch {
        // Fallback to raw chunk if decoding fails
        decryptedChunks.push(chunk);
      }
    } else {
      decryptedChunks.push(chunk);
    }
  }

  return Buffer.concat(decryptedChunks);
}
