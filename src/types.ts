export interface AddonManifest {
  id: string;
  name: string;
  version: string;
  resources: string[];
  bitchordAuth?: boolean;
  allowDownloads?: number;
  checkValidLossless?: number;
  settings?: AddonSetting[];
}

export interface AddonSetting {
  key: string;
  type: 'select' | 'text' | 'boolean';
  default: string | number | boolean;
  options?: { label: string; value: string }[];
}

export interface BitChordTrack {
  id: string;
  title: string;
  artist: string;
  album: string;
  duration: number; // Duration in seconds (integer)
  format: 'flac' | 'mp3' | 'aac' | 'alac';
  artwork?: string;
}

export interface SearchResponse {
  tracks: BitChordTrack[];
}
