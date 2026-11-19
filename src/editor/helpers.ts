import type { EditorProject, MediaKind } from './types';

const FRAME_RATE = 30;

/** Creates a new empty video editing project. */
export function createProject(): EditorProject {
  return { id: crypto.randomUUID(), name: 'Untitled project', updatedAt: Date.now(), assets: [], clips: [], timelineView: { zoom: 1, scrollLeft: 0 } };
}

/** Formats timeline time as minutes, seconds, and frames. */
export function formatTime(seconds: number): string {
  const safeTime = Math.max(0, seconds);
  const minutes = Math.floor(safeTime / 60).toString().padStart(2, '0');
  const remainder = Math.floor(safeTime % 60).toString().padStart(2, '0');
  const frames = Math.floor((safeTime % 1) * FRAME_RATE).toString().padStart(2, '0');
  return `${minutes}:${remainder}:${frames}`;
}

/** Loads duration metadata for a browser-supported audio or video file. */
export function readMediaDuration(file: File): Promise<number> {
  if (file.type.startsWith('image/')) return Promise.resolve(5);
  return new Promise((resolve) => {
    const media = document.createElement(file.type.startsWith('audio/') ? 'audio' : 'video');
    const source = URL.createObjectURL(file);
    media.preload = 'metadata';
    media.onloadedmetadata = () => { URL.revokeObjectURL(source); resolve(Number.isFinite(media.duration) ? media.duration : 5); };
    media.onerror = () => { URL.revokeObjectURL(source); resolve(5); };
    media.src = source;
  });
}

/** Maps a MIME type to the editor's supported media category. */
export function getMediaKind(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

/** Reads a media blob as a data URL for the portable project file. */
export function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not package project media.'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not package project media.'));
    reader.readAsDataURL(blob);
  });
}

/** Restores a project media blob from its portable data URL. */
export function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata, encoded] = dataUrl.split(',', 2);
  const mimeType = metadata.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}
