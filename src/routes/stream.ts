import type { Request, Response } from 'express';
import { getTrackStreamInfo } from '../services/deezer.js';
import { decryptDeezerBuffer, CHUNK_SIZE } from '../services/decrypt.js';

export async function handleStream(req: Request, res: Response) {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : (req.params.id || '');
  const numericId = String(rawId).replace(/^deezer:/i, '');
  const quality = (req.query.quality as string) || 'lossless';

  if (!numericId) {
    res.status(400).send('Missing track ID');
    return;
  }

  try {
    const { url: cdnUrl, format } = await getTrackStreamInfo(numericId, quality);
    const contentType = format.toUpperCase() === 'FLAC' ? 'audio/flac' : 'audio/mpeg';

    const rangeHeader = req.headers.range;

    if (!rangeHeader) {
      // 1. Full file request (No Range header)
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok) {
        res.status(cdnRes.status).send(`CDN error: ${cdnRes.statusText}`);
        return;
      }

      const rawBuffer = Buffer.from(await cdnRes.arrayBuffer());
      const decrypted = decryptDeezerBuffer(rawBuffer, numericId, 0);

      res.writeHead(200, {
        'Content-Type': contentType,
        'Content-Length': decrypted.length,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=3600',
      });
      res.end(decrypted);
      return;
    }

    // 2. Range request (ExoPlayer seeking / buffering)
    const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!matches) {
      res.status(416).send('Invalid Range header');
      return;
    }

    const start = parseInt(matches[1], 10);
    const end = matches[2] ? parseInt(matches[2], 10) : undefined;

    // Align range to 2048-byte chunk boundaries for Blowfish stripe decryption
    const alignedStart = Math.floor(start / CHUNK_SIZE) * CHUNK_SIZE;
    const alignedEnd =
      typeof end === 'number'
        ? (Math.floor(end / CHUNK_SIZE) + 1) * CHUNK_SIZE - 1
        : undefined;

    const cdnRange =
      typeof alignedEnd === 'number'
        ? `bytes=${alignedStart}-${alignedEnd}`
        : `bytes=${alignedStart}-`;

    const cdnRes = await fetch(cdnUrl, {
      headers: { Range: cdnRange },
    });

    if (!cdnRes.ok && cdnRes.status !== 206) {
      res.status(cdnRes.status).send(`CDN Range error: ${cdnRes.statusText}`);
      return;
    }

    const cdnContentRange = cdnRes.headers.get('content-range');
    let totalFileSize = '*';
    if (cdnContentRange) {
      const totalMatch = cdnContentRange.match(/\/(\d+|\*)/);
      if (totalMatch) {
        totalFileSize = totalMatch[1];
      }
    }

    const rawBuffer = Buffer.from(await cdnRes.arrayBuffer());
    const decrypted = decryptDeezerBuffer(rawBuffer, numericId, alignedStart);

    // Slice to exact client-requested range
    const offsetInDecrypted = start - alignedStart;
    const desiredLength = typeof end === 'number' ? end - start + 1 : undefined;

    const finalBuffer =
      typeof desiredLength === 'number'
        ? decrypted.subarray(offsetInDecrypted, offsetInDecrypted + desiredLength)
        : decrypted.subarray(offsetInDecrypted);

    const actualEnd = start + finalBuffer.length - 1;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${actualEnd}/${totalFileSize}`,
      'Content-Length': finalBuffer.length,
      'Accept-Ranges': 'bytes',
    });
    res.end(finalBuffer);
  } catch (error: any) {
    console.error(`Stream error for ID ${numericId}:`, error?.message || error);
    res.status(500).send(`Failed to stream track: ${error?.message || error}`);
  }
}
