import { useCallback, useMemo, useRef, useState } from 'react';
import { Player, type PlayerRef } from '@remotion/player';
import { AudioLines, Clapperboard, Download, Film, ImagePlus, Layers3, MousePointer2, Music2, Play, Plus, Settings2, Sparkles, Type, Upload, Video, Volume2, ZoomIn, ZoomOut } from 'lucide-react';
import { VideoComposition } from '../remotion/VideoComposition';

type Clip = { id: number; name: string; color: string; duration: number; kind: 'video' | 'audio' | 'text' };

const initialClips: Clip[] = [
  { id: 1, name: 'Opening title', color: 'violet', duration: 6, kind: 'text' },
  { id: 2, name: 'Summer memories.mp4', color: 'blue', duration: 10, kind: 'video' },
  { id: 3, name: 'Ambient piano.wav', color: 'green', duration: 15, kind: 'audio' },
];

/** Converts seconds to the editor's compact timecode display. */
function formatTime(seconds: number): string {
  const minutes = Math.floor(seconds / 60).toString().padStart(2, '0');
  const remainder = Math.floor(seconds % 60).toString().padStart(2, '0');
  const frames = Math.floor((seconds % 1) * 30).toString().padStart(2, '0');
  return `${minutes}:${remainder}:${frames}`;
}

