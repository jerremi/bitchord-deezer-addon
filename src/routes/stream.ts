import type { Request, Response } from 'express';
import { getTrackStreamInfo } from '../services/deezer.js';
import { CHUNK_SIZE, streamAndDecryptDeezer } from '../services/decrypt.js';

type ParsedRange = { start: number; end: number } | 'invalid' | null;

/**
 * Parses a single-range `bytes=` header. Multi-range requests are rejected,
 * which is fine: audio players only ever ask for one contiguous range.
 */
function parseRange(header: string | undefined, fileSize: number): ParsedRange {
  if (!header) return null;

  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return 'invalid';

  const [, rawStart, rawEnd] = match;
  if ((!rawStart && !rawEnd) || fileSize <= 0) return 'invalid';

  let start: number;
  let end: number;

  if (!rawStart) {
    // Suffix range: bytes=-500 (last 500 bytes)
    const suffixLength = Number(rawEnd);
    if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) return 'invalid';
    start = Math.max(0, fileSize - suffixLength);
    end = fileSize - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd ? Number(rawEnd) : fileSize - 1;

    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start > end) {
      return 'invalid';
    }
    if (start >= fileSize) return 'invalid';
    if (end >= fileSize) end = fileSize - 1;
  }

  return { start, end };
}

export async function handleStream(req: Request, res: Response) {
  req.socket?.setNoDelay(true);

  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id || '';
  const numericId = String(rawId).replace(/^deezer:/i, '');
  const quality = req.query.quality === 'high' ? 'high' : 'lossless';
  const t0 = Date.now();

  if (!/^\d+$/.test(numericId)) {
    res.status(400).send('Invalid track ID');
    return;
  }

  try {
    const { url: cdnUrl, format, fileSize } = await getTrackStreamInfo(numericId, quality);
    const contentType = format.toUpperCase() === 'FLAC' ? 'audio/flac' : 'audio/mpeg';
    const range = parseRange(req.headers.range, fileSize);

    if (range === 'invalid') {
      res
        .status(416)
        .set('Content-Range', `bytes */${fileSize || '*'}`)
        .send('Range not satisfiable');
      return;
    }

    // HEAD only needs metadata; never download audio for it.
    if (req.method === 'HEAD') {
      if (range) {
        res.writeHead(206, {
          'Content-Type': contentType,
          'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
          'Content-Length': range.end - range.start + 1,
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
        });
      } else {
        res.writeHead(200, {
          'Content-Type': contentType,
          ...(fileSize > 0 ? { 'Content-Length': fileSize } : {}),
          'Accept-Ranges': 'bytes',
          'Cache-Control': 'public, max-age=86400',
        });
      }
      res.end();
      console.log(`[STREAM] HEAD ${numericId} | ${Date.now() - t0}ms | ${fileSize} bytes`);
      return;
    }

    if (!range) {
      // Full file: stream progressively so playback can start immediately.
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok || !cdnRes.body) {
        console.error(`[STREAM] CDN full failed ${numericId}: HTTP ${cdnRes.status}`);
        res.status(502).send('Upstream stream unavailable');
        return;
      }

      const totalSize =
        Number(cdnRes.headers.get('content-length')) || fileSize;
      const totalLength = totalSize > 0 ? totalSize : 0;

      res.writeHead(200, {
        'Content-Type': contentType,
        ...(totalLength > 0 ? { 'Content-Length': totalLength } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });

      console.log(
        `[STREAM] 200 ${numericId} | ${Date.now() - t0}ms | ${totalLength || 'unknown'} bytes`
      );

      await streamAndDecryptDeezer(
        cdnRes.body,
        numericId,
        0,
        0,
        totalLength > 0 ? totalLength - 1 : undefined,
        res
      );
      return;
    }

    // Fetch whole 2048-byte stripes that cover the requested range.
    const alignedStart = Math.floor(range.start / CHUNK_SIZE) * CHUNK_SIZE;
    const alignedEnd = Math.ceil((range.end + 1) / CHUNK_SIZE) * CHUNK_SIZE - 1;

    const cdnRes = await fetch(cdnUrl, {
      headers: { Range: `bytes=${alignedStart}-${alignedEnd}` },
    });

    if (!cdnRes.ok && cdnRes.status !== 206) {
      console.error(`[STREAM] CDN range failed ${numericId}: HTTP ${cdnRes.status}`);
      res.status(502).send('Upstream stream unavailable');
      return;
    }
    if (!cdnRes.body) {
      res.status(502).send('Upstream stream unavailable');
      return;
    }

    // If the CDN ignored the Range header the body starts at byte 0.
    const startOffset = cdnRes.status === 206 ? alignedStart : 0;

    res.writeHead(206, {
      'Content-Type': contentType,
      'Content-Range': `bytes ${range.start}-${range.end}/${fileSize}`,
      'Content-Length': range.end - range.start + 1,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'public, max-age=86400',
    });

    console.log(
      `[STREAM] 206 ${numericId} | ${Date.now() - t0}ms | ${range.start}-${range.end}/${fileSize}`
    );

    await streamAndDecryptDeezer(
      cdnRes.body,
      numericId,
      startOffset,
      range.start,
      range.end,
      res
    );
  } catch (error: any) {
    console.error(
      `[STREAM] ERROR ${numericId} | ${Date.now() - t0}ms | ${error?.message || error}`
    );
    if (res.headersSent) {
      res.destroy();
    } else {
      res.status(500).send('Failed to stream track');
    }
  }
}
