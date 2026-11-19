import type { ClipEffect } from '../types';
import { findEffectPreset } from './presets';
import type { CanvasFilterName } from './types';

type PixelFilter = { name: CanvasFilterName; value: number };
type RGB = [number, number, number];

/** Converts a selected pixel through one configured visual filter. */
function applyPixelFilter(color: RGB, filter: PixelFilter): RGB {
  const [red, green, blue] = color;
  if (filter.name === 'grayscale') {
    const gray = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    const amount = Math.max(0, Math.min(1, filter.value));
    return [red + (gray - red) * amount, green + (gray - green) * amount, blue + (gray - blue) * amount];
  }
  if (filter.name === 'sepia') {
    const amount = Math.max(0, Math.min(1, filter.value));
    const sepia: RGB = [red * 0.393 + green * 0.769 + blue * 0.189, red * 0.349 + green * 0.686 + blue * 0.168, red * 0.272 + green * 0.534 + blue * 0.131];
    return [red + (sepia[0] - red) * amount, green + (sepia[1] - green) * amount, blue + (sepia[2] - blue) * amount];
  }
  if (filter.name === 'invert') {
    const amount = Math.max(0, Math.min(1, filter.value));
    return [red + (1 - 2 * red) * amount, green + (1 - 2 * green) * amount, blue + (1 - 2 * blue) * amount];
  }
  if (filter.name === 'brightness') return [red * filter.value, green * filter.value, blue * filter.value];
  if (filter.name === 'contrast') return [(red - 0.5) * filter.value + 0.5, (green - 0.5) * filter.value + 0.5, (blue - 0.5) * filter.value + 0.5];
  if (filter.name === 'saturate') {
    const gray = red * 0.2126 + green * 0.7152 + blue * 0.0722;
    return [gray + (red - gray) * filter.value, gray + (green - gray) * filter.value, gray + (blue - gray) * filter.value];
  }
  if (filter.name === 'hue-rotate') {
    const angle = filter.value * Math.PI / 180;
    const cosine = Math.cos(angle);
    const sine = Math.sin(angle);
    return [
      red * (0.213 + cosine * 0.787 - sine * 0.213) + green * (0.715 - cosine * 0.715 - sine * 0.715) + blue * (0.072 - cosine * 0.072 + sine * 0.928),
      red * (0.213 - cosine * 0.213 + sine * 0.143) + green * (0.715 + cosine * 0.285 + sine * 0.140) + blue * (0.072 - cosine * 0.072 - sine * 0.283),
      red * (0.213 - cosine * 0.213 - sine * 0.787) + green * (0.715 - cosine * 0.715 + sine * 0.715) + blue * (0.072 + cosine * 0.928 + sine * 0.072),
    ];
  }
  return color;
}

/** Applies image filters in software when the browser has no WebGL context. */
export function applyEffectFallback(canvas: HTMLCanvasElement, effects: ClipEffect[], animationBlur: number): void {
  const context = canvas.getContext('2d');
  if (!context || (!effects.length && animationBlur <= 0)) return;
  const { width, height } = canvas;
  const image = context.getImageData(0, 0, width, height);
  const pixels = image.data;
  const original = new Uint8ClampedArray(pixels);
  const filters: PixelFilter[] = [];
  let blur = Math.max(0, animationBlur);
  let vignette = 0;

  for (const effect of effects) {
    const preset = findEffectPreset(effect.presetId);
    if (!preset) continue;
    const amount = Math.max(0, Math.min(100, effect.amount)) / 100;
    if (preset.overlay === 'vignette') vignette = Math.max(vignette, amount);
    for (const filter of preset.filters) {
      const value = filter.min + (filter.max - filter.min) * amount;
      if (filter.name === 'blur') blur = Math.max(blur, value);
      else filters.push({ name: filter.name, value });
    }
  }

  const blurOffset = blur > 0 ? Math.max(1, Math.min(12, Math.round(blur * 0.55))) : 0;
  const sampleOffsets = [[0, 0, 4], [-1, 0, 2], [1, 0, 2], [0, -1, 2], [0, 1, 2], [-1, -1, 1], [1, -1, 1], [-1, 1, 1], [1, 1, 1]] as const;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const pixelIndex = (y * width + x) * 4;
      if (pixels[pixelIndex + 3] === 0) continue;
      let color: RGB;
      if (blurOffset) {
        let red = 0; let green = 0; let blue = 0; let alpha = 0; let totalWeight = 0;
        for (const [offsetX, offsetY, weight] of sampleOffsets) {
          const sampleX = Math.max(0, Math.min(width - 1, x + offsetX * blurOffset));
          const sampleY = Math.max(0, Math.min(height - 1, y + offsetY * blurOffset));
          const sampleIndex = (sampleY * width + sampleX) * 4;
          red += original[sampleIndex] * weight; green += original[sampleIndex + 1] * weight; blue += original[sampleIndex + 2] * weight; alpha += original[sampleIndex + 3] * weight; totalWeight += weight;
        }
        color = [red / (255 * totalWeight), green / (255 * totalWeight), blue / (255 * totalWeight)];
        pixels[pixelIndex + 3] = alpha / totalWeight;
      } else {
        color = [original[pixelIndex] / 255, original[pixelIndex + 1] / 255, original[pixelIndex + 2] / 255];
      }
      for (const filter of filters) color = applyPixelFilter(color, filter);
      if (vignette > 0) {
        const dx = ((x / width) - 0.5) * (width / height);
        const dy = (y / height) - 0.5;
        const edge = Math.hypot(dx, dy);
        const progress = Math.max(0, Math.min(1, (edge - 0.28) / 0.5));
        const shade = progress * progress * (3 - 2 * progress) * vignette * 0.78;
        color = [color[0] * (1 - shade), color[1] * (1 - shade), color[2] * (1 - shade)];
      }
      pixels[pixelIndex] = color[0] * 255;
      pixels[pixelIndex + 1] = color[1] * 255;
      pixels[pixelIndex + 2] = color[2] * 255;
    }
  }
  context.putImageData(image, 0, 0);
}
