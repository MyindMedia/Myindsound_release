import { R2 } from '@convex-dev/r2';
import { components } from '../_generated/api';
import { fail } from './errors';

export const STREAM_URL_TTL_SECONDS = 7200;
export const DOWNLOAD_URL_TTL_SECONDS = 3600;

const REQUIRED = ['R2_BUCKET', 'R2_ENDPOINT', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY'] as const;

export function r2Configured(): boolean {
  return REQUIRED.every((key) => Boolean(process.env[key]));
}

export async function signGetUrl(key: string, expiresIn: number): Promise<string> {
  if (!r2Configured()) fail('NOT_CONFIGURED', 'Audio storage is not connected yet.');
  const r2 = new R2(components.r2);
  return await r2.getUrl(key, { expiresIn });
}
