import { config } from '../config.js';
import type { BitChordTrack } from '../types.js';
import { CHUNK_SIZE, decryptDeezerBuffer } from './decrypt.js';

interface DeezerUserData {
  checkForm: string;
  sessionId: string;
  licenseToken: string;
  expiresAt: number;
}

export interface StreamInfo {
  url: string;
  format: string;
  fileSize: number;
  sampleRate: number;
  bitDepth: number;
}

interface StreamCacheEntry extends StreamInfo {
  expiresAt: number;
}

// Deezer exposes the exact encrypted file size in song.getData, so resolving a
// stream URL never needs an extra HEAD round-trip.
const FILE_SIZE_FIELDS: Record<string, string> = {
  FLAC_24: 'FILESIZE_FLAC_24',
  FLAC: 'FILESIZE_FLAC',
  MP3_320: 'FILESIZE_MP3_320',
  MP3_256: 'FILESIZE_MP3_256',
  MP3_128: 'FILESIZE_MP3_128',
  MP3_64: 'FILESIZE_MP3_64',
  AAC_64: 'FILESIZE_AAC_64',
};

const METADATA_TIMEOUT_MS = 15_000;

let cachedUserData: DeezerUserData | null = null;
let userDataPromise: Promise<DeezerUserData> | null = null;
const streamInfoCache = new Map<string, StreamCacheEntry>();
const streamInfoInflight = new Map<string, Promise<StreamInfo>>();

const GW_LIGHT_URL = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

function normalizeQuality(quality: string): 'lossless' | 'high' {
  return quality === 'high' ? 'high' : 'lossless';
}

/**
 * Calls Deezer's internal gw-light.php gateway.
 */
async function callGateway(
  method: string,
  params: Record<string, unknown>,
  checkForm = '',
  sessionId = ''
): Promise<any> {
  if (!config.deezerArl) {
    throw new Error('DEEZER_ARL is not configured. Please add your ARL in .env');
  }

  const url = new URL(GW_LIGHT_URL);
  url.searchParams.set('method', method);
  url.searchParams.set('api_version', '1.0');
  url.searchParams.set('api_token', checkForm);
  url.searchParams.set('input', '3');

  const cookieHeader = sessionId
    ? `arl=${config.deezerArl}; sid=${sessionId}`
    : `arl=${config.deezerArl}`;

  const res = await fetch(url.toString(), {
    method: 'POST',
    headers: {
      Cookie: cookieHeader,
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`Gateway ${method} HTTP error: ${res.status}`);
  }

  const json = (await res.json()) as {
    error?: Record<string, unknown>;
    results?: any;
  };

  if (json.error && Object.keys(json.error).length > 0) {
    throw new Error(`Gateway error (${method}): ${JSON.stringify(json.error)}`);
  }

  return json.results;
}

/**
 * Retrieves and caches the session checkForm, sessionId, and licenseToken.
 * Concurrent callers share one in-flight request.
 */
async function getUserData(): Promise<DeezerUserData> {
  const now = Date.now();
  if (cachedUserData && cachedUserData.expiresAt > now) {
    return cachedUserData;
  }
  if (userDataPromise) return userDataPromise;

  userDataPromise = (async () => {
    const results = await callGateway('deezer.getUserData', {});
    if (!results) {
      throw new Error('Failed to retrieve Deezer user data. Check your DEEZER_ARL.');
    }

    const checkForm = results.checkForm || results.check_form_key || '';
    const sessionId = results.SESSION_ID || '';
    const licenseToken =
      results.USER?.OPTIONS?.license_token || results.USER?.license_token || '';

    if (!licenseToken) {
      throw new Error(
        'Could not find license_token in user data. Ensure your ARL belongs to an active Deezer account.'
      );
    }

    cachedUserData = {
      checkForm,
      sessionId,
      licenseToken,
      expiresAt: Date.now() + 45 * 60 * 1000,
    };

    return cachedUserData;
  })().finally(() => {
    userDataPromise = null;
  });

  return userDataPromise;
}

/**
 * Searches Deezer catalog using the authenticated gateway API.
 * Top results are pre-resolved in the background to minimize /stream latency.
 */
export async function searchTracks(query: string, quality = 'lossless'): Promise<BitChordTrack[]> {
  try {
    const normalizedQuality = normalizeQuality(quality);
    const { checkForm, sessionId } = await getUserData();
    const results = await callGateway(
      'search.music',
      {
        QUERY: query,
        FILTER: 0,
        OUTPUT: 'TRACK',
        NB: 25,
      },
      checkForm,
      sessionId
    );

    const items = results?.data;
    if (!Array.isArray(items)) {
      return [];
    }

    const tracks: BitChordTrack[] = items.map((item: any) => {
      const artId = item.ALB_PICTURE;
      const artwork = artId
        ? `https://e-cdns-images.dzcdn.net/images/cover/${artId}/500x500-000000-80-0-0.jpg`
        : undefined;

      return {
        id: `deezer:${item.SNG_ID}`,
        title: item.SNG_TITLE,
        artist: item.ART_NAME,
        album: item.ALB_TITLE,
        duration: Math.round(Number(item.DURATION) || 0),
        format: normalizedQuality === 'high' ? 'mp3' : 'flac',
        audioQuality:
          normalizedQuality === 'high'
            ? 'HIGH'
            : Number(item.FILESIZE_FLAC_24) > 0
              ? 'HI_RES_LOSSLESS'
              : 'LOSSLESS',
        artworkURL: artwork,
      };
    });

    // Fire-and-forget URL pre-warm; failures are irrelevant to search results.
    void Promise.allSettled(
      tracks
        .slice(0, 5)
        .map((track) =>
          getTrackStreamInfo(track.id.replace(/^deezer:/i, ''), normalizedQuality)
        )
    );

    return tracks;
  } catch (error) {
    console.error('Deezer gateway search failed:', error);
    return [];
  }
}

async function getRemoteFileSize(url: string): Promise<number> {
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    return Number(res.headers.get('content-length')) || 0;
  } catch {
    return 0;
  }
}

