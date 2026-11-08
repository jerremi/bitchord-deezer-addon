import type { Request, Response } from 'express';
import { getTrackStreamInfo } from '../services/deezer.js';
import { CHUNK_SIZE, streamAndDecryptDeezer } from '../services/decrypt.js';

type ParsedRange = { start: number; end: number } | 'invalid' | null;
type Quality = 'lossless' | 'high';

interface TrackRequest {
  numericId: string;
  quality: Quality;
}

function parseTrackRequest(req: Request): TrackRequest | null {
  const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id || '';
  const numericId = String(rawId).replace(/^deezer:/i, '');
  if (!/^\d+$/.test(numericId)) return null;

  return {
    numericId,
    quality: req.query.quality === 'high' ? 'high' : 'lossless',
  };
}

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

/**
 * `GET /stream/{id}` — BitChord addon protocol: JSON describing where the
 * playable audio is. The app reads the whole response body before parsing, so
 * this must never serve audio bytes; the audio lives at `/audio/{id}`.
 */
export async function handleStream(req: Request, res: Response) {
  const track = parseTrackRequest(req);
  if (!track) {
    res.status(400).json({ error: 'Invalid track ID' });
    return;
  }

  const { numericId, quality } = track;
  const t0 = Date.now();

  try {
    const { format } = await getTrackStreamInfo(numericId, quality);
    const lossless = format.toUpperCase() === 'FLAC';
    const codec = lossless ? 'flac' : 'mp3';
    const host = req.get('x-forwarded-host') || req.get('host') || 'localhost';
    const url = `${req.protocol}://${host}/audio/${numericId}?quality=${quality}`;

    res.set('Cache-Control', 'no-store');
    res.json({
      url,
      format: codec,
      codec,
      container: codec,
      quality: lossless ? 'Lossless' : 'High (320 kbps)',
      sampleRate: 44100,
      ...(lossless ? { bitDepth: 16, bitrate: 1_411_000 } : { bitrate: 320_000 }),
      encrypted: false,
    });

    console.log(`[STREAM] JSON ${numericId} | ${quality} | ${Date.now() - t0}ms`);
  } catch (error: any) {
    const message = error?.message || String(error);
    console.error(`[STREAM] resolve failed ${numericId} | ${Date.now() - t0}ms | ${message}`);

    if (/no song data|could not find track data/i.test(message)) {
      res.status(404).json({ error: 'Track not found' });
    } else {
      // The reference addon answers configuration problems with HTTP 200 and
      // an `error` field, which BitChord logs without treating it as a fault.
      res.status(200).json({ error: message });
    }
  }
}

/**
 * `GET /audio/{id}` — the actual decrypted audio, progressive and Range-aware.
 */
export async function handleAudio(req: Request, res: Response) {
  req.socket?.setNoDelay(true);

  const track = parseTrackRequest(req);
  if (!track) {
    res.status(400).send('Invalid track ID');
    return;
  }

  const { numericId, quality } = track;
  const t0 = Date.now();

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
      console.log(`[AUDIO] HEAD ${numericId} | ${Date.now() - t0}ms | ${fileSize} bytes`);
      return;
    }

    if (!range) {
      // Full file: stream progressively so playback can start immediately.
      const cdnRes = await fetch(cdnUrl);
      if (!cdnRes.ok || !cdnRes.body) {
        console.error(`[AUDIO] CDN full failed ${numericId}: HTTP ${cdnRes.status}`);
        res.status(502).send('Upstream stream unavailable');
        return;
      }

      const totalSize = Number(cdnRes.headers.get('content-length')) || fileSize;
      const totalLength = totalSize > 0 ? totalSize : 0;

      res.writeHead(200, {
        'Content-Type': contentType,
        ...(totalLength > 0 ? { 'Content-Length': totalLength } : {}),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=86400',
      });

      console.log(
        `[AUDIO] 200 ${numericId} | ${Date.now() - t0}ms | ${totalLength || 'unknown'} bytes`
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
      console.error(`[AUDIO] CDN range failed ${numericId}: HTTP ${cdnRes.status}`);
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
      `[AUDIO] 206 ${numericId} | ${Date.now() - t0}ms | ${range.start}-${range.end}/${fileSize}`
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
      `[AUDIO] ERROR ${numericId} | ${Date.now() - t0}ms | ${error?.message || error}`
    );
    if (res.headersSent) {
      res.destroy();
    } else {
      res.status(500).send('Failed to stream track');
    }
  }
}