/** Main editor shell with a Remotion preview and a lightweight editable timeline. */
export default function Editor() {
  const playerRef = useRef<PlayerRef>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [clips, setClips] = useState(initialClips);
  const [selected, setSelected] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [currentFrame, setCurrentFrame] = useState(0);
  const [zoom, setZoom] = useState(1);
  const totalSeconds = useMemo(() => Math.max(20, clips.reduce((sum, clip) => sum + clip.duration, 0)), [clips]);

  const addFiles = useCallback((files: FileList | null) => {
    if (!files?.length) return;
    const additions = Array.from(files).map((file, index): Clip => ({
      id: Date.now() + index,
      name: file.name,
      color: file.type.startsWith('audio/') ? 'green' : 'blue',
      duration: 8,
      kind: file.type.startsWith('audio/') ? 'audio' : 'video',
    }));
    setClips((current) => [...current, ...additions]);
  }, []);

  const togglePlayback = useCallback(() => {
    if (!playerRef.current) return;
    if (playing) playerRef.current.pause();
    else playerRef.current.play();
    setPlaying(!playing);
  }, [playing]);

  return (
    <main className="editor-shell">
      <header className="topbar">
        <div className="brand"><div className="brand-mark"><Clapperboard size={18} /></div><span>neup<span className="brand-light">cut</span></span><span className="beta">BETA</span></div>
        <div className="project-name">Untitled project <span className="saved-dot" /></div>
        <div className="top-actions"><button className="icon-button" aria-label="Settings"><Settings2 size={17} /></button><button className="share-button" onClick={() => window.alert('Export rendering is the next step for this starter editor.') }><Download size={15} /> Export</button></div>
      </header>

      <section className="workspace">
        <aside className="left-rail">
          <button className="rail-item active"><Film size={18} /><span>Media</span></button>
          <button className="rail-item"><Type size={18} /><span>Text</span></button>
          <button className="rail-item"><Sparkles size={18} /><span>Effects</span></button>
          <button className="rail-item"><AudioLines size={18} /><span>Audio</span></button>
        </aside>

        <aside className="media-panel">
          <div className="panel-heading"><div><h2>Media</h2><p>Your project assets</p></div><button className="small-icon-button" aria-label="Add media" onClick={() => fileInputRef.current?.click()}><Plus size={17} /></button></div>
          <button className="import-card" onClick={() => fileInputRef.current?.click()}><div className="upload-icon"><Upload size={18} /></div><strong>Import media</strong><span>Video, audio, or images</span></button>
          <input ref={fileInputRef} type="file" accept="video/*,audio/*,image/*" multiple hidden onChange={(event) => addFiles(event.target.files)} />
          <div className="asset-heading"><span>IN THIS PROJECT</span><span>{clips.length} items</span></div>
          <div className="asset-list">
            {clips.map((clip) => <button key={clip.id} className={`asset-row ${selected === clip.id ? 'chosen' : ''}`} onClick={() => setSelected(clip.id)}><span className={`asset-thumb ${clip.color}`}>{clip.kind === 'video' ? <Video size={16} /> : clip.kind === 'audio' ? <Music2 size={16} /> : <Type size={16} />}</span><span className="asset-copy"><strong>{clip.name}</strong><small>{clip.kind === 'text' ? 'Title card' : clip.kind === 'audio' ? 'Audio' : 'Video'} · {clip.duration}s</small></span><span className="asset-more">···</span></button>)}
          </div>
          <div className="panel-tip"><Sparkles size={15} /><span>Drop files here to add them to your project.</span></div>
        </aside>

        <section className="preview-area">
          <div className="preview-header"><div className="preview-label"><span className="live-dot" /> PREVIEW</div><div className="preview-resolution">16:9 <span>·</span> 720p</div></div>
          <div className="preview-stage"><div className="player-frame"><Player ref={playerRef} component={VideoComposition} durationInFrames={150} compositionWidth={1280} compositionHeight={720} fps={30} controls={false} loop style={{ width: '100%', height: '100%' }} onFrameUpdate={setCurrentFrame} onPlay={() => setPlaying(true)} onPause={() => setPlaying(false)} /></div></div>
          <div className="transport"><div className="time-readout"><span>{formatTime(currentFrame / 30)}</span><span className="time-divider">/</span><span className="time-total">00:05:00</span></div><button className="play-button" onClick={togglePlayback} aria-label={playing ? 'Pause' : 'Play'}>{playing ? <span className="pause-glyph">Ⅱ</span> : <Play size={17} fill="currentColor" />}</button><div className="transport-right"><button className="icon-button" aria-label="Volume"><Volume2 size={17} /></button><button className="quality-button">Fit <span>⌄</span></button></div></div>
        </section>

        <aside className="properties-panel"><div className="panel-heading"><div><h2>Properties</h2><p>{clips.find((clip) => clip.id === selected)?.name ?? 'Nothing selected'}</p></div><Layers3 size={17} className="muted-icon" /></div><div className="properties-content"><div className="property-preview"><div className="property-preview-icon"><ImagePlus size={21} /></div><span>Clip properties</span></div><label className="field-label">NAME<input value={clips.find((clip) => clip.id === selected)?.name ?? ''} onChange={(event) => setClips((current) => current.map((clip) => clip.id === selected ? { ...clip, name: event.target.value } : clip))} /></label><div className="property-grid"><label className="field-label">START<input value="00:00:00" readOnly /></label><label className="field-label">DURATION<input value="00:06:00" readOnly /></label></div><div className="property-divider" /><div className="section-label">TRANSFORM</div><div className="property-grid"><label className="field-label">SCALE<input value="100%" readOnly /></label><label className="field-label">OPACITY<input value="100%" readOnly /></label></div><button className="add-property"><Plus size={15} /> Add property</button></div></aside>
      </section>

      <section className="timeline-section">
        <div className="timeline-toolbar"><div className="timeline-tools"><button className="tool-button selected"><MousePointer2 size={16} /></button><button className="tool-button"><AudioLines size={16} /></button><span className="toolbar-separator" /><button className="tool-button" onClick={() => setClips((current) => [...current, { id: Date.now(), name: 'New title', color: 'violet', duration: 5, kind: 'text' }])} aria-label="Add title"><Type size={16} /></button></div><div className="timeline-center">Timeline <span className="timeline-duration">00:00 – 00:31</span></div><div className="zoom-control"><button className="tool-button" aria-label="Zoom out" onClick={() => setZoom((value) => Math.max(0.65, value - 0.15))}><ZoomOut size={15} /></button><input type="range" min="0.65" max="1.8" step="0.05" value={zoom} onChange={(event) => setZoom(Number(event.target.value))} /><button className="tool-button" aria-label="Zoom in" onClick={() => setZoom((value) => Math.min(1.8, value + 0.15))}><ZoomIn size={15} /></button></div></div>
        <div className="timeline-body"><div className="track-labels"><div className="ruler-spacer" /><div className="track-label"><Video size={15} /><span>Video 1</span><span className="track-menu">···</span></div><div className="track-label"><Music2 size={15} /><span>Audio 1</span><span className="track-menu">···</span></div></div><div className="timeline-scroll"><div className="timeline-inner" style={{ '--zoom': zoom } as React.CSSProperties}><div className="ruler">{Array.from({ length: Math.ceil(totalSeconds / 5) + 1 }, (_, index) => <div className="ruler-tick" key={index} style={{ left: `${index * 5 * 10}px` }}><span>{`00:${String(index * 5).padStart(2, '0')}`}</span></div>)}</div><div className="track-lane video-lane">{clips.filter((clip) => clip.kind !== 'audio').map((clip, index) => <button key={clip.id} className={`timeline-clip ${clip.color} ${selected === clip.id ? 'selected-clip' : ''}`} style={{ left: `${clips.filter((item) => item.kind !== 'audio').slice(0, index).reduce((sum, item) => sum + item.duration * 10, 0)}px`, width: `${clip.duration * 10}px` }} onClick={() => setSelected(clip.id)}><span className="clip-filmstrip"><span /><span /><span /><span /></span><strong>{clip.name}</strong></button>)}</div><div className="track-lane audio-lane">{clips.filter((clip) => clip.kind === 'audio').map((clip) => <button key={clip.id} className={`timeline-clip audio-clip ${clip.color} ${selected === clip.id ? 'selected-clip' : ''}`} style={{ left: '0px', width: `${clip.duration * 10}px` }} onClick={() => setSelected(clip.id)}><span className="waveform">▁▃▅▃▆▂▅▇▃▅▂▆▃▅▂▇▅▃▆▂▅▃▇▂▅▃▆▂▅▇▃▅▂</span><strong><Music2 size={12} /> {clip.name}</strong></button>)}</div><div className="playhead" style={{ left: `${(currentFrame / 30) * 10}px` }} /></div></div></div>
        <div className="timeline-footer"><span><span className="kbd">⌘</span> + <span className="kbd">K</span> split clip</span><span>Drag clips to rearrange · Starter timeline</span></div>
      </section>
    </main>
  );
}
