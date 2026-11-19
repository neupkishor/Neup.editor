export type EffectCategory = 'color' | 'light' | 'focus';
export type CanvasFilterName = 'grayscale' | 'sepia' | 'invert' | 'brightness' | 'contrast' | 'saturate' | 'blur' | 'hue-rotate';

export type EffectPreset = {
  id: string;
  name: string;
  category: EffectCategory;
  description: string;
  filters: Array<{ name: CanvasFilterName; min: number; max: number; unit?: 'px' | 'deg' }>;
  overlay?: 'vignette';
};
