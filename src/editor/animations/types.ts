export type AnimationCategory = 'in' | 'out';

export type AnimationTransform = {
  x: number;
  y: number;
  scale: number;
  opacity: number;
  rotation: number;
  blur: number;
  reveal: number;
  mask?: 'morph';
};

export type AnimationPreset = {
  id: string;
  name: string;
  category: AnimationCategory;
  description: string;
  duration: number;
  from: AnimationTransform;
  to: AnimationTransform;
  easing: 'ease-out' | 'ease-in' | 'ease-in-out' | 'spring';
  mask?: 'morph';
};
