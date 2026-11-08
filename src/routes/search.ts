import type { Request, Response } from 'express';
import { searchTracks } from '../services/deezer.js';
import type { SearchResponse } from '../types.js';

export async function handleSearch(req: Request, res: Response) {
  const query = (req.query.q as string) || '';
  const quality = (req.query.quality as string) || 'lossless';

  if (!query.trim()) {
    const emptyResponse: SearchResponse = { tracks: [] };
    res.json(emptyResponse);
    return;
  }

  try {
    const tracks = await searchTracks(query, quality);
    const response: SearchResponse = { tracks };
    res.json(response);
  } catch (error: any) {
    console.error('Search error:', error?.message || error);
    res.status(500).json({ error: 'Search failed', tracks: [] });
  }
}
