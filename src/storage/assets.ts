import type { AudioData, StoredAsset } from '../types';
import { makeId } from '../types';
import { audioData } from '../audio/dsp';
import { decodeWav, encodeWavBlob } from '../audio/wav';
import * as db from './db';

export async function storeAudioData(
  data: AudioData,
  name: string,
  kind: StoredAsset['kind'] = 'audio',
): Promise<StoredAsset> {
  const blob = encodeWavBlob(data, { bitDepth: 16, channels: data.channels.length >= 2 ? 2 : 1 });
  const asset: StoredAsset = {
    id: makeId('asset'),
    name,
    mime: 'audio/wav',
    size: blob.size,
    kind,
    blob,
    createdAt: Date.now(),
  };
  await db.saveAsset(asset);
  return asset;
}

export async function storeBlob(blob: Blob, name: string, kind: StoredAsset['kind']): Promise<StoredAsset> {
  const asset: StoredAsset = {
    id: makeId('asset'),
    name,
    mime: blob.type || 'application/octet-stream',
    size: blob.size,
    kind,
    blob,
    createdAt: Date.now(),
  };
  await db.saveAsset(asset);
  return asset;
}

const memoryCache = new Map<string, AudioData>();

export async function loadAudioData(assetId: string): Promise<AudioData> {
  const cached = memoryCache.get(assetId);
  if (cached) return cached;
  const asset = await db.getAsset(assetId);
  if (!asset) throw new Error(`Audio asset not found: ${assetId}`);
  // Assets written by storeAudioData are WAV; decode directly without creating an AudioContext.
  if (asset.mime === 'audio/wav' || asset.name.toLowerCase().endsWith('.wav')) {
    const buffer = await asset.blob.arrayBuffer();
    try {
      const data = decodeWav(buffer);
      memoryCache.set(assetId, data);
      return data;
    } catch {
      // Fall through to Web Audio decode
    }
  }
  const buffer = await asset.blob.arrayBuffer();
  const context = new (globalThis.AudioContext ?? (globalThis as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
  try {
    const decoded = await context.decodeAudioData(buffer);
    const channels = Array.from({ length: decoded.numberOfChannels }, (_, c) => new Float32Array(decoded.getChannelData(c)));
    const data = audioData(channels, decoded.sampleRate);
    memoryCache.set(assetId, data);
    return data;
  } finally {
    if (context.state !== 'closed') await context.close();
  }
}

export function cacheAudioData(assetId: string, data: AudioData): void {
  memoryCache.set(assetId, data);
}

export function evictAudioData(assetId: string): void {
  memoryCache.delete(assetId);
}

export function clearMemoryCache(): void {
  memoryCache.clear();
}
