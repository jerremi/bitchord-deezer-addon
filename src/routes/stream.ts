import type { Request, Response } from 'express';
import { getTrackStreamInfo } from '../services/deezer.js';
import { streamAndDecryptDeezer, CHUNK_SIZE } from '../services/decrypt.js';

export async function handleStream(req: Request, res: Response) {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id || '';
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
      // 1. Full stream request
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok || !cdnRes.body) {
        res.status(cdnRes.status).send(`CDN error: ${cdnRes.statusText}`);
        return;
      }

      const totalSize = cdnRes.headers.get('content-length') || '*';

      res.writeHead(200, {
        'Content-Type': contentType,
        ...(totalSize !== '*' ? { 'Content-Length': totalSize } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });

      await streamAndDecryptDeezer(cdnRes.body, numericId, 0, 0, undefined, res);
      return;
    }

    // 2. HTTP Range request (ExoPlayer seeking and buffer streaming)
    const matches = rangeHeader.match(/bytes=(\d+)-(\d*)/);
    if (!matches) {
      res.status(416).send('Invalid Range header');
      return;
    }

    const start = parseInt(matches[1], 10);
    const end = matches[2] ? parseInt(matches[2], 10) : undefined;

    // Align to 2048-byte chunks for Blowfish stripe decryption
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

    if (!cdnRes.body) {
      res.status(500).send('CDN stream body is empty');
      return;
    }

    // Extract total file size from CDN Content-Range header (e.g. bytes 0-1023/22934004)
    const cdnContentRange = cdnRes.headers.get('content-range') || '';
    const totalMatch = cdnContentRange.match(/\/(\d+|\*)/);
    const totalFileSize = totalMatch ? totalMatch[1] : '*';

    // Calculate response range length
    const actualEnd =
      typeof end === 'number'
        ? end
        : totalFileSize !== '*'
          ? parseInt(totalFileSize, 10) - 1
          : undefined;

    const contentLength =
      typeof actualEnd === 'number' ? actualEnd - start + 1 : undefined;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${start}-${typeof actualEnd === 'number' ? actualEnd : '*'}/${totalFileSize}`,
      ...(typeof contentLength === 'number' ? { 'Content-Length': contentLength } : {}),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });

    await streamAndDecryptDeezer(cdnRes.body, numericId, alignedStart, start, end, res);
  } catch (error: any) {
    if (!res.headersSent) {
      console.error(`Stream error for ID ${numericId}:`, error?.message || error);
      res.status(500).send(`Failed to stream track: ${error?.message || error}`);
    }
  }
}
