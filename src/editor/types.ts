export type MediaKind = 'video' | 'audio' | 'image' | 'title';
export type TrackKind = 'video' | 'audio';

export type ClipAnimationEffect = {
  presetId: string;
  duration: number;
};

export type ClipEffect = {
  presetId: string;
  amount: number;
};

export type MediaAsset = {
  id: string;
  name: string;
  kind: MediaKind;
  mimeType: string;
  size: number;
  duration: number;
  blob?: Blob;
};

export type TimelineClip = {
  id: string;
  assetId: string;
  name: string;
  track: TrackKind;
  start: number;
  duration: number;
  sourceStart: number;
  animation?: ClipAnimationEffect;
  effects?: ClipEffect[];
};

export type EditorProject = {
  id: string;
  name: string;
  updatedAt: number;
  assets: MediaAsset[];
  clips: TimelineClip[];
  timelineView?: { zoom: number; scrollLeft: number };
};

export type ProjectSummary = Pick<EditorProject, 'id' | 'name' | 'updatedAt'>;
