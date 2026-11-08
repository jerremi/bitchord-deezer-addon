import type { Request, Response } from 'express';
import { config } from '../config.js';

export function handleHealth(_req: Request, res: Response) {
  res.json({
    status: 'ok',
    version: '1.0.0',
    arlConfigured: Boolean(config.deezerArl),
    bitchordAuth: config.bitchordAuth,
  });
}
