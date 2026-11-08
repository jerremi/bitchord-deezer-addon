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

function createBlowfish(trackId: string | number): any {
  return new Blowfish(getBlowfishKey(trackId), Blowfish.MODE.CBC, Blowfish.PADDING.NULL);
}

/**
 * Decrypts one 2048-byte stripe. NULL padding strips trailing 0x00 bytes while
 * decoding, so they are restored to keep output length identical to the input.
 * Otherwise the byte stream shifts and the player receives corrupt audio.
 */
function decryptChunk(bf: any, chunk: Buffer): Buffer {
  bf.setIv(DEEZER_IV);
  const raw = Buffer.from(bf.decode(chunk, Blowfish.TYPE.UINT8_ARRAY));
  if (raw.length === chunk.length) return raw;

  const restored = Buffer.alloc(chunk.length);
  raw.copy(restored);
  return restored;
}

function decryptChunkSafe(bf: any, chunk: Buffer): Buffer {
  try {
    return decryptChunk(bf, chunk);
  } catch {
    return chunk;
  }
}

/**
 * Decrypts a full buffer synchronously (useful for tests and small ranges).
 */
export function decryptDeezerBuffer(
  buffer: Buffer,
  trackId: string | number,
  startOffset: number = 0
): Buffer {
  const bf = createBlowfish(trackId);
  const decryptedChunks: Buffer[] = [];

  for (let pos = 0; pos < buffer.length; pos += CHUNK_SIZE) {
    const chunk = buffer.subarray(pos, Math.min(pos + CHUNK_SIZE, buffer.length));
    const absoluteChunkIndex = Math.floor((startOffset + pos) / CHUNK_SIZE);

    if (absoluteChunkIndex % 3 === 0 && chunk.length === CHUNK_SIZE) {
      decryptedChunks.push(decryptChunkSafe(bf, chunk));
    } else {
      decryptedChunks.push(chunk);
    }
  }

  return Buffer.concat(decryptedChunks);
}

/**
 * Streams and decrypts Deezer CDN audio chunk-by-chunk with instant TTFB.
 * The CDN range must start on a 2048-byte boundary; `startOffset` is that
 * boundary so Blowfish stripe indexes stay aligned with the source file.
 */
export async function streamAndDecryptDeezer(
  stream: ReadableStream<Uint8Array>,
  trackId: string | number,
  startOffset: number,
  requestedStart: number,
  requestedEnd: number | undefined,
  res: Response
): Promise<void> {
  const bf = createBlowfish(trackId);
  const reader = stream.getReader();

  let pending = Buffer.alloc(0);
  let absolutePos = startOffset;
  let aborted = false;

  const cancelReader = async () => {
    try {
      await reader.cancel();
    } catch {
      // Stream already closed.
    }
  };

  const onClose = () => {
    aborted = true;
    void cancelReader();
  };
  res.once('close', onClose);

  /**
   * Writes a slice and waits for 'drain' when the socket is saturated, so a
   * slow client cannot make the server buffer a whole track in memory.
   */
  const write = async (data: Buffer): Promise<boolean> => {
    if (data.length === 0) return true;
    if (aborted || res.destroyed || res.writableEnded) return false;

    if (res.write(data)) return true;

    return new Promise<boolean>((resolve) => {
      const cleanup = () => {
        res.off('drain', onDrain);
        res.off('close', onDrainClose);
        res.off('error', onDrainClose);
      };
      const onDrain = () => {
        cleanup();
        resolve(true);
      };
      const onDrainClose = () => {
        cleanup();
        aborted = true;
        resolve(false);
      };
      res.once('drain', onDrain);
      res.once('close', onDrainClose);
      res.once('error', onDrainClose);
    });
  };

  try {
    while (!aborted) {
      const { done, value } = await reader.read();
      if (done) break;

      const incoming = Buffer.from(value);
      pending = pending.length === 0 ? incoming : Buffer.concat([pending, incoming]);

      while (pending.length >= CHUNK_SIZE) {
        const chunk = pending.subarray(0, CHUNK_SIZE);
        pending = pending.subarray(CHUNK_SIZE);

        const chunkIndex = Math.floor(absolutePos / CHUNK_SIZE);
        const decrypted =
          chunkIndex % 3 === 0 ? decryptChunkSafe(bf, chunk) : chunk;

        const sliceFrom = Math.max(0, requestedStart - absolutePos);
        const sliceTo =
          requestedEnd !== undefined
            ? Math.min(CHUNK_SIZE, requestedEnd - absolutePos + 1)
            : CHUNK_SIZE;

        if (sliceTo > sliceFrom && !(await write(decrypted.subarray(sliceFrom, sliceTo)))) {
          break;
        }

        absolutePos += CHUNK_SIZE;

        if (requestedEnd !== undefined && absolutePos > requestedEnd) {
          await cancelReader();
          if (!aborted) res.end();
          return;
        }
      }
    }

    if (!aborted) {
      // A trailing partial chunk is never encrypted.
      const sliceFrom = Math.max(0, requestedStart - absolutePos);
      const sliceTo =
        requestedEnd !== undefined
          ? Math.min(pending.length, requestedEnd - absolutePos + 1)
          : pending.length;

      if (sliceTo > sliceFrom) {
        await write(pending.subarray(sliceFrom, sliceTo));
      }
    }

    if (aborted) {
      await cancelReader();
      return;
    }

    res.end();
  } catch (error) {
    await cancelReader();
    if (aborted) {
      if (!res.writableEnded) res.destroy();
      return;
    }
    throw error;
  } finally {
    res.off('close', onClose);
  }
}
