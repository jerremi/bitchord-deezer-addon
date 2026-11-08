import { config } from '../config.js';
import type { BitChordTrack } from '../types.js';

interface DeezerUserData {
  checkForm: string;
  sessionId: string;
  licenseToken: string;
  expiresAt: number;
}

interface StreamCacheEntry {
  url: string;
  format: string;
  expiresAt: number;
}

let cachedUserData: DeezerUserData | null = null;
const streamUrlCache = new Map<string, StreamCacheEntry>();

const GW_LIGHT_URL = 'https://www.deezer.com/ajax/gw-light.php';
const MEDIA_URL = 'https://media.deezer.com/v1/get_url';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36';

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
 */
async function getUserData(): Promise<DeezerUserData> {
  const now = Date.now();
  if (cachedUserData && cachedUserData.expiresAt > now) {
    return cachedUserData;
  }

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
    expiresAt: now + 45 * 60 * 1000, // 45 minutes cache
  };

  return cachedUserData;
}

/**
 * Searches Deezer catalog using the authenticated gateway API.
 */
export async function searchTracks(query: string, _quality = 'lossless'): Promise<BitChordTrack[]> {
  try {
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
    if (!items || !Array.isArray(items)) {
      return [];
    }

    return items.map((item: any) => {
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
        format: 'flac', // Deezer Premium FLAC 16-bit/44.1kHz
        artwork,
      };
    });
  } catch (error) {
    console.error('Deezer gateway search failed:', error);
    return [];
  }
}

/**
 * Resolves the raw Deezer CDN stream URL and audio format for a track.
 */
export async function getTrackStreamInfo(
  numericTrackId: string | number,
  preferredQuality = 'lossless'
): Promise<{ url: string; format: string }> {
  const cacheKey = `${numericTrackId}:${preferredQuality}`;
  const now = Date.now();
  const cached = streamUrlCache.get(cacheKey);
  if (cached && cached.expiresAt > now) {
    return { url: cached.url, format: cached.format };
  }

  const { checkForm, sessionId, licenseToken } = await getUserData();

  // 1. Fetch track metadata & track_token
  const songData = await callGateway(
    'song.getData',
    { sng_id: numericTrackId },
    checkForm,
    sessionId
  );

  if (!songData || !songData.TRACK_TOKEN) {
    throw new Error(`Could not find track data for ID ${numericTrackId}`);
  }

  const trackToken = songData.TRACK_TOKEN;

  // 2. Format priority based on quality preference
  const formatsToRequest =
    preferredQuality === 'high'
      ? [
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_320' },
          { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
        ]
      : [
          { cipher: 'BF_CBC_STRIPE', format: 'FLAC' },
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_320' },
          { cipher: 'BF_CBC_STRIPE', format: 'MP3_128' },
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
      track_tokens: [trackToken],
    }),
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
  const resolvedFormat = media?.format || 'FLAC';

  if (!streamUrl) {
    throw new Error('No stream URL returned by Deezer CDN');
  }

  const result = {
    url: streamUrl,
    format: resolvedFormat,
  };

  streamUrlCache.set(cacheKey, {
    ...result,
    expiresAt: now + 15 * 60 * 1000, // 15 min cache
  });

  return result;
}
