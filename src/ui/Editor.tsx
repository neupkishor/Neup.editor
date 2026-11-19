import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { AudioLines, Check, Clapperboard, Download, FilePlus2, Film, Music2, Pause, Play, Plus, Scissors, Trash2, Type, Upload, Video, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import { deleteProject, listProjects, loadProject, saveProject } from '../editor/storage';
import { blobToDataUrl, createProject, dataUrlToBlob, formatTime, getMediaKind, readMediaDuration } from '../editor/helpers';
import type { EditorProject, MediaAsset, ProjectSummary, TimelineClip, TrackKind } from '../editor/types';
import EditorHeader from './EditorHeader';
import MediaPanel from './MediaPanel';

const PROJECT_KEY = 'neupcut-current-project';
const PIXELS_PER_SECOND = 12;
const FRAME_RATE = 30;

type DragState = { clipId: string; mode: 'move' | 'left' | 'right'; pointerX: number; start: number; duration: number; sourceStart: number; maxDuration: number; track: TrackKind };
type SelectionBox = { pointerId: number; startX: number; startY: number; currentX: number; currentY: number; left: number; top: number; width: number; height: number };
type ProjectHistory = { projectId: string; past: EditorProject[]; present: EditorProject; future: EditorProject[]; pendingBefore: EditorProject | null; timer: number | null };

/** Provides a working browser based video editor with local projects and export. */
export default function Editor() {
  const [project, setProject] = useState<EditorProject>(() => createProject());
  const [, setHistoryRevision] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved');
  const [zoom, setZoom] = useState(1);
  const [timelineScrollLeft, setTimelineScrollLeft] = useState(0);
  const [viewerZoom, setViewerZoom] = useState(1);
  const [viewerPan, setViewerPan] = useState({ x: 0, y: 0 });
  const [viewerPanning, setViewerPanning] = useState(false);
  const [selectedClipId, setSelectedClipId] = useState<string | null>(null);
  const [selectedClipIds, setSelectedClipIds] = useState<string[]>([]);
  const [selectionBox, setSelectionBox] = useState<SelectionBox | null>(null);
  const [projectList, setProjectList] = useState<ProjectSummary[]>([]);
  const [showProjects, setShowProjects] = useState(false);
  const [exporting, setExporting] = useState(false);
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
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const selectionRef = useRef<SelectionBox | null>(null);
  const urlsRef = useRef<Map<string, string>>(new Map());
  const timeRef = useRef(0);
  const recorderRef = useRef<MediaRecorder | null>(null);
  const exportChunksRef = useRef<Blob[]>([]);
  const historyRef = useRef<ProjectHistory | null>(null);
  const canUndo = Boolean(historyRef.current?.past.length || historyRef.current?.pendingBefore);
  const canRedo = Boolean(historyRef.current?.future.length);

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
        setProject(stored);
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
      setSelectedClipIds([added[0].id]);
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
    setSelectedClipIds([clip.id]);
  }, [currentTime]);

  /** Adds another instance of an existing media asset at the playhead. */
  const addAssetToTimeline = useCallback((asset: MediaAsset) => {
    const track: TrackKind = asset.kind === 'audio' ? 'audio' : 'video';
    const clip: TimelineClip = { id: crypto.randomUUID(), assetId: asset.id, name: asset.name, track, start: currentTime, duration: Math.max(0.5, asset.duration), sourceStart: 0 };
    setProject((current) => ({ ...current, clips: [...current.clips, clip] }));
    setSelectedClipId(clip.id);
    setSelectedClipIds([clip.id]);
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
    setSelectedClipIds([]);
    setProject(stored);
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
      const restored: EditorProject = { ...archive.project, assets: archive.project.assets.map(({ blobData, ...asset }) => ({ ...asset, blob: blobData ? dataUrlToBlob(blobData) : undefined })) };
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

  /** Deletes the current timeline selection when Backspace or Delete is pressed. */
  useEffect(() => {
    const handleEditorShortcut = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof HTMLElement && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName))) return;
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        if (event.shiftKey) redoProject();
        else undoProject();
        return;
      }
      if (command && event.key.toLowerCase() === 'y') {
        event.preventDefault();
        redoProject();
        return;
      }
      if (event.key !== 'Backspace' && event.key !== 'Delete') return;
      if (!selectedClipIds.length && !selectedClipId) return;
      event.preventDefault();
      removeSelectedClip();
    };
    window.addEventListener('keydown', handleEditorShortcut);
    return () => window.removeEventListener('keydown', handleEditorShortcut);
  }, [redoProject, removeSelectedClip, selectedClipId, selectedClipIds.length, undoProject]);

  /** Starts moving or trimming a clip based on the pointer target. */
  const beginClipDrag = (event: ReactPointerEvent<HTMLElement>, clip: TimelineClip, mode: DragState['mode']) => {
    event.preventDefault();
    event.stopPropagation();
    setSelectedClipId(clip.id);
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      setSelectedClipIds((current) => current.includes(clip.id) ? current.filter((id) => id !== clip.id) : [...current, clip.id]);
    } else {
      setSelectedClipIds([clip.id]);
    }
    const asset = project.assets.find((item) => item.id === clip.assetId);
    dragRef.current = { clipId: clip.id, mode, pointerX: event.clientX, start: clip.start, duration: clip.duration, sourceStart: clip.sourceStart, maxDuration: asset?.duration ?? Number.POSITIVE_INFINITY, track: clip.track };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  /** Moves the active clip or adjusts its source in and duration while dragging. */
  const updateClipDrag = (event: ReactPointerEvent<HTMLElement>) => {
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

      <section className="workspace">
        <aside className="left-rail"><button className="rail-item active"><Film size={18} /><span>Media</span></button><button className="rail-item" onClick={addTitle}><Type size={18} /><span>Text</span></button><button className="rail-item" onClick={addTitle}><Plus size={18} /><span>Title</span></button><button className="rail-item" onClick={() => fileInputRef.current?.click()}><AudioLines size={18} /><span>Audio</span></button></aside>

        <MediaPanel
          assets={project.assets}
          mediaError={mediaError}
          fileInputRef={fileInputRef}
          projectInputRef={projectInputRef}
          onImportFiles={(files) => void importFiles(files)}
          onImportProject={(file) => void importProjectFile(file)}
          onAddAsset={addAssetToTimeline}
        />

        <section className="preview-area">
          <div className="preview-header"><div className="preview-label"><span className="live-dot" /> CANVAS PREVIEW</div><div className="preview-resolution"><button className="viewer-zoom-step" aria-label="Zoom viewer out" title="Zoom out" onClick={() => adjustViewerZoom(-0.1)}><ZoomOut size={13} /></button><button className="viewer-zoom-reset" title="Reset viewer zoom" onClick={() => { setViewerZoom(1); setViewerPan({ x: 0, y: 0 }); }}>{Math.round(viewerZoom * 100)}%</button><button className="viewer-zoom-step" aria-label="Zoom viewer in" title="Zoom in" onClick={() => adjustViewerZoom(0.1)}><ZoomIn size={13} /></button> 1280 × 720 <span>·</span> {formatTime(currentTime)}</div></div>
          <div className={`preview-stage viewer-zoom-surface ${viewerPanning ? 'panning' : ''}`} onPointerDownCapture={trackViewerPointer} onPointerMoveCapture={updateViewerPinch} onPointerUpCapture={endViewerPinch} onPointerCancelCapture={endViewerPinch}><div className="player-frame" style={{ transform: `translate(${viewerPan.x}px, ${viewerPan.y}px) scale(${viewerZoom})`, cursor: viewerPanning ? 'grabbing' : viewerZoom > 1 ? 'grab' : 'default' }}><canvas ref={canvasRef} width={1280} height={720} /><video ref={videoRef} playsInline hidden /><audio ref={audioRef} hidden /><img ref={imageRef} src={activeVideoAsset?.kind === 'image' ? assetUrls.get(activeVideoAsset.id) : undefined} hidden onLoad={() => setCurrentTime((time) => time)} /></div></div>
          <div className="transport"><div className="time-readout"><span>{formatTime(currentTime)}</span><span className="time-divider">/</span><span className="time-total">{formatTime(duration)}</span></div><button className="play-button" onClick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <Pause size={17} fill="currentColor" /> : <Play size={17} fill="currentColor" />}</button><div className="transport-right"><button className="icon-button" aria-label="Audio volume"><Volume2 size={17} /></button><button className="quality-button">30 FPS <span>·</span> 720p</button></div></div>
        </section>

        <aside className="properties-panel"><div className="panel-heading"><div><h2>Clip properties</h2><p>{selectedClip?.name ?? 'Select a clip on the timeline'}</p></div><Scissors size={17} className="muted-icon" /></div>{selectedClip ? <div className="properties-content"><label className="field-label">CLIP NAME<input value={selectedClip.name} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, name: event.target.value } : clip) }))} /></label><div className="property-grid"><label className="field-label">START<input type="number" min="0" step="0.1" value={selectedClip.start.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, start: Math.max(0, Number(event.target.value)) } : clip) }))} /></label><label className="field-label">DURATION<input type="number" min="0.25" step="0.1" value={selectedClip.duration.toFixed(2)} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, duration: Math.max(0.25, Number(event.target.value)) } : clip) }))} /></label></div><label className="field-label">TRACK<select value={selectedClip.track} onChange={(event) => setProject((current) => ({ ...current, clips: current.clips.map((clip) => clip.id === selectedClip.id ? { ...clip, track: event.target.value as TrackKind } : clip) }))}><option value="video">Video 1</option><option value="audio">Audio 1</option></select></label><button className="delete-clip" onClick={removeSelectedClip}><Trash2 size={14} /> Remove clip</button></div> : <div className="properties-empty"><span className="property-preview-icon"><Scissors size={22} /></span>Click a timeline clip to edit its name, start, duration, or track.</div>}</aside>
      </section>

      <section className="timeline-section">
        <div className="timeline-toolbar"><div className="timeline-tools"><button className="tool-button selected" title="Drag over empty track space to select clips; drag a clip to move it"><span className="cursor-icon">↖</span></button><button className="tool-button" title="Split clip at playhead" onClick={() => { const clip = project.clips.find((item) => item.track === 'video' && currentTime > item.start && currentTime < item.start + item.duration); if (!clip) return; const firstDuration = currentTime - clip.start; const second: TimelineClip = { ...clip, id: crypto.randomUUID(), start: currentTime, sourceStart: clip.sourceStart + firstDuration, duration: clip.duration - firstDuration }; setProject((current) => ({ ...current, clips: [...current.clips.map((item) => item.id === clip.id ? { ...item, duration: firstDuration } : item), second] })); setSelectedClipId(second.id); setSelectedClipIds([second.id]); }}><Scissors size={15} /></button><span className="toolbar-separator" /><button className="tool-button" onClick={addTitle} title="Add title"><Type size={15} /></button><button className="tool-button" onClick={removeSelectedClip} title="Delete selected clip"><Trash2 size={15} /></button></div><div className="timeline-center">Timeline <span className="timeline-duration">{formatTime(duration)}</span></div><div className="zoom-control"><button className="tool-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.5, value - 0.15))}><ZoomOut size={15} /></button><input type="range" min="0.5" max="10" step="0.1" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} aria-label={`Timeline zoom ${zoom.toFixed(1)} times`} /><span className="zoom-level">{zoom.toFixed(1)}×</span><button className="tool-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(10, value + 0.15))}><ZoomIn size={15} /></button></div></div>
        <div className="timeline-body">
          <div className="track-labels"><div className="ruler-spacer" /><div className="track-label"><Video size={15} /><span>Video 1</span><span className="track-menu">···</span></div><div className="track-label"><Music2 size={15} /><span>Audio 1</span><span className="track-menu">···</span></div></div>
          <div ref={timelineScrollRef} className="timeline-scroll" onScroll={(event) => setTimelineScrollLeft(event.currentTarget.scrollLeft)} onPointerDownCapture={beginTimelineSelection} onPointerMoveCapture={updateTimelineSelection} onPointerUpCapture={(event) => finishTimelineSelection(event, true)} onPointerCancelCapture={(event) => finishTimelineSelection(event, false)}>
            <div className="timeline-inner" style={{ width: timelineWidth }} onPointerDown={(event) => { if (event.target === event.currentTarget || (event.target as HTMLElement).classList.contains('ruler')) { const bounds = event.currentTarget.getBoundingClientRect(); seekTo(Math.max(0, (event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom))); } }}>
              <div className="ruler">{Array.from({ length: Math.ceil(duration / 5) + 3 }, (_, index) => <button className="ruler-tick" key={index} style={{ left: `${index * 5 * PIXELS_PER_SECOND * zoom}px` }} onClick={() => seekTo(index * 5)}>{`00:${String(index * 5).padStart(2, '0')}`}</button>)}</div>
              {(['video', 'audio'] as const).map((track) => <div key={track} className={`track-lane ${track}-lane`} onPointerDown={(event) => { if (event.target === event.currentTarget) seekTo(Math.max(0, (event.clientX - event.currentTarget.getBoundingClientRect().left) / (PIXELS_PER_SECOND * zoom))); }}>
                {project.clips.filter((clip) => clip.track === track).map((clip) => {
                  const asset = project.assets.find((item) => item.id === clip.assetId);
                  return <button key={clip.id} data-clip-id={clip.id} className={`timeline-clip ${asset?.kind ?? 'video'} ${selectedClipIds.includes(clip.id) ? 'selected-clip' : ''}`} style={{ left: `${clip.start * PIXELS_PER_SECOND * zoom}px`, width: `${Math.max(28, clip.duration * PIXELS_PER_SECOND * zoom)}px` }} onPointerDown={(event) => beginClipDrag(event, clip, 'move')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} onPointerCancel={endClipDrag}>
                    <span className="trim-handle left" title="Trim start" onPointerDown={(event) => beginClipDrag(event, clip, 'left')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} />
                    <strong>{track === 'audio' && <Music2 size={11} />} {clip.name}</strong><small>{formatTime(clip.duration)}</small>
                    <span className="trim-handle right" title="Trim end" onPointerDown={(event) => beginClipDrag(event, clip, 'right')} onPointerMove={(event) => { if (!(event.pointerType === 'touch' && pinchRef.current)) updateClipDrag(event); }} onPointerUp={endClipDrag} />
                  </button>;
                })}
              </div>)}
              {selectionBox && <div className="selection-box" style={{ left: selectionBox.left, top: selectionBox.top, width: selectionBox.width, height: selectionBox.height }} />}
              <button className="playhead" style={{ left: `${currentTime * PIXELS_PER_SECOND * zoom}px` }} aria-label="Seek playhead" onPointerDown={(event) => { event.stopPropagation(); (event.currentTarget as HTMLButtonElement).setPointerCapture(event.pointerId); }} onPointerMove={(event) => { if (event.buttons) { const bounds = event.currentTarget.parentElement!.getBoundingClientRect(); seekTo((event.clientX - bounds.left) / (PIXELS_PER_SECOND * zoom)); } }} />
            </div>
          </div>
        </div>
        <div className="timeline-footer"><span><span className="kbd">Drag empty space</span> to select · drag clips to move · edge handles to trim · click ruler to seek</span><span>{selectedClipIds.length > 1 ? `${selectedClipIds.length} clips selected · ` : ''}{project.clips.length} clips · Autosaved to this browser {saving === 'saved' && <Check size={11} />}</span></div>
      </section>

      {showProjects && <div className="modal-backdrop" onClick={() => setShowProjects(false)}><section className="project-modal" onClick={(event) => event.stopPropagation()}><header><div><h2>Open a project</h2><p>Open a local project or import a portable project file.</p></div><button className="small-icon-button" onClick={() => setShowProjects(false)}>×</button></header><div className="project-modal-actions"><button className="new-project-row" onClick={() => { newProject(); setShowProjects(false); }}><FilePlus2 size={17} /> Create a new project</button><button className="new-project-row" onClick={() => projectInputRef.current?.click()}><Upload size={16} /> Import project file</button><button className="new-project-row" onClick={() => void exportProjectFile()}><Download size={16} /> Download project file</button></div>{projectList.map((item) => <div className="project-row" key={item.id}><button onClick={() => void openProject(item.id)}><Clapperboard size={16} /><span><strong>{item.name}</strong><small>Edited {new Date(item.updatedAt).toLocaleString()}</small></span></button>{item.id !== project.id && <button className="project-delete" title="Delete project" onClick={() => { void deleteProject(item.id).then(() => void showProjectPicker()); }}><Trash2 size={14} /></button>}</div>)}</section></div>}
    </main>
  );
}
