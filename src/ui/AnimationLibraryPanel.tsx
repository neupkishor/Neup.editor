import { Check, Film, Sparkles, WandSparkles } from 'lucide-react';
import { useState } from 'react';
import type { TimelineClip } from '../editor/types';
import { animationPresets } from '../editor/animations/presets';
import type { AnimationCategory } from '../editor/animations/types';

type AnimationLibraryPanelProps = {
  selectedClip?: TimelineClip;
  onApply: (presetId: string, duration: number) => void;
  onRemove: () => void;
};

/** Displays reusable animation formats that can be applied to a selected clip. */
export default function AnimationLibraryPanel({ selectedClip, onApply, onRemove }: AnimationLibraryPanelProps) {
  const [category, setCategory] = useState<AnimationCategory>('in');
  const [duration, setDuration] = useState(0.7);
  const applicableClip = selectedClip?.track === 'video' ? selectedClip : undefined;
  const presets = animationPresets.filter((preset) => preset.category === category);

  /** Applies one animation preset to the selected timeline clip. */
  const applyPreset = (presetId: string) => {
    onApply(presetId, duration);
  };

  return (
    <aside className="media-panel animation-library-panel">
      <div className="panel-heading"><div><h2>Animations</h2><p>Choose an effect for a clip</p></div><WandSparkles size={17} className="muted-icon" /></div>
      <div className="animation-target">{applicableClip ? <><Film size={14} /><span>Selected: <strong>{applicableClip.name}</strong></span></> : <span>Select a video clip on the timeline to apply an animation.</span>}</div>
      <div className="animation-tabs"><button className={category === 'in' ? 'active' : ''} onClick={() => setCategory('in')}>Entrance</button><button className={category === 'out' ? 'active' : ''} onClick={() => setCategory('out')}>Exit</button></div>
      <label className="animation-duration">Duration <input type="number" min="0.1" max="5" step="0.1" value={duration} onChange={(event) => setDuration(Math.max(0.1, Math.min(5, Number(event.target.value))))} /> sec</label>
      <div className="animation-preset-list">{presets.map((preset) => {
        const applied = applicableClip?.animation?.presetId === preset.id;
        return <article className={`animation-preset ${applied ? 'applied' : ''}`} key={preset.id}>
          <div className="animation-preset-icon"><Sparkles size={15} /></div>
          <div className="animation-preset-copy"><strong>{preset.name}</strong><small>{preset.description}</small></div>
          <button disabled={!applicableClip} aria-label={`${applied ? 'Reapply' : 'Apply'} ${preset.name}`} onClick={() => applyPreset(preset.id)}>{applied ? <Check size={14} /> : 'Apply'}</button>
        </article>;
      })}</div>
      {applicableClip?.animation && <button className="remove-animation" onClick={onRemove}>Remove animation from clip</button>}
      <div className="panel-tip"><Sparkles size={14} /><span>Animation presets are stored as reusable formats in the editor library.</span></div>
    </aside>
  );
}
