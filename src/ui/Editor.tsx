import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AudioLines, Check, Clapperboard, Download, FilePlus2, Film, FolderOpen, ImagePlus, Music2, Pause, Play, Plus, Save, Scissors, Settings2, Trash2, Type, Upload, Video, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import { deleteProject, listProjects, loadProject, saveProject } from '../editor/storage';
import type { EditorProject, MediaAsset, MediaKind, ProjectSummary, TimelineClip, TrackKind } from '../editor/types';

const PROJECT_KEY = 'neupcut-current-project';
const PIXELS_PER_SECOND = 12;
const FRAME_RATE = 30;

type DragState = { clipId: string; mode: 'move' | 'left' | 'right'; pointerX: number; start: number; duration: number; sourceStart: number; maxDuration: number; track: TrackKind };

/** Creates a new empty video editing project. */
function createProject(): EditorProject {
  return { id: crypto.randomUUID(), name: 'Untitled project', updatedAt: Date.now(), assets: [], clips: [] };
}

/** Formats timeline time as minutes, seconds, and frames. */
function formatTime(seconds: number): string {
  const safeTime = Math.max(0, seconds);
  const minutes = Math.floor(safeTime / 60).toString().padStart(2, '0');
  const remainder = Math.floor(safeTime % 60).toString().padStart(2, '0');
  const frames = Math.floor((safeTime % 1) * FRAME_RATE).toString().padStart(2, '0');
  return `${minutes}:${remainder}:${frames}`;
}

