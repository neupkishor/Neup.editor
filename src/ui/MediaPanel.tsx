import { ImagePlus, Music2, Plus, Settings2, Type, Upload, Video } from 'lucide-react';
import type { RefObject } from 'react';
import { formatTime } from '../editor/helpers';
import type { MediaAsset } from '../editor/types';

type MediaPanelProps = {
  assets: MediaAsset[];
  mediaError: string;
  fileInputRef: RefObject<HTMLInputElement | null>;
  projectInputRef: RefObject<HTMLInputElement | null>;
  onImportFiles: (files: FileList) => void;
  onImportProject: (file?: File) => void;
  onAddAsset: (asset: MediaAsset) => void;
};

/** Renders import controls and the current project's media asset list. */
export default function MediaPanel({ assets, mediaError, fileInputRef, projectInputRef, onImportFiles, onImportProject, onAddAsset }: MediaPanelProps) {
  const openMediaPicker = () => fileInputRef.current?.click();

  return (
    <aside className="media-panel">
      <div className="panel-heading"><div><h2>Project media</h2><p>Stored in this browser</p></div><button className="small-icon-button" aria-label="Import media" onClick={openMediaPicker}><Plus size={17} /></button></div>
      <button className="import-card" onClick={openMediaPicker}><div className="upload-icon"><Upload size={18} /></div><strong>Import media</strong><span>Video, audio, or images</span></button>
      <input ref={fileInputRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={(event) => { if (event.target.files) onImportFiles(event.target.files); event.currentTarget.value = ''; }} />
      <input ref={projectInputRef} type="file" accept=".json,.neupcut.json,application/json" hidden onChange={(event) => { onImportProject(event.target.files?.[0]); event.currentTarget.value = ''; }} />
      <div className="asset-heading"><span>ASSETS</span><span>{assets.length} items</span></div>
      <div className="asset-list">{assets.map((asset) => <div className="asset-row" key={asset.id}><span className={`asset-thumb ${asset.kind}`}>{asset.kind === 'video' ? <Video size={16} /> : asset.kind === 'audio' ? <Music2 size={16} /> : asset.kind === 'title' ? <Type size={16} /> : <ImagePlus size={16} />}</span><span className="asset-copy"><strong>{asset.name}</strong><small>{asset.kind === 'title' ? 'Title card' : `${asset.kind} · ${formatTime(asset.duration)}`}</small></span><button className="asset-add" title="Add to timeline at playhead" onClick={() => onAddAsset(asset)}><Plus size={14} /></button></div>)}{!assets.length && <div className="empty-assets">Import media or add a title to start editing.</div>}</div>
      {mediaError && <div className="media-error">{mediaError}</div>}
      <div className="panel-tip"><Settings2 size={15} /><span>Projects and media autosave locally in this browser.</span></div>
    </aside>
  );
}
