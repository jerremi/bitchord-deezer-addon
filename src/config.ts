import dotenv from 'dotenv';
dotenv.config();

export const config = {
  port: parseInt(process.env.PORT || '3000', 10),
  host: process.env.HOST || '0.0.0.0',
  deezerArl: process.env.DEEZER_ARL || '',
  bitchordAuth: process.env.BITCHORD_AUTH === 'true',
};