/** Loads duration metadata for a browser-supported audio or video file. */
function readMediaDuration(file: File): Promise<number> {
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
function getMediaKind(file: File): MediaKind | null {
  if (file.type.startsWith('video/')) return 'video';
  if (file.type.startsWith('audio/')) return 'audio';
  if (file.type.startsWith('image/')) return 'image';
  return null;
}

/** Provides a working browser based video editor with local projects and export. */
export default function Editor() {
  const [project, setProject] = useState<EditorProject>(() => createProject());
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [zoom, setZoom] = useState(1);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [mediaError, setMediaError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const timeRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const exportChunksRef = useRef<Blob[]>([]);

  const assetUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const asset of project.assets) {
      if (asset.blob) urls.set(asset.id, URL.createObjectURL(asset.blob));
    }
    return urls;
  }, [project.assets]);
  const duration = useMemo(() => project.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0), [project.clips]);
  const activeVideo = project.clips.find((clip) => clip.track === 'video' && currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const activeAudio = project.clips.find((clip) => clip.track === 'audio' && currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const activeVideoAsset = project.assets.find((asset) => asset.id === activeVideo?.assetId);
  const activeAudioAsset = project.assets.find((asset) => asset.id === activeAudio?.assetId);
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId);
  const timelineWidth = Math.max(800, (duration + 12) * PIXELS_PER_SECOND * zoom);

  /** Reclaims object URLs when the active project's assets change or unmount. */
  useEffect(() => {
    for (const oldUrl of urlsRef.current.values()) URL.revokeObjectURL(oldUrl);
    urlsRef.current = assetUrls;
    return () => { for (const url of assetUrls.values()) URL.revokeObjectURL(url); };
  }, [assetUrls]);

  /** Restores the last opened project or creates and saves a blank one. */
  useEffect(() => {
    let cancelled = false;
    const restore = async () => {
      const projectId = localStorage.getItem(PROJECT_KEY);
      const stored = projectId ? await loadProject(projectId).catch(() => undefined) : undefined;
      if (cancelled) return;
      if (stored) setProject(stored);
      else {
        const blank = createProject();
        setProject(blank);
        localStorage.setItem(PROJECT_KEY, blank.id);
        await saveProject(blank).catch(() => undefined);
      }
    };
    void restore();
    return () => { cancelled = true; };
  }, []);

  /** Saves project edits automatically and updates the saved indicator. */
  useEffect(() => {
    setSaving('saving');
    const timer = window.setTimeout(() => {
      const updated = { ...project, updatedAt: Date.now() };
      void saveProject(updated).then(() => {
        setSaving('saved');
        localStorage.setItem(PROJECT_KEY, project.id);
      }).catch(() => setSaving('error'));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [project]);

  /** Keeps the browser media elements loaded at the active clip and source time. */
  useEffect(() => {
    const video = videoRef.current;
    const videoUrl = activeVideoAsset ? assetUrls.get(activeVideoAsset.id) : undefined;
    if (video) {
      if (videoUrl && video.src !== videoUrl) video.src = videoUrl;
      if (!videoUrl) video.removeAttribute('src');
      const sourceTime = (activeVideo?.sourceStart ?? 0) + currentTime - (activeVideo?.start ?? 0);
      if (videoUrl && Math.abs(video.currentTime - sourceTime) > 0.35) video.currentTime = Math.max(0, sourceTime);
      if (playing && videoUrl) void video.play().catch(() => undefined);
      else video.pause();
    }
    const audio = audioRef.current;
    const audioUrl = activeAudioAsset ? assetUrls.get(activeAudioAsset.id) : undefined;
    if (audio) {
      if (audioUrl && audio.src !== audioUrl) audio.src = audioUrl;
      if (!audioUrl) audio.removeAttribute('src');
      const sourceTime = (activeAudio?.sourceStart ?? 0) + currentTime - (activeAudio?.start ?? 0);
      if (audioUrl && Math.abs(audio.currentTime - sourceTime) > 0.35) audio.currentTime = Math.max(0, sourceTime);
      if (playing && audioUrl) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  }, [activeAudio, activeAudioAsset, activeVideo, activeVideoAsset, assetUrls, currentTime, playing]);

  /** Draws the active clip into the canvas used by both preview and export. */
  useEffect(() => {
    let animation = 0;
    const draw = () => {
      const canvas = canvasRef.current;
      const context = canvas?.getContext('2d');
      if (!canvas || !context) return;
      context.fillStyle = '#0e1015';
      context.fillRect(0, 0, canvas.width, canvas.height);
      const active = project.clips.find((clip) => clip.track === 'video' && currentTime >= clip.start && currentTime < clip.start + clip.duration);
      const asset = project.assets.find((item) => item.id === active?.assetId);
      if (!active || !asset) {
        drawWelcomeCard(context, canvas.width, canvas.height, project.name);
      } else if (asset.kind === 'title') {
        drawTitleCard(context, canvas.width, canvas.height, active.name);
      } else if (asset.kind === 'image' && imageRef.current?.complete && imageRef.current.naturalWidth) {
        drawContained(context, imageRef.current, canvas.width, canvas.height);
      } else if (asset.kind === 'video' && videoRef.current?.readyState && videoRef.current.readyState >= 2) {
        drawContained(context, videoRef.current, canvas.width, canvas.height);
      }
      animation = requestAnimationFrame(draw);
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [currentTime, project.assets, project.clips, project.name]);

  /** Advances the playhead with wall clock time and stops at the sequence end. */
  useEffect(() => {
    if (!playing) return;
    let animation = 0;
    let previous = performance.now();
    let lastPaint = previous;
    const tick = (now: number) => {
      const nextTime = timeRef.current + (now - previous) / 1000;
      previous = now;
      if (nextTime >= duration) {
        timeRef.current = duration;
        setCurrentTime(duration);
        setPlaying(false);
        if (exporting) recorderRef.current?.stop();
        return;
      }
      timeRef.current = nextTime;
      if (now - lastPaint > 32) { setCurrentTime(nextTime); lastPaint = now; }
      animation = requestAnimationFrame(tick);
    };
    animation = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animation);
  }, [duration, exporting, playing]);

  /** Updates the playhead from a seek, timeline click, or keyboard action. */
  const seekTo = useCallback((time: number) => {
    const next = Math.max(0, Math.min(duration, time));
    timeRef.current = next;
    setCurrentTime(next);
  }, [duration]);

  /** Adds imported files to the bin and places each on the matching timeline track. */
  const importFiles = useCallback(async (files: FileList | File[]) => {
    const imported: MediaAsset[] = [];
    const added: TimelineClip[] = [];
    let nextVideoStart = project.clips.filter((clip) => clip.track === 'video').reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    let nextAudioStart = project.clips.filter((clip) => clip.track === 'audio').reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    for (const file of Array.from(files)) {
      const kind = getMediaKind(file);
      if (!kind) continue;
      const mediaDuration = await readMediaDuration(file);
      const id = crypto.randomUUID();
      const asset: MediaAsset = { id, name: file.name, kind, mimeType: file.type, size: file.size, duration: mediaDuration, blob: file };
      imported.push(asset);
      const track: TrackKind = kind === 'audio' ? 'audio' : 'video';
      const start = track === 'audio' ? nextAudioStart : nextVideoStart;
      added.push({ id: crypto.randomUUID(), assetId: id, name: file.name, track, start, duration: Math.max(0.5, mediaDuration), sourceStart: 0 });
      if (track === 'audio') nextAudioStart += mediaDuration;
      else nextVideoStart += mediaDuration;
    }
    if (imported.length) {
      setProject((current) => ({ ...current, assets: [...current.assets, ...imported], clips: [...current.clips, ...added] }));
      setSelectedClipId(added[0].id);
    }
    if (imported.length < files.length) setMediaError('Some files were skipped. Import audio, video, or image files supported by your browser.');
    else setMediaError('');
  }, [project.clips]);

  /** Creates a text card and places it at the current playhead position. */
  const addTitle = useCallback(() => {
    const asset: MediaAsset = { id: crypto.randomUUID(), name: 'Your title', kind: 'title', mimeType: 'text/plain', size: 0, duration: 5 };
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track: 'video', start: currentTime, duration: 5, sourceStart: 0 };
    setProject((current) => ({ ...current, assets: [...current.assets, asset], clips: [...current.clips, clip] }));
    setSelectedClipId(clip.id);
  }, [currentTime]);

  /** Adds another instance of an existing media asset at the playhead. */
  const addAssetToTimeline = useCallback((asset: MediaAsset) => {
    const track: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track, start: currentTime, duration: Math.max(0.5, asset.duration), sourceStart: 0 };
    setProject((current) => ({ ...current, clips: [...current.clips, clip] }));
    setSelectedClipId(clip.id);
  }, [currentTime]);

  /** Starts or pauses native playback at the current timeline position. */
  const togglePlayback = useCallback(() => {
    if (!playing && currentTime >= duration && duration > 0) seekTo(0);
    setPlaying((value) => !value);
  }, [currentTime, duration, playing, seekTo]);

  /** Opens a saved project from local IndexedDB storage. */
  const openProject = useCallback(async (id: string) => {
    const stored = await loadProject(id);
    if (!stored) return;
    setPlaying(false);
    timeRef.current = 0;
    setCurrentTime(0);
    setSelectedClipId(null);
    setProject(stored);
    localStorage.setItem(PROJECT_KEY, id);
    setShowProjects(false);
  }, []);

  /** Creates and opens a fresh project without removing saved projects. */
  const newProject = useCallback(() => {
    const fresh = createProject();
    setPlaying(false);
    timeRef.current = 0;
    setCurrentTime(0);
    setProject(fresh);
    setSelectedClipId(null);
    localStorage.setItem(PROJECT_KEY, fresh.id);
  }, []);

  /** Refreshes the saved project list before displaying the project picker. */
  const showProjectPicker = useCallback(async () => {
    const projects = await listProjects().catch(() => []);
    setProjectList(projects);
    setShowProjects(true);
  }, []);

  /** Serializes project media into a portable JSON project download. */
  const exportProjectFile = useCallback(async () => {
    const assets = await Promise.all(project.assets.map(async ({ blob, ...asset }) => ({ ...asset, blobData: blob ? await blobToDataUrl(blob) : undefined })));
    const archive = new Blob([JSON.stringify({ format: 'neupcut-project', version: 1, project: { ...project, assets } })], { type: 'application/json' });
    const archiveUrl = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.href = archiveUrl;
    link.download = `${project.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'project'}.neupcut.json`;
    link.click();
    URL.revokeObjectURL(archiveUrl);
  }, [project]);

  /** Imports a portable project JSON file and restores its embedded media. */
  const importProjectFile = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      const archive = JSON.parse(await file.text()) as { format?: string; version?: number; project?: Omit<EditorProject, 'assets'> & { assets: Array<Omit<MediaAsset, 'blob'> & { blobData?: string }> } };
      if (archive.format !== 'neupcut-project' || archive.version !== 1 || !archive.project?.id || !Array.isArray(archive.project.assets) || !Array.isArray(archive.project.clips)) throw new Error('That file is not a supported Neup Cut project.');
      const restored: EditorProject = { ...archive.project, assets: archive.project.assets.map(({ blobData, ...asset }) => ({ ...asset, blob: blobData ? dataUrlToBlob(blobData) : undefined })) };
      setProject(restored);
      setSelectedClipId(null);
      timeRef.current = 0;
      setCurrentTime(0);
      setPlaying(false);
      localStorage.setItem(PROJECT_KEY, restored.id);
      setMediaError('');
      setShowProjects(false);
    } catch (error) {
      setMediaError(error instanceof Error ? error.message : 'Could not import that project file.');
      setShowProjects(false);
    }
  }, []);

  /** Removes the selected clip from the project timeline. */
  const removeSelectedClip = useCallback(() => {
    if (!selectedClipId) return;
    setProject((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== selectedClipId) }));
    setSelectedClipId(null);
  }, [selectedClipId]);

  /** Starts moving or trimming a clip based on the pointer target. */
  const beginClipDrag = (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, mode: DragState['mode']) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(clip.id);
    const asset = project.assets.find((item) => item.id === clip.assetId);
    dragRef.current = { clipId: clip.id, mode, pointerX: event.clientX, start: clip.start, duration: clip.duration, sourceStart: clip.sourceStart, maxDuration: asset?.duration ?? Number.POSITIVE_INFINITY, track: clip.track };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Moves the active clip or adjusts its source in and duration while dragging. */
  const updateClipDrag = (event: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = Math.round(((event.clientX - drag.pointerX) / (PIXELS_PER_SECOND * zoom)) * FRAME_RATE) / FRAME_RATE;
    setProject((current) => ({ ...current, clips: current.clips.map((clip) => {
      if (clip.id !== drag.clipId) return clip;
      if (drag.mode === 'move') return { ...clip, start: Math.max(0, Math.round((drag.start + delta) * FRAME_RATE) / FRAME_RATE) };
      if (drag.mode === 'left') {
        const shift = Math.max(-drag.sourceStart, Math.min(Math.min(drag.duration - 0.25, drag.maxDuration - drag.sourceStart - 0.25), delta));
        return { ...clip, start: Math.max(0, drag.start + shift), duration: Math.max(0.25, drag.duration - shift), sourceStart: Math.max(0, drag.sourceStart + shift) };
      }
      return { ...clip, duration: Math.max(0.25, Math.min(drag.maxDuration - drag.sourceStart, drag.duration + delta)) };
    }) }));
  };

  /** Completes a pointer driven clip move or trim operation. */
  const endClipDrag = () => { dragRef.current = null; };

  /** Records the canvas preview and active audio track to a downloadable WebM. */
  const exportVideo = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !duration) return;
    if (!('MediaRecorder' in window) || !canvas.captureStream) { setMediaError('Video export is not supported by this browser.'); return; }
    const stream = canvas.captureStream(30);
    const video = videoRef.current as (HTMLVideoElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }) | null;
    const videoStream = video?.captureStream?.() ?? video?.mozCaptureStream?.();
    videoStream?.getAudioTracks().forEach((track) => stream.addTrack(track));
    const audio = audioRef.current as (HTMLAudioElement & { captureStream?: () => MediaStream; mozCaptureStream?: () => MediaStream }) | null;
    const audioStream = audio?.captureStream?.() ?? audio?.mozCaptureStream?.();
    audioStream?.getAudioTracks().forEach((track) => stream.addTrack(track));
    const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm';
    const recorder = new MediaRecorder(stream, { mimeType });
    recorderRef.current = recorder;
    exportChunksRef.current = [];
    recorder.ondataavailable = (event) => { if (event.data.size) exportChunksRef.current.push(event.data); };
    recorder.onstop = () => {
      const blob = new Blob(exportChunksRef.current, { type: mimeType });
      const downloadUrl = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = `${project.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'video'}.webm`;
      link.click();
      URL.revokeObjectURL(downloadUrl);
      stream.getTracks().forEach((track) => track.stop());
      setExporting(false);
    };
    setMediaError('');
    setExporting(true);
    seekTo(0);
    recorder.start(250);
    setPlaying(true);
  }, [duration, project.name, seekTo]);

  /** Draws an image or video source centered while keeping its aspect ratio. */
  function drawContained(context: CanvasRenderingContext2D, source: CanvasImageSource & { width?: number; height?: number; videoWidth?: number; videoHeight?: number; naturalWidth?: number; naturalHeight?: number }, width: number, height: number) {
    const sourceWidth = source.videoWidth || source.naturalWidth || source.width || width;
    const sourceHeight = source.videoHeight || source.naturalHeight || source.height || height;
    const scale = Math.min(width / sourceWidth, height / sourceHeight);
    const drawWidth = sourceWidth * scale;
    const drawHeight = sourceHeight * scale;
    context.drawImage(source, (width - drawWidth) / 2, (height - drawHeight) / 2, drawWidth, drawHeight);
  }

  /** Draws the opening card while the timeline has no active video clip. */
  function drawWelcomeCard(context: CanvasRenderingContext2D, width: number, height: number, name: string) {
    const gradient = context.createRadialGradient(width * 0.5, height * 0.44, 12, width * 0.5, height * 0.5, height * 0.8);
    gradient.addColorStop(0, '#302147'); gradient.addColorStop(0.55, '#17151f'); gradient.addColorStop(1, '#0c0d12');
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    context.textAlign = 'center'; context.fillStyle = '#b794f6'; context.font = '500 22px sans-serif'; context.fillText('YOUR NEXT STORY', width / 2, height * 0.39);
    context.fillStyle = '#ffffff'; context.font = '700 76px sans-serif'; context.fillText(name || 'Make it move.', width / 2, height * 0.54, width * 0.86);
    context.fillStyle = '#aaa6b5'; context.font = '24px sans-serif'; context.fillText('Drop your media on the timeline to begin.', width / 2, height * 0.63);
  }

  /** Draws an editable title card into the preview and exported video. */
  function drawTitleCard(context: CanvasRenderingContext2D, width: number, height: number, title: string) {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#2e2141'); gradient.addColorStop(1, '#10141c');
    context.fillStyle = gradient; context.fillRect(0, 0, width, height);
    context.textAlign = 'center'; context.fillStyle = '#ffffff'; context.font = '700 76px sans-serif';
    context.fillText(title, width / 2, height / 2, width * 0.84);
  }

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Clapperboard size={18} /></div><span>neup<span className="brand-light">cut</span></span><span className="beta">EDITOR</span></div>
        <div className="project-name"><input aria-label="Project name" value={project.name} onChange={(event) => setProject((current) => ({ ...current, name: event.target.value }))} /><span className={`save-indicator ${saving}`} />{saving === 'saved' ? 'Saved locally' : saving === 'saving' ? 'Saving…' : 'Save failed'}</div>
        <div className="top-actions"><button className="top-action" onClick={newProject}><FilePlus2 size={15} /> New</button><button className="top-action" onClick={() => void showProjectPicker()}><FolderOpen size={15} /> Open</button><button className="icon-button" aria-label="Save project" title="Save project now" onClick={() => { setSaving('saving'); void saveProject({ ...project, updatedAt: Date.now() }).then(() => setSaving('saved')).catch(() => setSaving('error')); }}><Save size={16} /></button><button className="share-button" onClick={exportVideo} disabled={exporting || duration === 0}><Download size={15} /> {exporting ? 'Exporting…' : 'Export video'}</button></div>
      </header>

      <section className="workspace">
        <aside className="left-rail"><button className="rail-item active"><Film size={18} /><span>Media</span></button><button className="rail-item" onClick={addTitle}><Type size={18} /><span>Text</span></button><button className="rail-item" onClick={addTitle}><Plus size={18} /><span>Title</span></button><button className="rail-item" onClick={() => fileInputRef.current?.click()}><AudioLines size={18} /><span>Audio</span></button></aside>

        <aside className="media-panel">
          <div className="panel-heading"><div><h2>Project media</h2><p>Stored in this browser</p></div><button className="small-icon-button" aria-label="Import media" onClick={() => fileInputRef.current?.click()}><Plus size={17} /></button></div>
          <button className="import-card" onClick={() => fileInputRef.current?.click()}><div className="upload-icon"><Upload size={18} /></div><strong>Import media</strong><span>Video, audio, or images</span></button>
          <input ref={fileInputRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={(event) => { if (event.target.files) void importFiles(event.target.files); event.currentTarget.value = ''; }} />
          <input ref={projectInputRef} type="file" accept=".json,.neupcut.json,application/json" hidden onChange={(event) => { void importProjectFile(event.target.files?.[0]); event.currentTarget.value = ''; }} />
          <div className="asset-heading"><span>ASSETS</span><span>{project.assets.length} items</span></div>
          <div className="asset-list">{project.assets.map((asset) => <div className="asset-row" key={asset.id}><span className={`asset-thumb ${asset.kind}`}>{asset.kind === 'video' ? <Video size={16} /> : asset.kind === 'audio' ? <Music2 size={16} /> : asset.kind === 'title' ? <Type size={16} /> : <ImagePlus size={16} />}</span><span className="asset-copy"><strong>{asset.name}</strong><small>{asset.kind === 'title' ? 'Title card' : `${asset.kind} · ${formatTime(asset.duration)}`}</small></span><button className="asset-add" title="Add to timeline at playhead" onClick={() => addAssetToTimeline(asset)}><Plus size={14} /></button></div>)}{!project.assets.length && <div className="empty-assets">Import media or add a title to start editing.</div>}</div>
          {mediaError && <div className="media-error">{mediaError}</div>}
          <div className="panel-tip"><Settings2 size={15} /><span>Projects and media autosave locally in this browser.</span></div>
        </aside>

        <section className="preview-area">
          <div className="preview-header"><div className="preview-label"><span className="live-dot" /> CANVAS PREVIEW</div><div className="preview-resolution">1280 × 720 <span>·</span> {formatTime(currentTime)}</div></div>
          <div className="preview-stage"><div className="player-frame"><canvas ref={canvasRef} width={1280} height={720} /><video ref={videoRef} playsInline hidden /><audio ref={audioRef} hidden /><img ref={imageRef} src={activeVideoAsset?.kind === 'image' ? assetUrls.get(activeVideoAsset.id) : undefined} hidden onLoad={() => setCurrentTime((time) => time)} /></div></div>
          <div className="transport"><div className="time-readout"><span>{formatTime(currentTime)}</span><span className="time-divider">/</span><span className="time-total">{formatTime(duration)}</span></div><button className="play-button" onClick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><div className="transport-right"><button className="icon-button" aria-label="Audio volume"><Volume2 size={17} /></button><button className="quality-button">30 FPS <span>·</span> 720p</button></div></div>
        </section>

        <aside className="properties-panel"><div className="panel-heading"><div><h2>Clip properties</h2><p>{selectedClip?.name ?? 'Select a clip on the timeline'}</p></div><Scissors size={17} className="muted-icon" /></div>{selectedClip ? <div className="properties-content"><label className="field-label">CLIP NAME<input value={selectedClip.name} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, name: event.target.value } : clip) }))} /></label><div className="property-grid"><label className="field-label">START<input type="number" min="0" step="0.1" value={selectedClip.start.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, start: Math.max(0, Number(event.target.value)) } : clip) }))} /></label><label className="field-label">DURATION<input type="number" min="0.25" step="0.1" value={selectedClip.duration.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, duration: Math.max(0.25, Number(event.target.value)) } : clip) }))} /></label></div><label className="field-label">TRACK<select value={selectedClip.track} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, track: event.target.value as TrackKind } : clip) }))}><option value="video">Video 1</option><option value="audio">Audio 1</option></select></label><button className="delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button></div> : <div className="properties-empty"><span className="property-preview-icon"><Scissors size={22} /></span>Click a timeline clip to edit its name, start, duration, or track.</div>}</aside>
      </section>

      <section className="timeline-section">
        <div className="timeline-toolbar"><div className="timeline-tools"><button className="tool-button selected" title="Select and move clips"><span className="cursor-icon">↖</span></button><button className="tool-button" title="Split clip at playhead" onClick={() => { const clip = project.clips.find((item) => item.track === 'video' && currentTime > item.start && currentTime < item.start + item.duration); if (!clip) return; const firstDuration = currentTime - clip.start; const second: TimelineClip = { ...clip, id: crypto.randomUUID(), start: currentTime, sourceStart: clip.sourceStart + firstDuration, duration: clip.duration - firstDuration }; setProject((current) => ({ ...current, clips: [...current.clips.map((item) => item.id === clip.id ? { ...item, duration: firstDuration } : item), second] })); setSelectedClipId(second.id); }}><Scissors size={15} /></button><span className="toolbar-separator" /><button className="tool-button" onClick={addTitle} title="Add title"><Type size={15} /></button><button className="tool-button" onClick={removeSelectedClip} title="Delete selected clip"><Trash2 size={15} /></button></div><div className="timeline-center">Timeline <span className="timeline-duration">{formatTime(duration)}</span></div><div className="zoom-control"><button className="tool-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}><ZoomOut size={15} /></button><input type="range" min="0.5" max="2" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button className="tool-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(2, value + 0.15))}><ZoomIn size={15} /></button></div></div>
        <div className="timeline-body"><div className="track-labels"><div className="ruler-spacer" /><div className="track-label"><Video size={15} /><span>Video 1</span><span className="track-menu">···</span></div><div className="track-label"><Music2 size={15} /><span>Audio 1</span><span className="track-menu">···</span></div></div><div className="timeline-scroll"><div className="timeline-inner" style={{ width: timelineWidth }} onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('ruler')) { const bounds = event.currentTarget.getBoundingClientRect(); seekTo(Math.max(0, (event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom))); } }}><div className="ruler">{Array.from({ length: Math.ceil(duration / 5) + 3 }, (_, index) => <button className="ruler-tick" key={index} style={{ left: `${index * 5 * PIXELS_PER_SECOND * zoom}px` }} onClick={() => seekTo(index * 5)}>{`00:${String(index * 5).padStart(2, '0')}`}</button>)}</div>{(['video', 'audio'] as const).map((track) => <div key={track} className={`track-lane ${track}-lane`} onPointerDown={(event) => { if (event.target === event.currentTarget) seekTo(Math.max(0, (event.clientX - event.currentTarget.getBoundingClientRect().left) / (PIXELS_PER_SECOND * zoom))); }}>{project.clips.filter((clip) => clip.track === track).map((clip) => { const asset = project.assets.find((item) => item.id === clip.assetId); return <button key={clip.id} className={`timeline-clip ${asset?.kind ?? 'video'} ${selectedClipId === clip.id ? 'selected-clip' : ''}`} style={{ left: `${clip.start * PIXELS_PER_SECOND * zoom}px`, width: `${Math.max(28, clip.duration * PIXELS_PER_SECOND * zoom)}px` }} onPointerDown={(event) => beginClipDrag(event, clip, 'move')} onPointerMove={updateClipDrag} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}><span className="trim-handle left" title="Trim start" onPointerDown={(event) => beginClipDrag(event, clip, 'left')} onPointerMove={updateClipDrag} onPointerUp={endClipDrag} /><strong>{track === 'audio' && <Music2 size={11} />} {clip.name}</strong><small>{formatTime(clip.duration)}</small><span className="trim-handle right" title="Trim end" onPointerDown={(event) => beginClipDrag(event, clip, 'right')} onPointerMove={updateClipDrag} onPointerUp={endClipDrag} /></button>; })}</div>)}<button className="playhead" style={{ left: `${currentTime * PIXELS_PER_SECOND * zoom}px` }} aria-label="Seek playhead" onPointerDown={(event) => { event.stopPropagation(); (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (event.buttons) { const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); seekTo((event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom)); } }} /></div></div></div>
        <div className="timeline-footer"><span><span className="kbd">Drag</span> to move · edge handles to trim · click ruler to seek</span><span>{project.clips.length} clips · Autosaved to this browser {saving === 'saved' && <Check size={11} />}</span></div>
      </section>

      {showProjects && <div className="modal-backdrop" onClick={() => setShowProjects(false)}><section className="project-modal" onClick={(event) => event.stopPropagation()}><header><div><h2>Open a project</h2><p>Open a local project or import a portable project file.</p></div><button className="small-icon-button" onClick={() => setShowProjects(false)}>×</button></header><div className="project-modal-actions"><button className="new-project-row" onClick={() => { newProject(); setShowProjects(false); }}><FilePlus2 size={17} /> Create a new project</button><button className="new-project-row" onClick={() => projectInputRef.current?.click()}><Upload size={16} /> Import project file</button><button className="new-project-row" onClick={() => void exportProjectFile()}><Download size={16} /> Download project file</button></div>{projectList.map((item) => <div className="project-row" key={item.id}><button onClick={() => void openProject(item.id)}><Clapperboard size={16} /><span><strong>{item.name}</strong><small>Edited {new Date(item.updatedAt).toLocaleString()}</small></span></button>{item.id !== project.id && <button className="project-delete" title="Delete project" onClick={() => { void deleteProject(item.id).then(() => void showProjectPicker()); }}><Trash2 size={14} /></button>}</div>)}</section></div>}
    </main>
  );
}

/** Reads a media blob as a data URL for the portable project file. */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('Could not package project media.'));
    reader.onerror = () => reject(reader.error ?? new Error('Could not package project media.'));
    reader.readAsDataURL(blob);
  });
}

/** Restores a project media blob from its portable data URL. */
function dataUrlToBlob(dataUrl: string): Blob {
  const [metadata, encoded] = dataUrl.split(',', 2);
  const mimeType = metadata.match(/^data:([^;]+)/)?.[1] ?? 'application/octet-stream';
  const binary = atob(encoded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type: mimeType });
}
