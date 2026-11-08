import crypto from 'node:crypto';
import type { Response } from 'express';
import pkg from 'egoroof-blowfish';

const Blowfish: any = (pkg as any).Blowfish || pkg;

const DEEZER_BLOWFISH_SECRET = 'g4el58wc0zvf9na1';
export const DEEZER_IV = Buffer.from([0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07]);
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
 * Decrypts a full buffer synchronously (useful for small range queries).
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

    if (absoluteChunkIndex % 3 === 0 && chunkLength === CHUNK_SIZE) {
      try {
        bf.setIv(DEEZER_IV);
        const decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
        decryptedChunks.push(decrypted);
      } catch {
        decryptedChunks.push(chunk);
      }
    } else {
      decryptedChunks.push(chunk);
    }
  }

  return Buffer.concat(decryptedChunks);
}

/**
 * Streams and decrypts Deezer CDN audio chunk-by-chunk with instant TTFB (~30ms).
 */
export async function streamAndDecryptDeezer(
  stream: ReadableStream<Uint8Array>,
  trackId: string | number,
  startOffset: number,
  requestedStart: number,
  requestedEnd: number | undefined,
  res: Response
): Promise<void> {
  const key = getBlowfishKey(trackId);
  const bf = new Blowfish(key, Blowfish.MODE.CBC, Blowfish.PADDING.NULL);

  let currentBuffer = Buffer.alloc(0);
  let absolutePos = startOffset;
  let bytesWritten = 0;
  const maxBytesToWrite =
    typeof requestedEnd === 'number' ? requestedEnd - requestedStart + 1 : undefined;

  const reader = stream.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (currentBuffer.length > 0) {
          const chunkLen = currentBuffer.length;
          const chunkIndex = Math.floor(absolutePos / CHUNK_SIZE);
          let chunk = currentBuffer;

          if (chunkIndex % 3 === 0 && chunkLen === CHUNK_SIZE) {
            try {
              bf.setIv(DEEZER_IV);
              chunk = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
            } catch {
              // Ignore decrypt error on partial
            }
          }

          const sliceStart = Math.max(0, requestedStart - absolutePos);
          if (sliceStart < chunk.length) {
            let slice = chunk.subarray(sliceStart);
            if (typeof maxBytesToWrite === 'number') {
              const remaining = maxBytesToWrite - bytesWritten;
              if (slice.length > remaining) slice = slice.subarray(0, remaining);
            }
            if (slice.length > 0) {
              res.write(slice);
              bytesWritten += slice.length;
            }
          }
        }
        break;
      }

      currentBuffer = Buffer.concat([currentBuffer, Buffer.from(value)]);

      while (currentBuffer.length >= CHUNK_SIZE) {
        const chunk = currentBuffer.subarray(0, CHUNK_SIZE);
        currentBuffer = currentBuffer.subarray(CHUNK_SIZE);

        const chunkIndex = Math.floor(absolutePos / CHUNK_SIZE);
        let decrypted = chunk;

        if (chunkIndex % 3 === 0) {
          try {
            bf.setIv(DEEZER_IV);
            decrypted = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
          } catch {
            // Fallback to unencrypted
          }
        }

        const chunkEnd = absolutePos + CHUNK_SIZE - 1;

        if (chunkEnd >= requestedStart) {
          const sliceStart = Math.max(0, requestedStart - absolutePos);
          let slice = decrypted.subarray(sliceStart);

          if (typeof maxBytesToWrite === 'number') {
            const remaining = maxBytesToWrite - bytesWritten;
            if (slice.length > remaining) {
              slice = slice.subarray(0, remaining);
            }
          }

          if (slice.length > 0) {
            res.write(slice);
            bytesWritten += slice.length;
          }

          if (typeof maxBytesToWrite === 'number' && bytesWritten >= maxBytesToWrite) {
            await reader.cancel();
            res.end();
            return;
          }
        }

        absolutePos += CHUNK_SIZE;
      }
    }
    res.end();
  } catch {
    res.end();
  }
}
