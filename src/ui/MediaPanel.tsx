import { ImagePlus, Music2, Plus, Settings2, Trash2, Type, Upload, Video } from 'lucide-react';
import { useEffect, useState, type MouseEvent as ReactMouseEvent, type RefObject } from 'react';
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
  usedAssetIds: Set<string>;
  onDeleteAsset: (assetId: string) => void;
  onHoverAsset: (assetId: string | null) => void;
};

type MediaContextMenu = { asset: MediaAsset; x: number; y: number };

/** Renders import controls and the current project's media asset list. */
export default function MediaPanel({ assets, mediaError, fileInputRef, projectInputRef, onImportFiles, onImportProject, onAddAsset, usedAssetIds, onDeleteAsset, onHoverAsset }: MediaPanelProps) {
  const [contextMenu, setContextMenu] = useState<MediaContextMenu | null>(null);
  const [deleteConfirmation, setDeleteConfirmation] = useState<MediaAsset | null>(null);
  const [deleteWait, setDeleteWait] = useState(5);
  const openMediaPicker = () => fileInputRef.current?.click();

  /** Closes the media context menu on an outside click or Escape. */
  useEffect(() => {
    if (!contextMenu) return;
    const close = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.media-context-menu')) return;
      setContextMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setContextMenu(null); };
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('pointerdown', close); window.removeEventListener('keydown', onKeyDown); };
  }, [contextMenu]);

  /** Requires a short countdown before removing media that is still used by timeline clips. */
  useEffect(() => {
    if (!deleteConfirmation) return;
    setDeleteWait(5);
    const timer = window.setInterval(() => setDeleteWait((seconds) => Math.max(0, seconds - 1)), 1000);
    return () => window.clearInterval(timer);
  }, [deleteConfirmation]);

  /** Opens the custom menu at the asset row under the right mouse button. */
  const openAssetMenu = (event: ReactMouseEvent<HTMLDivElement>, asset: MediaAsset) => {
    event.preventDefault();
    setContextMenu({ asset, x: Math.min(event.clientX, window.innerWidth - 220), y: Math.min(event.clientY, window.innerHeight - 100) });
  };

  /** Deletes unused media immediately, or opens the countdown for media used by clips. */
  const requestAssetDelete = (asset: MediaAsset) => {
    setContextMenu(null);
    if (usedAssetIds.has(asset.id)) setDeleteConfirmation(asset);
    else onDeleteAsset(asset.id);
  };

  return (
    <aside className="media-panel">
      <div className="panel-heading"><div><h2>Project media</h2><p>Stored in this browser</p></div><button className="small-icon-button" aria-label="Import media" onClick={openMediaPicker}><Plus size={17} /></button></div>
      <button className="import-card" onClick={openMediaPicker}><div className="upload-icon"><Upload size={18} /></div><strong>Import media</strong><span>Video, audio, or images</span></button>
      <input ref={fileInputRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={(event) => { if (event.target.files) onImportFiles(event.target.files); event.currentTarget.value = ''; }} />
      <input ref={projectInputRef} type="file" accept=".json,.neupcut.json,application/json" hidden onChange={(event) => { onImportProject(event.target.files?.[0]); event.currentTarget.value = ''; }} />
      <div className="asset-heading"><span>ASSETS</span><span>{assets.length} items</span></div>
      <div className="asset-list">{assets.map((asset) => <div className="asset-row" key={asset.id} onMouseEnter={() => onHoverAsset(asset.id)} onMouseLeave={() => onHoverAsset(null)} onContextMenu={(event) => openAssetMenu(event, asset)}><span className={`asset-thumb ${asset.kind}`}>{asset.kind === 'video' ? <Video size={16} /> : asset.kind === 'audio' ? <Music2 size={16} /> : asset.kind === 'title' ? <Type size={16} /> : <ImagePlus size={16} />}</span><span className="asset-copy"><strong>{asset.name}</strong><small>{asset.kind === 'title' ? 'Title card' : `${asset.kind} · ${formatTime(asset.duration)}`}</small></span><button className="asset-add" title="Add to timeline at playhead" onClick={() => onAddAsset(asset)}><Plus size={14} /></button></div>)}{!assets.length && <div className="empty-assets">Import media or add a title to start editing.</div>}</div>
      {contextMenu && <div className="timeline-context-menu media-context-menu" role="menu" style={{ left: contextMenu.x, top: contextMenu.y }} onContextMenu={(event) => event.preventDefault()}><button role="menuitem" onClick={() => { onAddAsset(contextMenu.asset); setContextMenu(null); }}><Plus size={14} /> Add to timeline</button><button role="menuitem" onClick={() => requestAssetDelete(contextMenu.asset)}><Trash2 size={14} /> Delete media</button></div>}
      {deleteConfirmation && <div className="modal-backdrop media-delete-backdrop"><section className="media-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="media-delete-title"><div className="media-delete-icon"><Trash2 size={18} /></div><h2 id="media-delete-title">Media is used on the timeline</h2><p><strong>{deleteConfirmation.name}</strong> is used by {usedAssetIds.has(deleteConfirmation.id) ? 'one or more clips' : 'a timeline clip'}. Deleting it will also remove those clips.</p><p className="delete-countdown">{deleteWait > 0 ? `Please wait ${deleteWait} seconds…` : 'You can now confirm deletion.'}</p><div className="media-delete-actions"><button onClick={() => setDeleteConfirmation(null)}>Cancel</button><button className="confirm-media-delete" disabled={deleteWait > 0} onClick={() => { onDeleteAsset(deleteConfirmation.id); setDeleteConfirmation(null); }}>Delete media and clips</button></div></section></div>}
      {mediaError && <div className="media-error">{mediaError}</div>}
      <div className="panel-tip"><Settings2 size={15} /><span>Projects and media autosave locally in this browser.</span></div>
    </aside>
  );
}
