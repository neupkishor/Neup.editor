import type { EffectPreset } from './types';

/** Defines the reusable clip effects available in the editor effects library. */
export const effectPresets: EffectPreset[] = [
  { id: 'grayscale', name: 'Black & White', category: 'color', description: 'Remove color for a monochrome look.', filters: [{ name: 'grayscale', min: 0, max: 1 }] },
  { id: 'sepia', name: 'Sepia', category: 'color', description: 'Add a warm, old film tone.', filters: [{ name: 'sepia', min: 0, max: 1 }] },
  { id: 'vintage', name: 'Vintage Film', category: 'color', description: 'Warm color with a softer, faded contrast.', filters: [{ name: 'sepia', min: 0, max: 0.55 }, { name: 'contrast', min: 1, max: 1.25 }, { name: 'saturate', min: 1, max: 0.72 }] },
  { id: 'invert', name: 'Invert', category: 'color', description: 'Reverse the image colors.', filters: [{ name: 'invert', min: 0, max: 1 }] },
  { id: 'cool-tone', name: 'Cool Tone', category: 'color', description: 'Shift the image toward cooler colors.', filters: [{ name: 'hue-rotate', min: 0, max: 190, unit: 'deg' }, { name: 'saturate', min: 1, max: 1.2 }] },
  { id: 'warm-tone', name: 'Warm Tone', category: 'color', description: 'Give the image a subtle golden warmth.', filters: [{ name: 'sepia', min: 0, max: 0.24 }, { name: 'hue-rotate', min: 0, max: -12, unit: 'deg' }] },
  { id: 'vivid', name: 'Vivid Color', category: 'color', description: 'Boost saturation for brighter colors.', filters: [{ name: 'saturate', min: 1, max: 2.4 }] },
  { id: 'brighten', name: 'Brighten', category: 'light', description: 'Lift the exposure of the clip.', filters: [{ name: 'brightness', min: 1, max: 1.8 }] },
  { id: 'dim', name: 'Dim', category: 'light', description: 'Darken the clip for a moodier look.', filters: [{ name: 'brightness', min: 1, max: 0.45 }] },
  { id: 'high-contrast', name: 'High Contrast', category: 'light', description: 'Make shadows and highlights more pronounced.', filters: [{ name: 'contrast', min: 1, max: 1.9 }] },
  { id: 'soft-light', name: 'Soft Light', category: 'light', description: 'Lower contrast and lift the image slightly.', filters: [{ name: 'contrast', min: 1, max: 0.82 }, { name: 'brightness', min: 1, max: 1.12 }] },
  { id: 'soft-focus', name: 'Soft Focus', category: 'focus', description: 'Add a gentle lens blur.', filters: [{ name: 'blur', min: 0, max: 9, unit: 'px' }] },
  { id: 'dreamy', name: 'Dreamy Glow', category: 'focus', description: 'Combine a soft blur with a bright glow.', filters: [{ name: 'blur', min: 0, max: 5, unit: 'px' }, { name: 'brightness', min: 1, max: 1.25 }, { name: 'saturate', min: 1, max: 1.3 }] },
  { id: 'vignette', name: 'Vignette', category: 'focus', description: 'Darken the edges to draw focus inward.', filters: [], overlay: 'vignette' },
];

/** Finds a registered effect preset by its stable identifier. */
export function findEffectPreset(presetId: string) {
  return effectPresets.find((preset) => preset.id === presetId);
}