/**
 * Reads the FLAC STREAMINFO header to learn the real resolution. The first
 * 2048-byte stripe is Blowfish-encrypted like every stripe at index 0, so it
 * is decrypted here with the same routine used for playback.
 */
async function probeFlacFormat(
  url: string,
  trackId: string | number
): Promise<{ sampleRate: number; bitDepth: number } | null> {
  try {
    const res = await fetch(url, {
      headers: { Range: `bytes=0-${CHUNK_SIZE - 1}` },
      signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
    });
    if (!res.ok) return null;

    let encrypted: Buffer;
    if (res.status === 206) {
      encrypted = Buffer.from(await res.arrayBuffer());
    } else if (res.body) {
      // A CDN that ignored Range would otherwise make us download the track.
      const reader = res.body.getReader();
      const parts: Buffer[] = [];
      let total = 0;
      while (total < CHUNK_SIZE) {
        const { done, value } = await reader.read();
        if (done) break;
        if (!value) continue;
        parts.push(Buffer.from(value));
        total += value.length;
      }
      try {
        await reader.cancel();
      } catch {
        // Stream already closed.
      }
      encrypted = Buffer.concat(parts).subarray(0, CHUNK_SIZE);
    } else {
      return null;
    }

    if (encrypted.length < 42) return null;

    const head = decryptDeezerBuffer(encrypted, trackId, 0);
    if (head.subarray(0, 4).toString('ascii') !== 'fLaC') return null;

    let offset = 4;
    const blockType = head[offset] & 0x7f;
    const blockLength = (head[offset + 1] << 16) | (head[offset + 2] << 8) | head[offset + 3];
    if (blockType !== 0 || blockLength < 34 || head.length < offset + 4 + 34) return null;

    offset += 4;
    const info = head.subarray(offset + 10, offset + 18);
    const sampleRate = (info[0] << 12) | (info[1] << 4) | (info[2] >> 4);
    const bitDepth = (((info[2] & 1) << 4) | (info[3] >> 4)) + 1;

    if (!sampleRate || !bitDepth) return null;
    return { sampleRate, bitDepth };
  } catch {
    return null;
  }
}

