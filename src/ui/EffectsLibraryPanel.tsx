import { Check, Film, SlidersHorizontal, Sparkles } from 'lucide-react';
import { useState } from 'react';
import type { ClipEffect, TimelineClip } from '../editor/types';
import { effectPresets } from '../editor/effects/presets';
import type { EffectCategory } from '../editor/effects/types';

type EffectsLibraryPanelProps = {
  selectedClip?: TimelineClip;
  onChangeEffects: (effects: ClipEffect[]) => void;
};

const categories: Array<{ id: EffectCategory; label: string }> = [
  { id: 'color', label: 'Color' },
  { id: 'light', label: 'Light' },
  { id: 'focus', label: 'Focus' },
];

/** Shows reusable visual effects and lets users stack them on a selected clip. */
export default function EffectsLibraryPanel({ selectedClip, onChangeEffects }: EffectsLibraryPanelProps) {
  const [category, setCategory] = useState<EffectCategory>('color');
  const clip = selectedClip?.track === 'video' ? selectedClip : undefined;
  const effects = clip?.effects ?? [];
  const presets = effectPresets.filter((preset) => preset.category === category);

  /** Adds or removes one effect preset from the selected clip. */
  const toggleEffect = (presetId: string) => {
    const existing = effects.some((effect) => effect.presetId === presetId);
    onChangeEffects(existing ? effects.filter((effect) => effect.presetId !== presetId) : [...effects, { presetId, amount: 100 }]);
  };

  /** Changes the intensity of an effect already applied to the selected clip. */
  const changeIntensity = (presetId: string, amount: number) => {
    onChangeEffects(effects.map((effect) => effect.presetId === presetId ? { ...effect, amount } : effect));
  };

  return (
    <aside className="media-panel effects-library-panel">
      <div className="panel-heading"><div><h2>Effects</h2><p>Stack visual effects on a clip</p></div><SlidersHorizontal size={17} className="muted-icon" /></div>
      <div className="animation-target">{clip ? <><Film size={14} /><span>Selected: <strong>{clip.name}</strong></span></> : <span>Select a video clip on the timeline to add effects.</span>}</div>
      <div className="effect-tabs">{categories.map((item) => <button key={item.id} className={category === item.id ? 'active' : ''} onClick={() => setCategory(item.id)}>{item.label}</button>)}</div>
      <div className="effect-preset-list">{presets.map((preset) => {
        const current = effects.find((effect) => effect.presetId === preset.id);
        return <article className={`effect-preset ${current ? 'applied' : ''}`} key={preset.id}>
          <div className="effect-preset-heading"><span className="animation-preset-icon"><Sparkles size={14} /></span><div className="animation-preset-copy"><strong>{preset.name}</strong><small>{preset.description}</small></div><button disabled={!clip} onClick={() => toggleEffect(preset.id)} aria-label={`${current ? 'Remove' : 'Add'} ${preset.name}`}>{current ? <Check size={14} /> : 'Add'}</button></div>
          {current && <label className="effect-intensity">Intensity <input type="range" min="0" max="100" value={current.amount} onChange={(event) => changeIntensity(preset.id, Number(event.target.value))} /><span>{current.amount}%</span></label>}
        </article>;
      })}</div>
      {clip && effects.length > 0 && <button className="remove-animation" onClick={() => onChangeEffects([])}>Remove all effects</button>}
      <div className="panel-tip"><Sparkles size={14} /><span>Effects stack independently from clip animations.</span></div>
    </aside>
  );
}
