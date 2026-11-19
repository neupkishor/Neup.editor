import type { TimelineClip } from '../types';
import { findAnimationPreset } from './presets';
import type { AnimationTransform } from './types';

const neutralTransform: AnimationTransform = { x: 0, y: 0, scale: 100, opacity: 100, rotation: 0, blur: 0, reveal: 100 };

/** Calculates an animation preset's current visual transform for a timeline clip. */
export function getClipAnimationTransform(clip: TimelineClip, currentTime: number): AnimationTransform {
  const effect = clip.animation;
  const preset = effect ? findAnimationPreset(effect.presetId) : undefined;
  if (!effect || !preset) return neutralTransform;

  const duration = Math.max(0.05, Math.min(effect.duration, clip.duration));
  const elapsed = currentTime - clip.start;
  const rawProgress = preset.category === 'in' ? elapsed / duration : (elapsed - (clip.duration - duration)) / duration;
  const progress = Math.max(0, Math.min(1, rawProgress));
  const eased = preset.easing === 'ease-out'
    ? 1 - (1 - progress) ** 3
    : preset.easing === 'ease-in'
      ? progress ** 3
      : preset.easing === 'ease-in-out'
        ? progress * progress * (3 - 2 * progress)
        : 1 - Math.exp(-7 * progress) * Math.cos(10 * progress);
  const interpolate = (from: number, to: number) => from + (to - from) * eased;

  return {
    x: interpolate(preset.from.x, preset.to.x),
    y: interpolate(preset.from.y, preset.to.y),
    scale: interpolate(preset.from.scale, preset.to.scale),
    opacity: Math.max(0, Math.min(100, interpolate(preset.from.opacity, preset.to.opacity))),
    rotation: interpolate(preset.from.rotation, preset.to.rotation),
    blur: Math.max(0, interpolate(preset.from.blur, preset.to.blur)),
    reveal: Math.max(0, Math.min(100, interpolate(preset.from.reveal, preset.to.reveal))),
    mask: preset.mask,
  };
}

/** Clips the canvas to a growing organic shape for morph style presets. */
export function applyAnimationMask(context: CanvasRenderingContext2D, width: number, height: number, mask: AnimationTransform['mask'], reveal: number): void {
  if (mask !== 'morph' || reveal >= 100) return;
  if (reveal <= 0) {
    context.beginPath();
    context.rect(0, 0, 0, 0);
    context.clip();
    return;
  }

  const radius = Math.hypot(width, height) * 0.5 * reveal / 100;
  const points = Array.from({ length: 18 }, (_, index) => {
    const angle = (Math.PI * 2 * index) / 18;
    const variation = 0.84 + 0.16 * (0.5 + 0.5 * Math.sin(angle * 3 + 0.8));
    return { x: width / 2 + Math.cos(angle) * radius * variation, y: height / 2 + Math.sin(angle) * radius * variation };
  });
  const midpoint = (left: (typeof points)[number], right: (typeof points)[number]) => ({ x: (left.x + right.x) / 2, y: (left.y + right.y) / 2 });
  context.beginPath();
  context.moveTo(midpoint(points[points.length - 1], points[0]).x, midpoint(points[points.length - 1], points[0]).y);
  points.forEach((point, index) => {
    const nextMidpoint = midpoint(point, points[(index + 1) % points.length]);
    context.quadraticCurveTo(point.x, point.y, nextMidpoint.x, nextMidpoint.y);
  });
  context.closePath();
  context.clip();
}
