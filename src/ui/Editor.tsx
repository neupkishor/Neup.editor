import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { AudioLines, Clapperboard, Download, FilePlus2, Film, Music2, Pause, Play, Plus, Scissors, SlidersHorizontal, Sparkles, Trash2, Type, Upload, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import { deleteProject, listProjects, loadProject, saveProject } from '../editor/storage';
import { blobToDataUrl, createProject, dataUrlToBlob, formatTime, getMediaKind, readMediaDuration } from '../editor/helpers';
import type { ClipEffect, EditorProject, MediaAsset, ProjectSummary, TimelineClip, TrackKind } from '../editor/types';
import { applyAnimationMask, getClipAnimationTransform } from '../editor/animations/render';
import { createEffectRenderer } from '../editor/effects/canvas';
import { applyEffectFallback } from '../editor/effects/render';
import EditorHeader from './EditorHeader';
import MediaPanel from './MediaPanel';
import AnimationLibraryPanel from './AnimationLibraryPanel';
import EffectsLibraryPanel from './EffectsLibraryPanel';

const PROJECT_KEY = 'neupcut-current-project';
const PIXELS_PER_SECOND = 12;
const FRAME_RATE = 30;

type DragState = { clipId: string; mode: 'move' | 'left' | 'right'; pointerX: number; start: number; duration: number; sourceStart: number; maxDuration: number; track: TrackKind };
type SelectionBox = { pointerId: number; startX: number; startY: number; currentX: number; currentY: number; left: number; top: number; width: number; height: number };
type TimelineContextMenu = { x: number; y: number; clipId?: string; trackIndex?: number };
type ProjectHistory = { projectId: string; past: EditorProject[]; present: EditorProject; future: EditorProject[]; pendingBefore: EditorProject | null; timer: number | null };
type ExportResolution = '360p' | '480p' | '720p' | '1080p' | '2k' | '4k' | '240p';
type ExportFormat = 'video/webm;codecs=vp9,opus' | 'video/webm;codecs=vp8,opus' | 'video/webm' | 'video/mp4;codecs=avc1.42E01E,mp4a.40.2' | 'video/mp4';

const exportResolutions: Record<ExportResolution, { width: number; height: number; label: string }> = {
  '240p': { width: 426, height: 240, label: '240p' },
  '360p': { width: 640, height: 360, label: '360p' },
  '480p': { width: 854, height: 480, label: '480p' },
  '720p': { width: 1280, height: 720, label: '720p' },
  '1080p': { width: 1920, height: 1080, label: '1080p' },
  '2k': { width: 2560, height: 1440, label: '2K' },
  '4k': { width: 3840, height: 2160, label: '4K' },
};

/** Returns the persisted lane number, treating older projects as lane one. */
function clipTrackIndex(clip: TimelineClip): number {
  return clip.trackIndex ?? 0;
}

/** Finds the closest non-overlapping start position on a specific lane. */
function findOpenClipStart(clips: TimelineClip[], trackIndex: number, requestedStart: number, duration: number, excludeId?: string): number {
  const occupied = clips.filter((clip) => clip.id !== excludeId && clipTrackIndex(clip) === trackIndex)
    .map((clip) => ({ start: clip.start, end: clip.start + clip.duration }))
    .sort((first, second) => first.start - second.start);
  const candidates: number[] = [Math.max(0, requestedStart)];
  let gapStart = 0;
  for (const range of occupied) {
    if (range.start - gapStart >= duration) candidates.push(Math.max(gapStart, Math.min(requestedStart, range.start - duration)));
    gapStart = Math.max(gapStart, range.end);
  }
  candidates.push(Math.max(gapStart, requestedStart));
  return candidates.filter((start) => !occupied.some((range) => start < range.end && start + duration > range.start))
    .sort((first, second) => Math.abs(first - requestedStart) - Math.abs(second - requestedStart))[0] ?? Math.max(gapStart, requestedStart);
}

/** Finds the first created lane that can fit a clip at its requested time. */
function findAvailableTopTrack(clips: TimelineClip[], trackCount: number, start: number, duration: number): number {
  for (let index = 0; index < trackCount; index += 1) {
    const occupied = clips.some((clip) => clipTrackIndex(clip) === index && start < clip.start + clip.duration && start + duration > clip.start);
    if (!occupied) return index;
  }
  return trackCount;
}

/** Converts older audio and video lane groups into one shared set of lanes. */
function normalizeProjectTracks(project: EditorProject): EditorProject {
  if (project.trackCount !== undefined) return project;
  const videoLaneCount = Math.max(1, project.trackCounts?.video ?? 1);
  const audioLaneCount = Math.max(1, project.trackCounts?.audio ?? 1);
  const { trackCounts: _legacyTrackCounts, ...rest } = project;
  return {
    ...rest,
    trackCount: videoLaneCount + audioLaneCount,
    clips: project.clips.map((clip) => ({ ...clip, trackIndex: clipTrackIndex(clip) + (clip.track === 'audio' ? videoLaneCount : 0) })),
  };
}

/** Provides a working browser based video editor with local projects and export. */
export default function Editor() {
  const [project, setProject] = useState<EditorProject>(() => createProject());
  const [, setHistoryRevision] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [previewRevision, setPreviewRevision] = useState(0);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [zoom, setZoom] = useState(1);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [timelineScrollTop, setTimelineScrollTop] = useState(0);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerPan, setViewerPan] = useState({ x: 0, y: 0 });
  const [viewerPanning, setViewerPanning] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [hoveredMediaAssetId, setHoveredMediaAssetId] = useState<string | null>(null);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [timelineContextMenu, setTimelineContextMenu] = useState<TimelineContextMenu | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [activeSidebarPanel, setActiveSidebarPanel] = useState<'media' | 'animations' | 'effects'>('media');
  const [showLeftSidebar, setShowLeftSidebar] = useState(true);
  const [showRightSidebar, setShowRightSidebar] = useState(true);
  const [showTimeline, setShowTimeline] = useState(true);
  const [exporting, setExporting] = useState(false);
  const [showExportSettings, setShowExportSettings] = useState(false);
  const [exportResolution, setExportResolution] = useState<ExportResolution>('720p');
  const [exportFormat, setExportFormat] = useState<ExportFormat>(() => typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm;codecs=vp8,opus');
  const [mediaError, setMediaError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const projectInputRef = useRef<HTMLInputElement>(null);
  const timelineScrollRef = useRef<HTMLDivElement>(null);
  const touchPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinchRef = useRef<{ distance: number; zoom: number; centerX: number } | null>(null);
  const gestureZoomRef = useRef<{ area: 'timeline' | 'viewer'; zoom: number; scale: number } | null>(null);
  const viewerPointersRef = useRef<Map<number, { x: number; y: number }>>(new Map());
  const viewerPinchRef = useRef<{ distance: number; zoom: number; midpoint: { x: number; y: number }; pan: { x: number; y: number } } | null>(null);
  const viewerDragRef = useRef<{ pointerId: number; x: number; y: number; pan: { x: number; y: number } } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const exportCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const renderMediaRef = useRef<Map<string, HTMLVideoElement | HTMLImageElement>>(new Map());
  const imageRef = useRef<HTMLImageElement>(null);
  const effectCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const effectRendererRef = useRef<ReturnType<typeof createEffectRenderer> | undefined>(undefined);
  const dragRef = useRef<DragState | null>(null);
  const selectionRef = useRef<SelectionBox | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const timeRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const exportChunksRef = useRef<Blob[]>([]);
  const exportAudioContextRef = useRef<AudioContext | null>(null);
  const exportAudioElementsRef = useRef<HTMLAudioElement[]>([]);
  const exportTimersRef = useRef<number[]>([]);
  const currentExportTimeRef = useRef(0);
  const exportingRef = useRef(false);
  const historyRef = useRef<ProjectHistory | null>(null);
  const canUndo = Boolean(historyRef.current?.past.length || historyRef.current?.pendingBefore);
  const canRedo = Boolean(historyRef.current?.future.length);
  const exportFormatOptions: Array<{ value: ExportFormat; label: string }> = [
    { value: 'video/webm;codecs=vp9,opus', label: 'WebM · VP9' },
    { value: 'video/webm;codecs=vp8,opus', label: 'WebM · VP8' },
    { value: 'video/webm', label: 'WebM' },
    { value: 'video/mp4;codecs=avc1.42E01E,mp4a.40.2', label: 'MP4 · H.264' },
    { value: 'video/mp4', label: 'MP4' },
  ];

  const assetUrls = useMemo(() => {
    const urls = new Map<string, string>();
    for (const asset of project.assets) {
      if (asset.blob) urls.set(asset.id, URL.createObjectURL(asset.blob));
    }
    return urls;
  }, [project.assets]);
  const duration = useMemo(() => project.clips.reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0), [project.clips]);
  const activeVideo = project.clips.filter((clip) => clip.track === 'video' && currentTime >= clip.start && currentTime < clip.start + clip.duration).sort((first, second) => clipTrackIndex(first) - clipTrackIndex(second))[0];
  const activeAudioClips = project.clips.filter((clip) => clip.track === 'audio' && currentTime >= clip.start && currentTime < clip.start + clip.duration);
  const activeAudio = activeVideo?.muted ? activeAudioClips.find((clip) => clip.assetId === activeVideo.assetId) ?? activeAudioClips[0] : activeAudioClips[0];
  const activeVideoAsset = project.assets.find((asset) => asset.id === activeVideo?.assetId);
  const activeAudioAsset = project.assets.find((asset) => asset.id === activeAudio?.assetId);
  const selectedClip = project.clips.find((clip) => clip.id === selectedClipId);
  const contextMenuClip = timelineContextMenu?.clipId ? project.clips.find((clip) => clip.id === timelineContextMenu.clipId) : undefined;
  const contextMenuTrackIndex = timelineContextMenu?.trackIndex;
  const contextMenuAsset = project.assets.find((asset) => asset.id === contextMenuClip?.assetId);
  const usedAssetIds = useMemo(() => new Set(project.clips.map((clip) => clip.assetId)), [project.clips]);
  const trackRows = useMemo(() => Array.from({ length: Math.max(1, project.trackCount ?? 1, ...project.clips.map((clip) => clipTrackIndex(clip) + 1)) }, (_, index) => index), [project.clips, project.trackCount]);
  const timelineWidth = Math.max(800, (duration + 12) * PIXELS_PER_SECOND * zoom);

  /** Loads and synchronizes media elements for every asset that can appear in a stacked video composite. */
  useEffect(() => {
    const videoClips = project.clips.filter((clip) => clip.track === 'video');
    const activeVideoClips = videoClips.filter((clip) => currentTime >= clip.start && currentTime < clip.start + clip.duration);
    for (const clip of videoClips) {
      const asset = project.assets.find((item) => item.id === clip.assetId);
      const url = assetUrls.get(clip.assetId);
      if (!asset || !url || asset.kind === 'audio' || asset.kind === 'title') continue;
      let source = renderMediaRef.current.get(clip.id);
      if (!source) {
        source = asset.kind === 'image' ? new Image() : document.createElement('video');
        if (source instanceof HTMLVideoElement) { source.muted = true; source.playsInline = true; }
        source.addEventListener('loadeddata', () => setPreviewRevision((revision) => revision + 1));
        source.addEventListener('load', () => setPreviewRevision((revision) => revision + 1));
        renderMediaRef.current.set(clip.id, source);
      }
      if (source.src !== url) source.src = url;
      if (source instanceof HTMLVideoElement) {
        source.preload = 'auto';
        const sourceTime = Math.max(0, clip.sourceStart + currentTime - clip.start);
        if (Math.abs(source.currentTime - sourceTime) > 0.2) source.currentTime = sourceTime;
        if (playing && activeVideoClips.some((active) => active.id === clip.id)) void source.play().catch(() => undefined);
        else source.pause();
      }
    }
    const projectClipIds = new Set(videoClips.map((clip) => clip.id));
    for (const [clipId, source] of renderMediaRef.current) {
      if (!projectClipIds.has(clipId)) {
        if (source instanceof HTMLVideoElement) source.pause();
        renderMediaRef.current.delete(clipId);
      }
    }
  }, [assetUrls, currentTime, playing, project.assets, project.clips]);

  /** Saves the current project and timeline viewport immediately. */
  const saveNow = () => {
    setSaving('saving');
    const updated = { ...project, updatedAt: Date.now(), timelineView: { zoom, scrollLeft: timelineScrollRef.current?.scrollLeft ?? timelineScrollLeft } };
    void saveProject(updated).then(() => setSaving('saved')).catch(() => setSaving('error'));
  };

  /** Restores timeline zoom and horizontal position from the saved project. */
  const restoreTimelineView = (view?: EditorProject['timelineView']) => {
    const nextZoom = Math.max(0.5, Math.min(10, view?.zoom ?? 1));
    const nextScrollLeft = Math.max(0, view?.scrollLeft ?? 0);
    setZoom(nextZoom);
    setTimelineScrollLeft(nextScrollLeft);
    requestAnimationFrame(() => {
      if (timelineScrollRef.current) timelineScrollRef.current.scrollLeft = nextScrollLeft;
    });
  };

  /** Zooms around the gesture midpoint and keeps that timeline point in place. */
  const zoomAroundPoint = (nextZoom: number, clientX: number) => {
    const scrollElement = timelineScrollRef.current;
    const boundedZoom = Math.max(0.5, Math.min(10, nextZoom));
    if (scrollElement && boundedZoom !== zoom) {
      const bounds = scrollElement.getBoundingClientRect();
      const pointInViewport = clientX - bounds.left;
      const timelinePoint = scrollElement.scrollLeft + pointInViewport;
      setZoom(boundedZoom);
      requestAnimationFrame(() => {
        if (timelineScrollRef.current) timelineScrollRef.current.scrollLeft = timelinePoint * (boundedZoom / zoom) - pointInViewport;
      });
      return;
    }
    setZoom(boundedZoom);
  };

  /** Keeps viewer panning within the scaled preview's visible bounds. */
  const clampViewerPan = (pan: { x: number; y: number }, scale: number) => {
    const stage = document.querySelector<HTMLElement>('.viewer-zoom-surface');
    const frame = stage?.querySelector<HTMLElement>('.player-frame');
    if (!stage || !frame) return pan;
    const maxX = Math.max(0, (frame.offsetWidth * scale - stage.clientWidth) / 2);
    const maxY = Math.max(0, (frame.offsetHeight * scale - stage.clientHeight) / 2);
    return { x: Math.max(-maxX, Math.min(maxX, pan.x)), y: Math.max(-maxY, Math.min(maxY, pan.y)) };
  };

  /** Zooms the preview around the user's pointer or pinch midpoint. */
  const zoomViewerAroundPoint = (nextZoom: number, clientX: number, clientY: number) => {
    const surface = document.querySelector<HTMLElement>('.viewer-zoom-surface');
    const boundedZoom = Math.max(0.25, Math.min(5, nextZoom));
    if (surface) {
      const bounds = surface.getBoundingClientRect();
      const offsetX = clientX - bounds.left - bounds.width / 2;
      const offsetY = clientY - bounds.top - bounds.height / 2;
      const ratio = boundedZoom / viewerZoom;
      setViewerPan(clampViewerPan({
        x: offsetX - (offsetX - viewerPan.x) * ratio,
        y: offsetY - (offsetY - viewerPan.y) * ratio,
      }, boundedZoom));
    }
    setViewerZoom(boundedZoom);
  };

  /** Pans the preview with regular mouse wheel and Shift plus wheel input. */
  useEffect(() => {
    const surface = document.querySelector<HTMLElement>('.viewer-zoom-surface');
    if (!surface) return;
    const handleViewerWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.metaKey) return;
      if (viewerZoom <= 1 && !event.shiftKey) return;
      event.preventDefault();
      const horizontal = event.shiftKey ? (event.deltaY || event.deltaX) : event.deltaX;
      const vertical = event.shiftKey ? 0 : event.deltaY;
      setViewerPan((current) => clampViewerPan({ x: current.x - horizontal, y: current.y - vertical }, viewerZoom));
    };
    surface.addEventListener('wheel', handleViewerWheel, { passive: false });
    return () => surface.removeEventListener('wheel', handleViewerWheel);
  }, [viewerPan, viewerZoom]);

  /** Steps preview magnification around the center of the viewer. */
  const adjustViewerZoom = (step: number) => {
    const bounds = document.querySelector<HTMLElement>('.viewer-zoom-surface')?.getBoundingClientRect();
    zoomViewerAroundPoint(viewerZoom + step, bounds ? bounds.left + bounds.width / 2 : window.innerWidth / 2, bounds ? bounds.top + bounds.height / 2 : window.innerHeight / 2);
  };

  /** Enables trackpad pinch gestures over the timeline without zooming the page. */
  useEffect(() => {
    const scrollElement = timelineScrollRef.current;
    if (!scrollElement) return;
    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      zoomAroundPoint(zoom * Math.exp(-event.deltaY * 0.008), event.clientX);
    };
    scrollElement.addEventListener('wheel', handleWheel, { passive: false });
    return () => scrollElement.removeEventListener('wheel', handleWheel);
  }, [zoom]);

  /** Blocks browser page zoom gestures while leaving timeline pinch handling active. */
  useEffect(() => {
    const preventBrowserZoom = (event: Event) => event.preventDefault();
    const preventWheelZoom = (event: WheelEvent) => {
      if (!(event.ctrlKey || event.metaKey)) return;
      const target = event.target;
      if (target instanceof Element && target.closest('.timeline-scroll')) return;
      if (target instanceof Element && target.closest('.viewer-zoom-surface')) {
        event.preventDefault();
        zoomViewerAroundPoint(viewerZoom * Math.exp(-event.deltaY * 0.008), event.clientX, event.clientY);
        return;
      }
      event.preventDefault();
    };
    const handleGestureStart = (event: Event) => {
      const target = event.target;
      if (target instanceof Element && target.closest('.viewer-zoom-surface')) {
        const gesture = event as Event & { scale?: number };
        gestureZoomRef.current = { area: 'viewer', zoom: viewerZoom, scale: gesture.scale ?? 1 };
        event.preventDefault();
        return;
      }
      if (!(target instanceof Element) || !target.closest('.timeline-scroll')) {
        preventBrowserZoom(event);
        return;
      }
      const gesture = event as Event & { scale?: number };
      gestureZoomRef.current = { area: 'timeline', zoom, scale: gesture.scale ?? 1 };
      event.preventDefault();
    };
    const handleGestureChange = (event: Event) => {
      const target = event.target;
      const initial = gestureZoomRef.current;
      if (target instanceof Element && target.closest('.viewer-zoom-surface') && initial?.area === 'viewer') {
        const gesture = event as Event & { scale?: number; clientX?: number; clientY?: number };
        event.preventDefault();
        zoomViewerAroundPoint(initial.zoom * ((gesture.scale ?? 1) / initial.scale), gesture.clientX ?? window.innerWidth / 2, gesture.clientY ?? window.innerHeight / 2);
        return;
      }
      if (!(target instanceof Element) || !target.closest('.timeline-scroll')) {
        preventBrowserZoom(event);
        return;
      }
      const gesture = event as Event & { scale?: number; clientX?: number };
      event.preventDefault();
      if (initial?.area === 'timeline') zoomAroundPoint(initial.zoom * ((gesture.scale ?? 1) / initial.scale), gesture.clientX ?? window.innerWidth / 2);
    };
    const handleGestureEnd = (event: Event) => {
      gestureZoomRef.current = null;
      if (!(event.target instanceof Element) || !event.target.closest('.timeline-scroll')) preventBrowserZoom(event);
    };
    window.addEventListener('wheel', preventWheelZoom, { capture: true, passive: false });
    window.addEventListener('gesturestart', handleGestureStart, { capture: true, passive: false });
    window.addEventListener('gesturechange', handleGestureChange, { capture: true, passive: false });
    window.addEventListener('gestureend', handleGestureEnd, { capture: true, passive: false });
    return () => {
      window.removeEventListener('wheel', preventWheelZoom, true);
      window.removeEventListener('gesturestart', handleGestureStart, true);
      window.removeEventListener('gesturechange', handleGestureChange, true);
      window.removeEventListener('gestureend', handleGestureEnd, true);
    };
  }, [viewerPan, viewerZoom, zoom]);

  /** Tracks touch pointers and scales the timeline from a two finger pinch. */
  const trackTouchPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    const pointers = touchPointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const pair = Array.from(pointers.values()).slice(0, 2);
      const distance = Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y);
      pinchRef.current = { distance: Math.max(1, distance), zoom, centerX: (pair[0].x + pair[1].x) / 2 };
      event.preventDefault();
      event.stopPropagation();
    }
  };

  /** Applies pinch distance changes while preserving the gesture midpoint. */
  const updateTouchPinch = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch' || !touchPointersRef.current.has(event.pointerId)) return;
    const pointers = touchPointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size < 2 || !pinchRef.current) return;
    const pair = Array.from(pointers.values()).slice(0, 2);
    const distance = Math.max(1, Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y));
    const initial = pinchRef.current;
    zoomAroundPoint(initial.zoom * (distance / initial.distance), (pair[0].x + pair[1].x) / 2);
    event.preventDefault();
    event.stopPropagation();
  };

  /** Clears a released touch pointer and resets pinch tracking. */
  const endTouchPinch = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.pointerType !== 'touch') return;
    if (pinchRef.current) dragRef.current = null;
    touchPointersRef.current.delete(event.pointerId);
    pinchRef.current = null;
  };

  /** Starts a paint style selection box when dragging over empty track space. */
  const beginTimelineSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    if (event.pointerType === 'touch') {
      trackTouchPointer(event);
      return;
    }
    const target = event.target as HTMLElement;
    if (!target.closest('.track-lane') || target.closest('.timeline-clip')) return;
    const timeline = event.currentTarget.querySelector<HTMLElement>('.timeline-inner');
    const bounds = timeline?.getBoundingClientRect();
    if (!bounds) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const box = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, currentX: event.clientX, currentY: event.clientY, left: x, top: y, width: 0, height: 0 };
    selectionRef.current = box;
    setSelectionBox(box);
  };

  /** Updates the visible selection marquee while the pointer is held. */
  const updateTimelineSelection = (event: ReactPointerEvent<HTMLDivElement>) => {
    updateTouchPinch(event);
    const current = selectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    const timeline = event.currentTarget.querySelector<HTMLElement>('.timeline-inner');
    const bounds = timeline?.getBoundingClientRect();
    if (!bounds) return;
    const x = event.clientX - bounds.left;
    const y = event.clientY - bounds.top;
    const next = { ...current, currentX: event.clientX, currentY: event.clientY, left: Math.min(current.startX - bounds.left, x), top: Math.min(current.startY - bounds.top, y), width: Math.abs(x - (current.startX - bounds.left)), height: Math.abs(y - (current.startY - bounds.top)) };
    selectionRef.current = next;
    setSelectionBox(next);
  };

  /** Selects every clip intersecting the marquee and finishes the drag. */
  const finishTimelineSelection = (event: ReactPointerEvent<HTMLDivElement>, commit: boolean) => {
    endTouchPinch(event);
    const current = selectionRef.current;
    if (!current || current.pointerId !== event.pointerId) return;
    if (commit && Math.hypot(current.currentX - current.startX, current.currentY - current.startY) > 3) {
      const bounds = { left: Math.min(current.startX, current.currentX), right: Math.max(current.startX, current.currentX), top: Math.min(current.startY, current.currentY), bottom: Math.max(current.startY, current.currentY) };
      const clips = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('.timeline-clip'));
      const selected = clips.filter((clip) => {
        const rect = clip.getBoundingClientRect();
        return rect.right >= bounds.left && rect.left <= bounds.right && rect.bottom >= bounds.top && rect.top <= bounds.bottom;
      }).map((clip) => clip.dataset.clipId).filter((id): id is string => Boolean(id));
      setSelectedClipIds(selected);
      setSelectedClipId(selected[selected.length - 1] ?? null);
    } else if (commit) {
      setSelectedClipIds([]);
      setSelectedClipId(null);
    }
    selectionRef.current = null;
    setSelectionBox(null);
  };

  /** Begins tracking two finger gestures over the video preview. */
  const trackViewerPointer = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.target instanceof Element && event.target.closest('.viewer-play-button')) return;
    if (event.pointerType === 'mouse' && event.button === 0 && viewerZoom > 1) {
      viewerDragRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, pan: viewerPan };
      event.currentTarget.setPointerCapture(event.pointerId);
      setViewerPanning(true);
      event.preventDefault();
      return;
    }
    if (event.pointerType !== 'touch') return;
    const pointers = viewerPointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size >= 2) {
      const pair = Array.from(pointers.values()).slice(0, 2);
      viewerPinchRef.current = {
        distance: Math.max(1, Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y)),
        zoom: viewerZoom,
        midpoint: { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 },
        pan: viewerPan,
      };
      event.preventDefault();
    }
  };

  /** Pinches the preview canvas while keeping the midpoint as the zoom anchor. */
  const updateViewerPinch = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = viewerDragRef.current;
    if (event.pointerType === 'mouse' && drag?.pointerId === event.pointerId) {
      setViewerPan(clampViewerPan({ x: drag.pan.x + event.clientX - drag.x, y: drag.pan.y + event.clientY - drag.y }, viewerZoom));
      event.preventDefault();
      return;
    }
    if (event.pointerType !== 'touch' || !viewerPointersRef.current.has(event.pointerId)) return;
    const pointers = viewerPointersRef.current;
    pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    if (pointers.size < 2 || !viewerPinchRef.current) return;
    const pair = Array.from(pointers.values()).slice(0, 2);
    const distance = Math.max(1, Math.hypot(pair[0].x - pair[1].x, pair[0].y - pair[1].y));
    const midpoint = { x: (pair[0].x + pair[1].x) / 2, y: (pair[0].y + pair[1].y) / 2 };
    const pinch = viewerPinchRef.current;
    const nextZoom = Math.max(0.25, Math.min(5, pinch.zoom * (distance / pinch.distance)));
    const stage = document.querySelector<HTMLElement>('.viewer-zoom-surface');
    const bounds = stage?.getBoundingClientRect();
    const centerX = bounds ? bounds.left + bounds.width / 2 : midpoint.x;
    const centerY = bounds ? bounds.top + bounds.height / 2 : midpoint.y;
    const ratio = nextZoom / pinch.zoom;
    setViewerPan(clampViewerPan({
      x: midpoint.x - centerX - (pinch.midpoint.x - centerX - pinch.pan.x) * ratio,
      y: midpoint.y - centerY - (pinch.midpoint.y - centerY - pinch.pan.y) * ratio,
    }, nextZoom));
    setViewerZoom(nextZoom);
    event.preventDefault();
  };

  /** Ends preview pinch tracking when a touch pointer is released. */
  const endViewerPinch = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (viewerDragRef.current?.pointerId === event.pointerId) {
      viewerDragRef.current = null;
      setViewerPanning(false);
    }
    if (event.pointerType !== 'touch') return;
    viewerPointersRef.current.delete(event.pointerId);
    viewerPinchRef.current = null;
  };

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
      if (stored) {
        setProject(normalizeProjectTracks(stored));
        restoreTimelineView(stored.timelineView);
      }
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
      const updated = { ...project, updatedAt: Date.now(), timelineView: { zoom, scrollLeft: timelineScrollRef.current?.scrollLeft ?? timelineScrollLeft } };
      void saveProject(updated).then(() => {
        setSaving('saved');
        localStorage.setItem(PROJECT_KEY, project.id);
      }).catch(() => setSaving('error'));
    }, 450);
    return () => window.clearTimeout(timer);
  }, [project, zoom, timelineScrollLeft]);

  /** Records project edits as undo steps, grouping rapid changes such as clip drags. */
  useEffect(() => {
    const history = historyRef.current;
    if (!history || history.projectId !== project.id) {
      if (history?.timer) window.clearTimeout(history.timer);
      historyRef.current = { projectId: project.id, past: [], present: project, future: [], pendingBefore: null, timer: null };
      setHistoryRevision((revision) => revision + 1);
      return;
    }
    if (history.present === project) return;
    if (!history.pendingBefore) {
      history.pendingBefore = history.present;
      history.future = [];
    }
    history.present = project;
    if (history.timer) window.clearTimeout(history.timer);
    history.timer = window.setTimeout(() => {
      const active = historyRef.current;
      if (!active?.pendingBefore) return;
      active.past.push(active.pendingBefore);
      if (active.past.length > 100) active.past.shift();
      active.pendingBefore = null;
      active.future = [];
      active.timer = null;
      setHistoryRevision((revision) => revision + 1);
    }, 300);
  }, [project]);

  /** Flushes the active debounce group into the undo history. */
  const flushPendingHistory = () => {
    const history = historyRef.current;
    if (!history?.pendingBefore) return;
    if (history.timer) window.clearTimeout(history.timer);
    history.past.push(history.pendingBefore);
    if (history.past.length > 100) history.past.shift();
    history.pendingBefore = null;
    history.timer = null;
    setHistoryRevision((revision) => revision + 1);
  };

  /** Restores the last saved project state and moves the current state to redo. */
  const undoProject = () => {
    flushPendingHistory();
    const history = historyRef.current;
    const previous = history?.past.pop();
    if (!history || !previous) return;
    history.future.push(history.present);
    history.present = previous;
    setProject(previous);
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setHistoryRevision((revision) => revision + 1);
  };

  /** Restores the next project state from the redo history. */
  const redoProject = () => {
    const history = historyRef.current;
    const next = history?.future.pop();
    if (!history || !next) return;
    history.past.push(history.present);
    history.present = next;
    setProject(next);
    setSelectedClipId(null);
    setSelectedClipIds([]);
    setHistoryRevision((revision) => revision + 1);
  };

  /** Clears any pending history timer when the editor unmounts. */
  useEffect(() => () => {
    const timer = historyRef.current?.timer;
    if (timer) window.clearTimeout(timer);
  }, []);

  /** Keeps the browser media elements loaded at the active clip and source time. */
  useEffect(() => {
    const video = videoRef.current;
    const videoUrl = activeVideoAsset ? assetUrls.get(activeVideoAsset.id) : undefined;
    if (video) {
      video.muted = exporting || (activeVideo?.muted ?? false);
      if (videoUrl && video.src !== videoUrl) video.src = videoUrl;
      if (!videoUrl) video.removeAttribute('src');
      const sourceTime = (activeVideo?.sourceStart ?? 0) + currentTime - (activeVideo?.start ?? 0);
      if (videoUrl && Math.abs(video.currentTime - sourceTime) > 0.35) video.currentTime = Math.max(0, sourceTime);
      if (playing && !exporting && videoUrl) void video.play().catch(() => undefined);
      else video.pause();
    }
    const audio = audioRef.current;
    const audioUrl = activeAudioAsset ? assetUrls.get(activeAudioAsset.id) : undefined;
    if (audio) {
      if (audioUrl && audio.src !== audioUrl) audio.src = audioUrl;
      if (!audioUrl) audio.removeAttribute('src');
      const sourceTime = (activeAudio?.sourceStart ?? 0) + currentTime - (activeAudio?.start ?? 0);
      if (audioUrl && Math.abs(audio.currentTime - sourceTime) > 0.35) audio.currentTime = Math.max(0, sourceTime);
      if (playing && !exporting && audioUrl) void audio.play().catch(() => undefined);
      else audio.pause();
    }
  }, [activeAudio, activeAudioAsset, activeVideo, activeVideoAsset, assetUrls, currentTime, exporting, playing]);

  /** Draws every active video lane from bottom to top into the shared preview and export canvas. */
  useEffect(() => {
    let animation = 0;
    const draw = () => {
      const canvases = [canvasRef.current].filter((item): item is HTMLCanvasElement => Boolean(item));
      const activeClips = project.clips.filter((clip) => clip.track === 'video' && currentTime >= clip.start && currentTime < clip.start + clip.duration).sort((first, second) => clipTrackIndex(second) - clipTrackIndex(first));
      for (const canvas of canvases) {
        const context = canvas.getContext('2d');
        if (!context) continue;
        context.fillStyle = '#0e1015';
        context.fillRect(0, 0, canvas.width, canvas.height);
        if (!activeClips.length) {
          drawWelcomeCard(context, canvas.width, canvas.height, project.name);
        } else {
          const effectCanvas = effectCanvasRef.current ?? document.createElement('canvas');
          effectCanvasRef.current = effectCanvas;
          if (effectCanvas.width !== canvas.width) effectCanvas.width = canvas.width;
          if (effectCanvas.height !== canvas.height) effectCanvas.height = canvas.height;
          const effectContext = effectCanvas.getContext('2d');
          if (!effectContext) continue;
          if (effectRendererRef.current === undefined) effectRendererRef.current = createEffectRenderer();
          const renderer = effectRendererRef.current;
          for (const active of activeClips) {
            const asset = project.assets.find((item) => item.id === active.assetId);
            if (!asset) continue;
            const transform = getClipAnimationTransform(active, currentTime);
            effectContext.clearRect(0, 0, effectCanvas.width, effectCanvas.height);
            effectContext.save();
            effectContext.globalAlpha = transform.opacity / 100;
            effectContext.translate(canvas.width / 2 + transform.x * canvas.width / 100, canvas.height / 2 + transform.y * canvas.height / 100);
            effectContext.rotate(transform.rotation * Math.PI / 180);
            effectContext.scale(transform.scale / 100, transform.scale / 100);
            effectContext.translate(-canvas.width / 2, -canvas.height / 2);
            effectContext.filter = 'none';
            applyAnimationMask(effectContext, canvas.width, canvas.height, transform.mask, transform.reveal);
            if (asset.kind === 'title') {
              drawTitleCard(effectContext, canvas.width, canvas.height, active.name);
            } else if (asset.kind === 'image') {
              const image = renderMediaRef.current.get(active.id);
              if (image instanceof HTMLImageElement && image.complete && image.naturalWidth) drawContained(effectContext, image, canvas.width, canvas.height);
            } else if (asset.kind === 'video') {
              const video = renderMediaRef.current.get(active.id);
              if (video instanceof HTMLVideoElement && video.readyState >= 2) drawContained(effectContext, video, canvas.width, canvas.height);
            }
            effectContext.restore();
            if (renderer && (active.effects?.length || transform.blur > 0)) {
              context.drawImage(renderer.render(effectCanvas, active.effects ?? [], transform.blur), 0, 0, canvas.width, canvas.height);
            } else {
              if (!renderer) applyEffectFallback(effectCanvas, active.effects ?? [], transform.blur);
              context.drawImage(effectCanvas, 0, 0);
            }
          }
        }
      }
    };
    animation = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(animation);
  }, [currentTime, exporting, previewRevision, project.assets, project.clips, project.name]);

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
        currentExportTimeRef.current = duration;
        setCurrentTime(duration);
        setPlaying(false);
        if (exportingRef.current) recorderRef.current?.stop();
        return;
      }
      timeRef.current = nextTime;
      if (exportingRef.current) currentExportTimeRef.current = nextTime;
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
    let nextStart = project.clips.filter((clip) => clipTrackIndex(clip) === 0).reduce((end, clip) => Math.max(end, clip.start + clip.duration), 0);
    for (const file of Array.from(files)) {
      const kind = getMediaKind(file);
      if (!kind) continue;
      const mediaDuration = await readMediaDuration(file);
      const id = crypto.randomUUID();
      const asset: MediaAsset = { id, name: file.name, kind, mimeType: file.type, size: file.size, duration: mediaDuration, blob: file };
      imported.push(asset);
      const track: TrackKind = kind === 'audio' ? 'audio' : 'video';
      added.push({ id: crypto.randomUUID(), assetId: id, name: file.name, track, trackIndex: 0, start: nextStart, duration: Math.max(0.5, mediaDuration), sourceStart: 0 });
      nextStart += mediaDuration;
    }
    if (imported.length) {
      setProject((current) => ({ ...current, assets: [...current.assets, ...imported], clips: [...current.clips, ...added] }));
      setSelectedClipId(added[0].id);
      setSelectedClipIds([added[0].id]);
    }
    if (imported.length < files.length) setMediaError('Some files were skipped. Import audio, video, or image files supported by your browser.');
    else setMediaError('');
  }, [project.clips]);

  /** Creates a text card and places it at the current playhead position. */
  const addTitle = useCallback(() => {
    const asset: MediaAsset = { id: crypto.randomUUID(), name: 'Your title', kind: 'title', mimeType: 'text/plain', size: 0, duration: 5 };
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track: 'video', trackIndex: 0, start: currentTime, duration: 5, sourceStart: 0 };
    setProject((current) => ({ ...current, assets: [...current.assets, asset], clips: [...current.clips, { ...clip, start: findOpenClipStart(current.clips, 0, clip.start, clip.duration) }] }));
    setSelectedClipId(clip.id);
    setSelectedClipIds([clip.id]);
  }, [currentTime]);

  /** Adds another instance of an existing media asset at the playhead. */
  const addAssetToTimeline = useCallback((asset: MediaAsset) => {
    const track: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track, trackIndex: 0, start: currentTime, duration: Math.max(0.5, asset.duration), sourceStart: 0 };
    setProject((current) => {
      const laneCount = Math.max(current.trackCount ?? 1, ...current.clips.map((item) => clipTrackIndex(item) + 1));
      const trackIndex = findAvailableTopTrack(current.clips, laneCount, currentTime, clip.duration);
      return { ...current, trackCount: Math.max(laneCount, trackIndex + 1), clips: [...current.clips, { ...clip, trackIndex, start: currentTime }] };
    });
    setSelectedClipId(clip.id);
    setSelectedClipIds([clip.id]);
  }, [currentTime]);

  /** Places a dragged media asset at the drop position and on the lane under the pointer. */
  const dropAssetOnTimeline = (event: React.DragEvent<HTMLDivElement>, trackIndex: number) => {
    event.preventDefault();
    const assetId = event.dataTransfer.getData('application/x-neupcut-asset') || event.dataTransfer.getData('text/plain');
    const asset = project.assets.find((item) => item.id === assetId);
    if (!asset) return;
    const track: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const laneOffset = track === 'audio' ? Math.max(0, ...project.clips.filter((clip) => clip.track === 'audio').map(clipTrackIndex)) : 0;
    const targetTrackIndex = track === 'audio' ? Math.max(laneOffset, trackIndex) : trackIndex;
    const bounds = event.currentTarget.getBoundingClientRect();
    const requestedStart = Math.max(0, (event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom));
    const duration = Math.max(0.5, asset.duration);
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track, trackIndex: targetTrackIndex, start: requestedStart, duration, sourceStart: 0 };
    setProject((current) => ({ ...current, trackCount: Math.max(current.trackCount ?? 1, targetTrackIndex + 1), clips: [...current.clips, { ...clip, start: findOpenClipStart(current.clips, targetTrackIndex, requestedStart, duration) }] }));
    setSelectedClipId(clip.id);
    setSelectedClipIds([clip.id]);
  };

  /** Removes a media asset and every timeline clip that references it. */
  const deleteMediaAsset = useCallback((assetId: string) => {
    const removedClipIds = project.clips.filter((clip) => clip.assetId === assetId).map((clip) => clip.id);
    setProject((current) => ({ ...current, assets: current.assets.filter((asset) => asset.id !== assetId), clips: current.clips.filter((clip) => clip.assetId !== assetId) }));
    setSelectedClipId((id) => id && removedClipIds.includes(id) ? null : id);
    setSelectedClipIds((ids) => ids.filter((id) => !removedClipIds.includes(id)));
  }, [project.clips]);

  /** Adds another shared timeline lane for any kind of clip. */
  const addTrack = () => {
    setProject((current) => {
      const existingCount = Math.max(current.trackCount ?? 1, ...current.clips.map((clip) => clipTrackIndex(clip) + 1));
      return { ...current, trackCount: existingCount + 1 };
    });
  };

  /** Applies a reusable animation preset to the currently selected video clip. */
  const applyAnimation = useCallback((presetId: string, animationDuration: number) => {
    if (!selectedClip || selectedClip.track !== 'video') return;
    setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, animation: { presetId, duration: Math.min(animationDuration, clip.duration) } } : clip) }));
  }, [selectedClip]);

  /** Replaces the selected clip's effect stack after a library edit. */
  const updateClipEffects = useCallback((effects: ClipEffect[]) => {
    if (!selectedClip || selectedClip.track !== 'video') return;
    setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, effects: effects.length ? effects : undefined } : clip) }));
  }, [selectedClip]);

  /** Removes the animation effect from the currently selected clip. */
  const removeAnimation = useCallback(() => {
    if (!selectedClip) return;
    setProject((current) => ({ ...current, clips: current.clips.map((clip) => {
      if (clip.id !== selectedClip.id) return clip;
      const { animation: _animation, ...clipWithoutAnimation } = clip;
      return clipWithoutAnimation;
    }) }));
  }, [selectedClip]);

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
    setSelectedClipIds([]);
    setProject(normalizeProjectTracks(stored));
    restoreTimelineView(stored.timelineView);
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
    restoreTimelineView(fresh.timelineView);
    setSelectedClipId(null);
    setSelectedClipIds([]);
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
    const timelineView = { zoom, scrollLeft: timelineScrollRef.current?.scrollLeft ?? timelineScrollLeft };
    const archive = new Blob([JSON.stringify({ format: 'neupcut-project', version: 1, project: { ...project, assets, timelineView } })], { type: 'application/json' });
    const archiveUrl = URL.createObjectURL(archive);
    const link = document.createElement('a');
    link.href = archiveUrl;
    link.download = `${project.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'project'}.neupcut.json`;
    link.click();
    URL.revokeObjectURL(archiveUrl);
  }, [project, timelineScrollLeft, zoom]);

  /** Imports a portable project JSON file and restores its embedded media. */
  const importProjectFile = useCallback(async (file?: File) => {
    if (!file) return;
    try {
      const archive = JSON.parse(await file.text()) as { format?: string; version?: number; project?: Omit<EditorProject, 'assets'> & { assets: Array<Omit<MediaAsset, 'blob'> & { blobData?: string }> } };
      if (archive.format !== 'neupcut-project' || archive.version !== 1 || !archive.project?.id || !Array.isArray(archive.project.assets) || !Array.isArray(archive.project.clips)) throw new Error('That file is not a supported Neup Cut project.');
      const restored = normalizeProjectTracks({ ...archive.project, assets: archive.project.assets.map(({ blobData, ...asset }) => ({ ...asset, blob: blobData ? dataUrlToBlob(blobData) : undefined })) });
      setProject(restored);
      restoreTimelineView(restored.timelineView);
      setSelectedClipId(null);
      setSelectedClipIds([]);
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
    const idsToRemove = selectedClipIds.length ? selectedClipIds : selectedClipId ? [selectedClipId] : [];
    if (!idsToRemove.length) return;
    setProject((current) => ({ ...current, clips: current.clips.filter((clip) => !idsToRemove.includes(clip.id)) }));
    setSelectedClipId(null);
    setSelectedClipIds([]);
  }, [selectedClipId, selectedClipIds]);

  /** Opens a small context menu for the clip or timeline region under the pointer. */
  const openTimelineContextMenu = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const clipElement = event.target instanceof Element ? event.target.closest<HTMLElement>('.timeline-clip') : null;
    const clipId = clipElement?.dataset.clipId;
    if (clipId) {
      setSelectedClipId(clipId);
      setSelectedClipIds([clipId]);
    }
    setTimelineContextMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 190), clipId });
  };

  /** Opens track actions from the track-name gutter. */
  const openTrackContextMenu = (event: ReactMouseEvent<HTMLDivElement>, trackIndex: number) => {
    event.preventDefault();
    setTimelineContextMenu({ x: Math.min(event.clientX, window.innerWidth - 210), y: Math.min(event.clientY, window.innerHeight - 120), trackIndex });
  };

  /** Deletes a lane, removes its clips, and shifts later lanes up while keeping one lane. */
  const deleteTrack = (trackIndex: number) => {
    if (trackRows.length <= 1) return;
    const deletedClipIds = project.clips.filter((clip) => clipTrackIndex(clip) === trackIndex).map((clip) => clip.id);
    setProject((current) => {
      const laneCount = Math.max(1, current.trackCount ?? 1, ...current.clips.map((clip) => clipTrackIndex(clip) + 1));
      return {
        ...current,
        trackCount: Math.max(1, laneCount - 1),
        clips: current.clips.filter((clip) => clipTrackIndex(clip) !== trackIndex).map((clip) => clipTrackIndex(clip) > trackIndex ? { ...clip, trackIndex: clipTrackIndex(clip) - 1 } : clip),
      };
    });
    setSelectedClipId((id) => id && deletedClipIds.includes(id) ? null : id);
    setSelectedClipIds((ids) => ids.filter((id) => !deletedClipIds.includes(id)));
    setTimelineContextMenu(null);
  };

  /** Splits the chosen timeline clip at the current playhead position. */
  const splitClipAtPlayhead = (clipId: string) => {
    const clip = project.clips.find((item) => item.id === clipId);
    if (!clip || currentTime <= clip.start || currentTime >= clip.start + clip.duration) return;
    const firstDuration = currentTime - clip.start;
    const second: TimelineClip = { ...clip, id: crypto.randomUUID(), start: currentTime, sourceStart: clip.sourceStart + firstDuration, duration: clip.duration - firstDuration };
    setProject((current) => ({ ...current, clips: [...current.clips.map((item) => item.id === clip.id ? { ...item, duration: firstDuration } : item), second] }));
    setSelectedClipId(second.id);
    setSelectedClipIds([second.id]);
  };

  /** Separates a video's soundtrack into a synchronized audio clip and mutes its picture clip. */
  const separateAudioFromVideo = (clipId: string) => {
    const sourceClip = project.clips.find((clip) => clip.id === clipId);
    const asset = project.assets.find((item) => item.id === sourceClip?.assetId);
    if (!sourceClip || sourceClip.track !== 'video' || asset?.kind !== 'video' || sourceClip.muted) return;
    const audioClipId = crypto.randomUUID();
    setProject((current) => {
      const source = current.clips.find((clip) => clip.id === clipId);
      if (!source) return current;
      const laneCount = Math.max(current.trackCount ?? 1, ...current.clips.map((clip) => clipTrackIndex(clip) + 1));
      const trackIndex = findAvailableTopTrack(current.clips, laneCount, source.start, source.duration);
      const audioClip: TimelineClip = { id: audioClipId, assetId: source.assetId, name: `${source.name} audio`, track: 'audio', trackIndex, start: source.start, duration: source.duration, sourceStart: source.sourceStart };
      return { ...current, trackCount: Math.max(laneCount, trackIndex + 1), clips: [...current.clips.map((clip) => clip.id === clipId ? { ...clip, muted: true } : clip), audioClip] };
    });
    setSelectedClipId(audioClipId);
    setSelectedClipIds([audioClipId]);
  };

  /** Dismisses the timeline menu when focus moves elsewhere or Escape is pressed. */
  useEffect(() => {
    if (!timelineContextMenu) return;
    const dismissMenu = (event: PointerEvent) => {
      if (event.target instanceof Element && event.target.closest('.timeline-context-menu')) return;
      setTimelineContextMenu(null);
    };
    const handleKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setTimelineContextMenu(null); };
    window.addEventListener('pointerdown', dismissMenu);
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('pointerdown', dismissMenu);
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [timelineContextMenu]);

  /** Handles editor visibility, history, playback, and clip deletion shortcuts. */
  useEffect(() => {
    const handleEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const command = event.metaKey || event.ctrlKey;
      const key = event.key.toLowerCase();
      if (command && key === 'k') {
        event.preventDefault();
        if (event.shiftKey) setShowRightSidebar((visible) => !visible);
        else setShowLeftSidebar((visible) => !visible);
        return;
      }
      if (command && key === 'm') {
        event.preventDefault();
        setShowTimeline((visible) => !visible);
        return;
      }
      if (command && key === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoProject();
        else undoProject();
        return;
      }
      if (command && key === 'y') {
        event.preventDefault();
        redoProject();
        return;
      }
      if (event.code === 'Space' && !event.repeat) {
        event.preventDefault();
        togglePlayback();
        return;
      }
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!selectedClipIds.length && !selectedClipId) return;
      event.preventDefault();
      removeSelectedClip();
    };
    window.addEventListener('keydown', handleEditorShortcut);
    return () => window.removeEventListener('keydown', handleEditorShortcut);
  }, [redoProject, removeSelectedClip, selectedClipId, selectedClipIds.length, togglePlayback, undoProject]);

  /** Starts moving or trimming a clip based on the pointer target. */
  const beginClipDrag = (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, mode: DragState['mode']) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(clip.id);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      setSelectedClipIds((current) => current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id]);
    } else {
      setSelectedClipIds([clip.id]);
    }
    const asset = project.assets.find((item) => item.id === clip.assetId);
    dragRef.current = { clipId: clip.id, mode, pointerX: event.clientX, start: clip.start, duration: clip.duration, sourceStart: clip.sourceStart, maxDuration: asset?.kind === 'image' ? Number.POSITIVE_INFINITY : asset?.duration ?? Number.POSITIVE_INFINITY, track: clip.track };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Moves the active clip or adjusts its source in and duration while dragging. */
  const updateClipDrag = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag) return;
    const delta = Math.round(((event.clientX - drag.pointerX) / (PIXELS_PER_SECOND * zoom)) * FRAME_RATE) / FRAME_RATE;
    setProject((current) => ({ ...current, clips: current.clips.map((clip) => {
      if (clip.id !== drag.clipId) return clip;
      if (drag.mode === 'move') {
        const requested = Math.max(0, Math.round((drag.start + delta) * FRAME_RATE) / FRAME_RATE);
        return { ...clip, start: findOpenClipStart(current.clips, clipTrackIndex(clip), requested, clip.duration, clip.id) };
      }
      if (drag.mode === 'left') {
        const previousEnd = current.clips.filter((item) => item.id !== clip.id && clipTrackIndex(item) === clipTrackIndex(clip) && item.start + item.duration <= drag.start).reduce((end, item) => Math.max(end, item.start + item.duration), 0);
        const shift = Math.max(previousEnd - drag.start, -drag.sourceStart, Math.min(Math.min(drag.duration - 0.25, drag.maxDuration - drag.sourceStart - 0.25), delta));
        return { ...clip, start: Math.max(0, drag.start + shift), duration: Math.max(0.25, drag.duration - shift), sourceStart: Math.max(0, drag.sourceStart + shift) };
      }
      const nextStart = current.clips.filter((item) => item.id !== clip.id && clipTrackIndex(item) === clipTrackIndex(clip) && item.start >= drag.start + drag.duration).reduce((start, item) => Math.min(start, item.start), Number.POSITIVE_INFINITY);
      return { ...clip, duration: Math.max(0.25, Math.min(drag.maxDuration - drag.sourceStart, nextStart - clip.start, drag.duration + delta)) };
    }) }));
  };

  /** Completes a pointer driven clip move or trim operation. */
  const endClipDrag = () => { dragRef.current = null; };

  /** Opens export options before creating the downloadable render. */
  const exportVideo = useCallback(() => setShowExportSettings(true), []);

  /** Records the timeline composite and mixes every audible clip at the selected output size and codec. */
  const startVideoExport = useCallback(async () => {
    const settings = exportResolutions[exportResolution];
    if (!duration) return;
    if (!('MediaRecorder' in window) || !HTMLCanvasElement.prototype.captureStream) { setMediaError('Video export is not supported by this browser.'); return; }
    if (!MediaRecorder.isTypeSupported(exportFormat)) { setMediaError(`${exportFormat.startsWith('video/mp4') ? 'MP4' : 'WebM'} export is not supported by this browser. Choose a supported format.`); return; }

    const output = document.createElement('canvas');
    output.width = settings.width;
    output.height = settings.height;
    exportCanvasRef.current = output;
    const audioContext = new AudioContext();
    const audioDestination = audioContext.createMediaStreamDestination();
    exportAudioContextRef.current = audioContext;
    const stream = output.captureStream(30);
    audioDestination.stream.getAudioTracks().forEach((track) => stream.addTrack(track));
    const cleanup = () => {
      exportTimersRef.current.forEach((timer) => window.clearTimeout(timer));
      exportTimersRef.current = [];
      exportAudioElementsRef.current.forEach((element) => { element.pause(); element.removeAttribute('src'); });
      exportAudioElementsRef.current = [];
      void audioContext.close();
      exportAudioContextRef.current = null;
      exportCanvasRef.current = null;
      stream.getTracks().forEach((track) => track.stop());
      setExporting(false);
    };
    try {
      await audioContext.resume();
      setMediaError('');
      setShowExportSettings(false);
      setExporting(true);
      setPlaying(false);
      seekTo(0);
      await new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
      const mediaReadiness = project.clips.filter((clip) => clip.track === 'video').map((clip) => renderMediaRef.current.get(clip.id)).filter((source): source is HTMLVideoElement | HTMLImageElement => Boolean(source));
      await Promise.all(mediaReadiness.map((source) => {
        if (source instanceof HTMLVideoElement && source.readyState >= 2) return Promise.resolve();
        if (source instanceof HTMLImageElement && source.complete && source.naturalWidth) return Promise.resolve();
        return new Promise<void>((resolve, reject) => {
          const readyEvent = source instanceof HTMLVideoElement ? 'loadeddata' : 'load';
          const errorEvent = 'error';
          const timeout = window.setTimeout(() => finish(new Error('Timed out waiting for timeline media to load.')), 15000);
          const finish = (error?: Error) => {
            window.clearTimeout(timeout);
            source.removeEventListener(readyEvent, onReady);
            source.removeEventListener(errorEvent, onError);
            if (error) reject(error); else resolve();
          };
          const onReady = () => finish();
          const onError = () => finish(new Error('A timeline media file could not be loaded for export.'));
          source.addEventListener(readyEvent, onReady, { once: true });
          source.addEventListener(errorEvent, onError, { once: true });
        });
      }));
      const clipsWithSound = project.clips.filter((clip) => {
        const asset = project.assets.find((item) => item.id === clip.assetId);
        return asset?.blob && (clip.track === 'audio' || (clip.track === 'video' && asset.kind === 'video' && !clip.muted));
      });
      for (const clip of clipsWithSound) {
        const asset = project.assets.find((item) => item.id === clip.assetId);
        if (!asset?.blob) continue;
        const url = assetUrls.get(asset.id);
        if (!url) continue;
        const element = new Audio(url);
        element.preload = 'auto';
        const source = audioContext.createMediaElementSource(element);
        source.connect(audioDestination);
        exportAudioElementsRef.current.push(element);
        const startTimer = window.setTimeout(() => {
          element.currentTime = clip.sourceStart;
          void element.play().catch(() => undefined);
        }, clip.start * 1000);
        const stopTimer = window.setTimeout(() => element.pause(), (clip.start + clip.duration) * 1000);
        exportTimersRef.current.push(startTimer, stopTimer);
      }
      const outputContext = output.getContext('2d');
      if (outputContext) {
        const layerCanvas = document.createElement('canvas');
        layerCanvas.width = output.width;
        layerCanvas.height = output.height;
        const layerContext = layerCanvas.getContext('2d');
        const drawExportFrame = () => {
          const active = project.clips.filter((clip) => clip.track === 'video' && currentExportTimeRef.current >= clip.start && currentExportTimeRef.current < clip.start + clip.duration).sort((a, b) => clipTrackIndex(b) - clipTrackIndex(a));
          outputContext.fillStyle = '#0e1015';
          outputContext.fillRect(0, 0, output.width, output.height);
          if (!active.length) drawWelcomeCard(outputContext, output.width, output.height, project.name);
          for (const clip of active) {
            const asset = project.assets.find((item) => item.id === clip.assetId);
            if (!asset || !layerContext) continue;
            layerContext.clearRect(0, 0, layerCanvas.width, layerCanvas.height);
            const transform = getClipAnimationTransform(clip, currentExportTimeRef.current);
            layerContext.save();
            layerContext.globalAlpha = transform.opacity / 100;
            layerContext.translate(layerCanvas.width / 2 + transform.x * layerCanvas.width / 100, layerCanvas.height / 2 + transform.y * layerCanvas.height / 100);
            layerContext.rotate(transform.rotation * Math.PI / 180);
            layerContext.scale(transform.scale / 100, transform.scale / 100);
            layerContext.translate(-layerCanvas.width / 2, -layerCanvas.height / 2);
            applyAnimationMask(layerContext, layerCanvas.width, layerCanvas.height, transform.mask, transform.reveal);
            if (asset.kind === 'title') drawTitleCard(layerContext, layerCanvas.width, layerCanvas.height, clip.name);
            else if (asset.kind === 'image') {
              const image = renderMediaRef.current.get(clip.id);
              if (image instanceof HTMLImageElement && image.complete && image.naturalWidth) drawContained(layerContext, image, layerCanvas.width, layerCanvas.height);
            } else if (asset.kind === 'video') {
              const video = renderMediaRef.current.get(clip.id);
              if (video instanceof HTMLVideoElement && video.readyState >= 2) drawContained(layerContext, video, layerCanvas.width, layerCanvas.height);
            }
            layerContext.restore();
            if (clip.effects?.length || transform.blur > 0) {
              if (effectRendererRef.current === undefined) effectRendererRef.current = createEffectRenderer();
              const renderer = effectRendererRef.current;
              if (renderer) outputContext.drawImage(renderer.render(layerCanvas, clip.effects ?? [], transform.blur), 0, 0, output.width, output.height);
              else {
                applyEffectFallback(layerCanvas, clip.effects ?? [], transform.blur);
                outputContext.drawImage(layerCanvas, 0, 0);
              }
            } else outputContext.drawImage(layerCanvas, 0, 0);
          }
          if (currentExportTimeRef.current < duration && exportingRef.current) requestAnimationFrame(drawExportFrame);
        };
        currentExportTimeRef.current = 0;
        exportingRef.current = true;
        drawExportFrame();
      }
      const recorder = new MediaRecorder(stream, { mimeType: exportFormat });
      recorderRef.current = recorder;
      exportChunksRef.current = [];
      recorder.ondataavailable = (event) => { if (event.data.size) exportChunksRef.current.push(event.data); };
      recorder.onstop = () => {
        const blob = new Blob(exportChunksRef.current, { type: exportFormat });
        const downloadUrl = URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = downloadUrl;
        const extension = exportFormat.startsWith('video/mp4') ? 'mp4' : 'webm';
        link.download = `${project.name.replace(/[^a-z0-9-]+/gi, '-').toLowerCase() || 'video'}.${extension}`;
        link.click();
        URL.revokeObjectURL(downloadUrl);
        exportingRef.current = false;
        cleanup();
      };
      recorder.onerror = () => { exportingRef.current = false; cleanup(); setMediaError('The browser could not finish encoding this export.'); };
      recorder.start(250);
      exportingRef.current = true;
      setPlaying(true);
    } catch (error) {
      exportingRef.current = false;
      cleanup();
      setMediaError(error instanceof Error ? `Could not start export: ${error.message}` : 'Could not start export.');
    }
  }, [assetUrls, currentTime, duration, exportFormat, exportResolution, project, seekTo]);

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
      <EditorHeader
        projectName={project.name}
        saving={saving}
        canUndo={canUndo}
        canRedo={canRedo}
        exporting={exporting}
        canExport={duration > 0}
        onNameChange={(name) => setProject((current) => ({ ...current, name }))}
        onUndo={undoProject}
        onRedo={redoProject}
        onNew={newProject}
        onOpen={() => void showProjectPicker()}
        onSave={saveNow}
        onExport={exportVideo}
      />

      <section className={`workspace${showLeftSidebar ? '' : ' left-sidebar-hidden'}${showRightSidebar ? '' : ' right-sidebar-hidden'}`}>
        {showLeftSidebar && <aside className="left-rail"><button className={`rail-item ${activeSidebarPanel === 'media' ? 'active' : ''}`} onClick={() => setActiveSidebarPanel('media')}><Film size={18} /><span>Media</span></button><button className={`rail-item ${activeSidebarPanel === 'animations' ? 'active' : ''}`} onClick={() => setActiveSidebarPanel('animations')}><Sparkles size={18} /><span>Animations</span></button><button className={`rail-item ${activeSidebarPanel === 'effects' ? 'active' : ''}`} onClick={() => setActiveSidebarPanel('effects')}><SlidersHorizontal size={18} /><span>Effects</span></button><button className="rail-item" onClick={addTitle}><Type size={18} /><span>Text</span></button><button className="rail-item" onClick={addTitle}><Plus size={18} /><span>Title</span></button><button className="rail-item" onClick={() => fileInputRef.current?.click()}><AudioLines size={18} /><span>Audio</span></button></aside>}

        {showLeftSidebar && (activeSidebarPanel === 'media' ? <MediaPanel
          assets={project.assets}
          mediaError={mediaError}
          fileInputRef={fileInputRef}
          projectInputRef={projectInputRef}
          onImportFiles={(files) => void importFiles(files)}
          onImportProject={(file) => void importProjectFile(file)}
          onAddAsset={addAssetToTimeline}
          usedAssetIds={usedAssetIds}
          onDeleteAsset={deleteMediaAsset}
          onHoverAsset={setHoveredMediaAssetId}
        /> : activeSidebarPanel === 'animations' ? <AnimationLibraryPanel selectedClip={selectedClip} onApply={applyAnimation} onRemove={removeAnimation} /> : <EffectsLibraryPanel selectedClip={selectedClip} onChangeEffects={updateClipEffects} />)}

        <section className="preview-area">
          <div className="preview-header"><div className="preview-label"><span className="live-dot" /> CANVAS PREVIEW</div><div className="preview-resolution"><button className="viewer-zoom-step" aria-label="Zoom viewer out" title="Zoom out" onClick={() => adjustViewerZoom(-0.1)}><ZoomOut size={13} /></button><button className="viewer-zoom-reset" title="Reset viewer zoom" onClick={() => { setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }}>{Math.round(viewerZoom * 100)}%</button><button className="viewer-zoom-step" aria-label="Zoom viewer in" title="Zoom in" onClick={() => adjustViewerZoom(0.1)}><ZoomIn size={13} /></button> 1280 × 720 <span>·</span> {formatTime(currentTime)}</div></div>
          <div className={`preview-stage viewer-zoom-surface ${viewerPanning ? 'panning' : ''}`} onPointerDownCapture={trackViewerPointer} onPointerMoveCapture={updateViewerPinch} onPointerUpCapture={endViewerPinch} onPointerCancelCapture={endViewerPinch}><div className="player-frame" style={{ transform: `translate(${viewerPan.x}px, ${viewerPan.y}px) scale(${viewerZoom})`, cursor: viewerPanning ? 'grabbing' : viewerZoom > 1 ? 'grab' : 'default' }}><canvas ref={canvasRef} width={1280} height={720} /><video ref={videoRef} playsInline hidden onLoadedData={() => setPreviewRevision((revision) => revision + 1)} onSeeked={() => setPreviewRevision((revision) => revision + 1)} /><audio ref={audioRef} hidden /><img ref={imageRef} src={activeVideoAsset?.kind === 'image' ? assetUrls.get(activeVideoAsset.id) : undefined} hidden onLoad={() => setPreviewRevision((revision) => revision + 1)} /></div>{!playing && duration > 0 && <button className="viewer-play-button" aria-label="Play video preview" title="Play video preview (Space)" onPointerDown={(event) => event.stopPropagation()} onClick={togglePlayback}><Play size={22} fill="currentColor" /></button>}</div>
          <div className="transport"><div className="time-readout"><span>{formatTime(currentTime)}</span><span className="time-divider">/</span><span className="time-total">{formatTime(duration)}</span></div><button className="play-button" onClick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><div className="transport-right"><button className="icon-button" aria-label="Audio volume"><Volume2 size={17} /></button><button className="quality-button">30 FPS <span>·</span> 720p</button></div></div>
        </section>

        {showRightSidebar && <aside className="properties-panel"><div className="panel-heading"><div><h2>Clip properties</h2><p>{selectedClip?.name ?? 'Select a clip on the timeline'}</p></div><Scissors size={17} className="muted-icon" /></div>{selectedClip ? <div className="properties-content"><label className="field-label">CLIP NAME<input value={selectedClip.name} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, name: event.target.value } : clip) }))} /></label><div className="property-grid"><label className="field-label">START<input type="number" min="0" step="0.1" value={selectedClip.start.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, start: findOpenClipStart(current.clips, clipTrackIndex(clip), Math.max(0, Number(event.target.value)), clip.duration, clip.id) } : clip) }))} /></label><label className="field-label">DURATION<input type="number" min="0.25" step="0.1" value={selectedClip.duration.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, duration: Math.max(0.25, Math.min(current.clips.filter((item) => item.id !== clip.id && clipTrackIndex(item) === clipTrackIndex(clip) && item.start >= clip.start + clip.duration).reduce((start, item) => Math.min(start, item.start), Number.POSITIVE_INFINITY) - clip.start, Number(event.target.value))) } : clip) }))} /></label></div><label className="field-label">TRACK<select value={clipTrackIndex(selectedClip)} onChange={(event) => { const trackIndex = Number(event.target.value); setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, trackIndex, start: findOpenClipStart(current.clips, trackIndex, clip.start, clip.duration, clip.id) } : clip) })); }}>{trackRows.map((index) => <option key={index} value={index}>Track {index + 1}</option>)}</select></label><button className="delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button></div> : <div className="properties-empty"><span className="property-preview-icon"><Scissors size={22} /></span>Click a timeline clip to edit its name, start, duration, or track.</div>}</aside>}
      </section>

      {showTimeline && <section className="timeline-section">
        <div className="timeline-toolbar"><div className="timeline-tools"><button className="tool-button selected" title="Drag over empty track space to select clips; drag a clip to move it"><span className="cursor-icon">↖</span></button><button className="tool-button" title="Split clip at playhead" onClick={() => { const clip = project.clips.find((item) => item.track === 'video' && currentTime > item.start && currentTime < item.start + item.duration); if (!clip) return; const firstDuration = currentTime - clip.start; const second: TimelineClip = { ...clip, id: crypto.randomUUID(), start: currentTime, sourceStart: clip.sourceStart + firstDuration, duration: clip.duration - firstDuration }; setProject((current) => ({ ...current, clips: [...current.clips.map((item) => item.id === clip.id ? { ...item, duration: firstDuration } : item), second] })); setSelectedClipId(second.id); setSelectedClipIds([second.id]); }}><Scissors size={15} /></button><span className="toolbar-separator" /><button className="tool-button track-add-button" onClick={addTrack} title="Add track"><Plus size={15} /></button><button className="tool-button" onClick={addTitle} title="Add title"><Type size={15} /></button><button className="tool-button" onClick={removeSelectedClip} title="Delete selected clip"><Trash2 size={15} /></button></div><div className="timeline-center">Timeline <span className="timeline-duration">{formatTime(duration)}</span></div><div className="zoom-control"><button className="tool-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}><ZoomOut size={15} /></button><input type="range" min="0.5" max="10" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={`Timeline zoom ${zoom.toFixed(1)} times`} /><span className="zoom-level">{zoom.toFixed(1)}×</span><button className="tool-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(10, value + 0.15))}><ZoomIn size={15} /></button></div></div>
        <div className="timeline-body">
          <div className="track-labels"><div className="ruler-spacer" /><div className="track-label-rows" style={{ transform: `translateY(-${timelineScrollTop}px)` }}>{trackRows.map((index) => <div className="track-label" key={index} onContextMenu={(event) => openTrackContextMenu(event, index)}><span>Track {index + 1}</span><span className="track-menu">···</span></div>)}</div></div>
          <div ref={timelineScrollRef} className="timeline-scroll" onContextMenu={openTimelineContextMenu} onScroll={(event) => { setTimelineScrollLeft(event.currentTarget.scrollLeft); setTimelineScrollTop(event.currentTarget.scrollTop); }} onPointerDownCapture={beginTimelineSelection} onPointerMoveCapture={updateTimelineSelection} onPointerUpCapture={(event) => finishTimelineSelection(event, true)} onPointerCancelCapture={(event) => finishTimelineSelection(event, false)}>
            <div className="timeline-inner" style={{ width: timelineWidth }}>
              <div className="ruler" onPointerDown={(event) => { if (event.button !== 0) return; event.preventDefault(); event.currentTarget.setPointerCapture(event.pointerId); const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); seekTo(Math.max(0, (event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom))); }} onPointerMove={(event) => { if (event.buttons) { const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); seekTo(Math.max(0, (event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom))); } }}>
                {Array.from({ length: Math.ceil(duration / 5) + 3 }, (_, index) => <span className="ruler-tick" key={index} style={{ left: `${index * 5 * PIXELS_PER_SECOND * zoom}px` }}>{`00:${String(index * 5).padStart(2, '0')}`}</span>)}
                <span className="playhead-head" style={{ left: `${currentTime * PIXELS_PER_SECOND * zoom}px` }} />
              </div>
              {trackRows.map((index) => <div key={index} className="track-lane" onDragOver={(event) => { if (event.dataTransfer.types.includes('application/x-neupcut-asset') || event.dataTransfer.types.includes('text/plain')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; } }} onDrop={(event) => dropAssetOnTimeline(event, index)} onPointerDown={(event) => { if (event.target === event.currentTarget) seekTo(Math.max(0, (event.clientX - event.currentTarget.getBoundingClientRect().left) / (PIXELS_PER_SECOND * zoom))); }}>
                {project.clips.filter((clip) => clipTrackIndex(clip) === index).map((clip) => {
                  const asset = project.assets.find((item) => item.id === clip.assetId);
                  return <button key={clip.id} data-clip-id={clip.id} className={`timeline-clip ${asset?.kind ?? 'video'} ${selectedClipIds.includes(clip.id) ? 'selected-clip' : ''} ${clip.assetId === hoveredMediaAssetId ? 'media-hover-highlight' : ''}`} style={{ left: `${clip.start * PIXELS_PER_SECOND * zoom}px`, width: `${Math.max(28, clip.duration * PIXELS_PER_SECOND * zoom)}px` }} onPointerDown={(event) => beginClipDrag(event, clip, 'move')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}>
                    <span className="trim-handle left" title="Trim start" onPointerDown={(event) => beginClipDrag(event, clip, 'left')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} />
                    <strong>{clip.track === 'audio' && <Music2 size={11} />} {clip.name}</strong><small>{formatTime(clip.duration)}</small>
                    <span className="trim-handle right" title="Trim end" onPointerDown={(event) => beginClipDrag(event, clip, 'right')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} />
                  </button>;
                })}
              </div>)}
              {selectionBox && <div className="selection-box" style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }} />}
              <div className="playhead-line" style={{ left: `${currentTime * PIXELS_PER_SECOND * zoom}px` }} aria-hidden="true" />
            </div>
          </div>
        </div>
        <div className="timeline-footer"><span><span className="kbd">Drag empty space</span> to select · drag clips to move · edge handles to trim · click ruler to seek</span><span className="timeline-footer-time">{formatTime(currentTime)} <span>/</span> {formatTime(duration)}</span></div>
      </section>}

      {timelineContextMenu && <div className="timeline-context-menu" role="menu" style={{ left: timelineContextMenu.x, top: timelineContextMenu.y }} onContextMenu={(event) => event.preventDefault()}>
        {contextMenuTrackIndex !== undefined && <>
          <button role="menuitem" disabled={trackRows.length <= 1} onClick={() => deleteTrack(contextMenuTrackIndex)}><Trash2 size={14} /> Delete Track {contextMenuTrackIndex + 1}</button>
          <div className="timeline-context-divider" />
        </>}
        {contextMenuClip && <>
          <button role="menuitem" disabled={currentTime <= contextMenuClip.start || currentTime >= contextMenuClip.start + contextMenuClip.duration} onClick={() => { splitClipAtPlayhead(contextMenuClip.id); setTimelineContextMenu(null); }}><Scissors size={14} /> Split at playhead</button>
          {contextMenuClip.track === 'video' && contextMenuAsset?.kind === 'video' && <button role="menuitem" disabled={contextMenuClip.muted} onClick={() => { separateAudioFromVideo(contextMenuClip.id); setTimelineContextMenu(null); }}><AudioLines size={14} /> Separate audio from video</button>}
          <button role="menuitem" onClick={() => { setProject((current) => ({ ...current, clips: current.clips.filter((clip) => clip.id !== contextMenuClip.id) })); setSelectedClipId((id) => id === contextMenuClip.id ? null : id); setSelectedClipIds((ids) => ids.filter((id) => id !== contextMenuClip.id)); setTimelineContextMenu(null); }}><Trash2 size={14} /> Delete clip</button>
          <div className="timeline-context-divider" />
        </>}
        <button role="menuitem" onClick={() => { addTrack(); setTimelineContextMenu(null); }}><Plus size={14} /> Add track</button>
        <button role="menuitem" onClick={() => { addTitle(); setTimelineContextMenu(null); }}><Type size={14} /> Add title at playhead</button>
      </div>}

      {showExportSettings && <div className="modal-backdrop" onClick={() => setShowExportSettings(false)}><section className="export-modal" role="dialog" aria-modal="true" aria-labelledby="export-modal-title" onClick={(event) => event.stopPropagation()}><header><div><h2 id="export-modal-title">Export video</h2><p>Render the complete timeline at your chosen size and format.</p></div><button className="small-icon-button" aria-label="Close export options" onClick={() => setShowExportSettings(false)}>×</button></header><label className="field-label">RESOLUTION<select value={exportResolution} onChange={(event) => setExportResolution(event.target.value as ExportResolution)}>{Object.entries(exportResolutions).map(([value, option]) => <option key={value} value={value}>{option.label} · {option.width} × {option.height}</option>)}</select></label><label className="field-label">FORMAT<select value={exportFormat} onChange={(event) => setExportFormat(event.target.value as ExportFormat)}>{exportFormatOptions.map((option) => { const supported = typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(option.value); return <option key={option.value} value={option.value} disabled={!supported}>{option.label}{supported ? '' : ' · unavailable in this browser'}</option>; })}</select></label><p className="export-format-note">MP4 encoding depends on browser codec support. WebM is available in most browsers.</p>{mediaError && <div className="media-error">{mediaError}</div>}<div className="export-modal-actions"><button onClick={() => setShowExportSettings(false)}>Cancel</button><button className="share-button" disabled={exporting} onClick={() => void startVideoExport()}><Download size={14} /> Start export</button></div></section></div>}

      {showProjects && <div className="modal-backdrop" onClick={() => setShowProjects(false)}><section className="project-modal" onClick={(event) => event.stopPropagation()}><header><div><h2>Open a project</h2><p>Open a local project or import a portable project file.</p></div><button className="small-icon-button" onClick={() => setShowProjects(false)}>×</button></header><div className="project-modal-actions"><button className="new-project-row" onClick={() => { newProject(); setShowProjects(false); }}><FilePlus2 size={17} /> Create a new project</button><button className="new-project-row" onClick={() => projectInputRef.current?.click()}><Upload size={16} /> Import project file</button><button className="new-project-row" onClick={() => void exportProjectFile()}><Download size={16} /> Download project file</button></div>{projectList.map((item) => <div className="project-row" key={item.id}><button onClick={() => void openProject(item.id)}><Clapperboard size={16} /><span><strong>{item.name}</strong><small>Edited {new Date(item.updatedAt).toLocaleString()}</small></span></button>{item.id !== project.id && <button className="project-delete" title="Delete project" onClick={() => { void deleteProject(item.id).then(() => void showProjectPicker()); }}><Trash2 size={14} /></button>}</div>)}</section></div>}
    </main>
  );
}