async function resolveTrackStreamInfo(
  numericTrackId: string | number,
  quality: 'lossless' | 'high'
): Promise<StreamInfo> {
  const { checkForm, sessionId, licenseToken } = await getUserData();

  // 1. Track metadata & track_token
  const songData = await callGateway(
    'song.getData',
    { sng_id: numericTrackId },
    checkForm,
    sessionId
  );

  if (!songData?.TRACK_TOKEN) {
    throw new Error(`Could not find track data for ID ${numericTrackId}`);
  }

  // 2. Format priority based on quality preference. Lossless means lossless:
  //    when Deezer has neither 24-bit nor 16-bit FLAC, this returns no stream
  //    so BitChord can fall back to another source (including one offering
  //    Dolby Atmos) instead of silently playing a 320kbps transcode.
  const formatsToRequest =
    quality === 'high'
      ? [
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_320' },
          { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
        ]
      : [
          { cipher: 'BF_CBC_STRIPE', format: 'FLAC_24' },
          { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
        ];

  // 3. Request direct CDN stream URL from media.deezer.com
  const mediaRes = await fetch(MEDIA_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': USER_AGENT,
    },
    body: JSON.stringify({
      license_token: licenseToken,
      media: [
        {
          type: 'FULL',
          formats: formatsToRequest,
        },
      ],
      track_tokens: [songData.TRACK_TOKEN],
    }),
    signal: AbortSignal.timeout(METADATA_TIMEOUT_MS),
  });

  if (!mediaRes.ok) {
    throw new Error(`media.deezer.com request failed: ${mediaRes.status}`);
  }

  const mediaJson = (await mediaRes.json()) as {
    data?: Array<{
      errors?: Array<{ code: number; message: string }>;
      media?: Array<{
        format: string;
        sources?: Array<{ url: string }>;
      }>;
    }>;
  };

  const trackData = mediaJson.data?.[0];
  if (trackData?.errors && trackData.errors.length > 0) {
    throw new Error(`Media error: ${trackData.errors[0].message}`);
  }

  const media = trackData?.media?.[0];
  const streamUrl = media?.sources?.[0]?.url;
  const resolvedFormat = media?.format || formatsToRequest[0].format;

  if (!streamUrl) {
    throw new Error(
      quality === 'lossless'
        ? 'No lossless stream available for this track'
        : 'No stream URL returned by Deezer CDN'
    );
  }

  const sizeField = FILE_SIZE_FIELDS[resolvedFormat];
  let fileSize = Number(sizeField ? songData[sizeField] : 0) || 0;
  if (!fileSize) {
    fileSize = await getRemoteFileSize(streamUrl);
  }

  const lossless = resolvedFormat === 'FLAC' || resolvedFormat === 'FLAC_24';
  const defaults =
    resolvedFormat === 'FLAC_24'
      ? { sampleRate: 44100, bitDepth: 24 }
      : { sampleRate: 44100, bitDepth: 16 };
  const resolution = lossless
    ? (await probeFlacFormat(streamUrl, numericTrackId)) ?? defaults
    : defaults;

  return { url: streamUrl, format: resolvedFormat, fileSize, ...resolution };
}

/**
 * Resolves the raw Deezer CDN stream URL, audio format, and file size.
 * Results (and concurrent requests for the same track) are cached for 15 min.
 */
export function getTrackStreamInfo(
  numericTrackId: string | number,
  preferredQuality = 'lossless'
): Promise<StreamInfo> {
  const quality = normalizeQuality(preferredQuality);
  const cacheKey = `${numericTrackId}:${quality}`;
  const now = Date.now();

  const cached = streamInfoCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return Promise.resolve(cached);
  }
  if (cached) streamInfoCache.delete(cacheKey);

  const inflight = streamInfoInflight.get(cacheKey);
  if (inflight) return inflight;

  const promise = resolveTrackStreamInfo(numericTrackId, quality)
    .then((info) => {
      streamInfoCache.set(cacheKey, {
        ...info,
        expiresAt: Date.now() + 15 * 60 * 1000,
      });
      return info;
    })
    .finally(() => {
      streamInfoInflight.delete(cacheKey);
    });

  streamInfoInflight.set(cacheKey, promise);
  return promise;
}
