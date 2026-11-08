import type { Request, Response } from 'express';
import { config } from '../config.js';
import type { AddonManifest } from '../types.js';

export function getManifest(_req: Request, res: Response) {
  const manifest: AddonManifest = {
    id: 'dev.hiress-lossless.bitchord-addon',
    name: 'Hi-Ress Lossless (Deezer HiFi)',
    version: '1.0.0',
    resources: ['search', 'stream'],
    bitchordAuth: config.bitchordAuth,
    allowDownloads: 1,
    checkValidLossless: 0,
    settings: [
      {
        key: 'quality',
        type: 'select',
        default: 'lossless',
        options: [
          { label: 'Lossless (FLAC 16-bit/44.1kHz)', value: 'lossless' },
          { label: 'High (320kbps MP3)', value: 'high' },
        ],
      },
    ],
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-cache');
  res.json(manifest);
}
