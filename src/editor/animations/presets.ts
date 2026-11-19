import type { AnimationPreset, AnimationTransform } from './types';

const center: AnimationTransform = { x: 0, y: 0, scale: 100, opacity: 100, rotation: 0, blur: 0, reveal: 100 };

/** Holds the animation formats available in the editor's animation library. */
export const animationPresets: AnimationPreset[] = [
  { id: 'fade-in', name: 'Fade In', category: 'in', description: 'Fade smoothly into the scene.', duration: 0.7, from: { ...center, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'slide-left-in', name: 'Slide from Left', category: 'in', description: 'Move into frame from the left.', duration: 0.65, from: { ...center, x: -100, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'slide-right-in', name: 'Slide from Right', category: 'in', description: 'Move into frame from the right.', duration: 0.65, from: { ...center, x: 100, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'slide-up-in', name: 'Slide from Bottom', category: 'in', description: 'Rise into frame from below.', duration: 0.65, from: { ...center, y: 100, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'slide-down-in', name: 'Slide from Top', category: 'in', description: 'Drop into frame from above.', duration: 0.65, from: { ...center, y: -100, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'zoom-in', name: 'Zoom In', category: 'in', description: 'Grow from a smaller scale.', duration: 0.6, from: { ...center, scale: 55, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'pop-in', name: 'Pop In', category: 'in', description: 'Bounce into frame with a quick scale-up.', duration: 0.55, from: { ...center, scale: 35, opacity: 0, rotation: -8 }, to: center, easing: 'spring' },
  { id: 'spin-in', name: 'Spin In', category: 'in', description: 'Rotate into place while scaling up.', duration: 0.8, from: { ...center, scale: 45, opacity: 0, rotation: -220 }, to: center, easing: 'ease-out' },
  { id: 'blur-in', name: 'Blur In', category: 'in', description: 'Sharpen from a soft, blurred image.', duration: 0.75, from: { ...center, blur: 24, opacity: 0 }, to: center, easing: 'ease-out' },
  { id: 'morph-in', name: 'Morph Reveal', category: 'in', description: 'Bloom from an organic shape and settle into the frame.', duration: 0.9, from: { ...center, scale: 55, opacity: 0, rotation: -12, reveal: 0 }, to: center, easing: 'ease-out', mask: 'morph' },
  { id: 'fade-out', name: 'Fade Out', category: 'out', description: 'Fade away at the end of the clip.', duration: 0.7, from: center, to: { ...center, opacity: 0 }, easing: 'ease-in' },
  { id: 'slide-left-out', name: 'Slide to Left', category: 'out', description: 'Move out of frame to the left.', duration: 0.65, from: center, to: { ...center, x: -100, opacity: 0 }, easing: 'ease-in' },
  { id: 'slide-right-out', name: 'Slide to Right', category: 'out', description: 'Move out of frame to the right.', duration: 0.65, from: center, to: { ...center, x: 100, opacity: 0 }, easing: 'ease-in' },
  { id: 'slide-down-out', name: 'Drop Out', category: 'out', description: 'Fall down and out of frame.', duration: 0.65, from: center, to: { ...center, y: 100, opacity: 0 }, easing: 'ease-in' },
  { id: 'zoom-out', name: 'Zoom Out', category: 'out', description: 'Shrink away at the end of the clip.', duration: 0.6, from: center, to: { ...center, scale: 55, opacity: 0 }, easing: 'ease-in' },
  { id: 'spin-out', name: 'Spin Out', category: 'out', description: 'Rotate away as the clip ends.', duration: 0.8, from: center, to: { ...center, scale: 45, opacity: 0, rotation: 220 }, easing: 'ease-in' },
  { id: 'blur-out', name: 'Blur Out', category: 'out', description: 'Soften and blur as the image fades away.', duration: 0.75, from: center, to: { ...center, blur: 24, opacity: 0 }, easing: 'ease-in' },
  { id: 'morph-out', name: 'Morph Away', category: 'out', description: 'Contract into an organic shape and disappear.', duration: 0.9, from: center, to: { ...center, scale: 55, opacity: 0, rotation: 12, reveal: 0 }, easing: 'ease-in', mask: 'morph' },
];

/** Finds a registered animation preset by its stable identifier. */
export function findAnimationPreset(presetId: string) {
  return animationPresets.find((preset) => preset.id === presetId);
}
