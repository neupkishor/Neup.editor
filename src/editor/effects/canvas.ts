import type { ClipEffect } from '../types';
import { findEffectPreset } from './presets';
import type { CanvasFilterName } from './types';

const MAX_FILTER_OPERATIONS = 32;
const filterOperationIds: Record<CanvasFilterName, number> = {
  grayscale: 0,
  sepia: 1,
  invert: 2,
  brightness: 3,
  contrast: 4,
  saturate: 5,
  'hue-rotate': 6,
  blur: 7,
};

const vertexSource = `
attribute vec2 a_position;
varying vec2 v_texCoord;
void main() {
  v_texCoord = a_position * 0.5 + 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}`;

const fragmentSource = `
precision mediump float;
varying vec2 v_texCoord;
uniform sampler2D u_source;
uniform vec2 u_resolution;
uniform float u_blur;
uniform float u_vignette;
uniform int u_operationCount;
uniform int u_operationTypes[${MAX_FILTER_OPERATIONS}];
uniform float u_operationValues[${MAX_FILTER_OPERATIONS}];

vec3 hueRotate(vec3 color, float degrees) {
  float angle = radians(degrees);
  float c = cos(angle);
  float s = sin(angle);
  return clamp(vec3(
    color.r * (0.213 + c * 0.787 - s * 0.213) + color.g * (0.715 - c * 0.715 - s * 0.715) + color.b * (0.072 - c * 0.072 + s * 0.928),
    color.r * (0.213 - c * 0.213 + s * 0.143) + color.g * (0.715 + c * 0.285 + s * 0.140) + color.b * (0.072 - c * 0.072 - s * 0.283),
    color.r * (0.213 - c * 0.213 - s * 0.787) + color.g * (0.715 - c * 0.715 + s * 0.715) + color.b * (0.072 + c * 0.928 + s * 0.072)
  ), 0.0, 1.0);
}

void main() {
  vec2 texel = vec2(1.0 / u_resolution.x, 1.0 / u_resolution.y) * u_blur;
  vec4 source = texture2D(u_source, v_texCoord) * 0.28;
  source += texture2D(u_source, v_texCoord + vec2(texel.x, 0.0)) * 0.11;
  source += texture2D(u_source, v_texCoord - vec2(texel.x, 0.0)) * 0.11;
  source += texture2D(u_source, v_texCoord + vec2(0.0, texel.y)) * 0.11;
  source += texture2D(u_source, v_texCoord - vec2(0.0, texel.y)) * 0.11;
  source += texture2D(u_source, v_texCoord + texel) * 0.07;
  source += texture2D(u_source, v_texCoord - texel) * 0.07;
  source += texture2D(u_source, v_texCoord + vec2(texel.x, -texel.y)) * 0.07;
  source += texture2D(u_source, v_texCoord + vec2(-texel.x, texel.y)) * 0.07;
  vec3 color = source.rgb;

  for (int index = 0; index < ${MAX_FILTER_OPERATIONS}; index++) {
    if (index >= u_operationCount) break;
    int operation = u_operationTypes[index];
    float value = u_operationValues[index];
    if (operation == 0) {
      float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(color, vec3(gray), clamp(value, 0.0, 1.0));
    } else if (operation == 1) {
      vec3 sepia = vec3(
        dot(color, vec3(0.393, 0.769, 0.189)),
        dot(color, vec3(0.349, 0.686, 0.168)),
        dot(color, vec3(0.272, 0.534, 0.131))
      );
      color = mix(color, sepia, clamp(value, 0.0, 1.0));
    } else if (operation == 2) {
      color = mix(color, 1.0 - color, clamp(value, 0.0, 1.0));
    } else if (operation == 3) {
      color *= value;
    } else if (operation == 4) {
      color = (color - 0.5) * value + 0.5;
    } else if (operation == 5) {
      float gray = dot(color, vec3(0.2126, 0.7152, 0.0722));
      color = mix(vec3(gray), color, value);
    } else if (operation == 6) {
      color = hueRotate(color, value);
    }
  }

  float edge = length((v_texCoord - 0.5) * vec2(u_resolution.x / u_resolution.y, 1.0));
  float shade = smoothstep(0.28, 0.78, edge) * u_vignette * 0.78;
  gl_FragColor = vec4(clamp(color * (1.0 - shade), 0.0, 1.0), source.a);
}`;

type EffectOperation = { type: number; value: number };

type EffectRenderer = {
  render: (source: HTMLCanvasElement, effects: ClipEffect[], animationBlur: number) => HTMLCanvasElement;
};

/** Compiles one WebGL shader and reports an error if the browser rejects it. */
function compileShader(gl: WebGLRenderingContext, type: number, source: string): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Converts effect presets into ordered shader operations and overlay strength. */
function getEffectOperations(effects: ClipEffect[]): { operations: EffectOperation[]; blur: number; vignette: number } {
  const operations: EffectOperation[] = [];
  let blur = 0;
  let vignette = 0;
  for (const effect of effects) {
    const preset = findEffectPreset(effect.presetId);
    if (!preset) continue;
    const amount = Math.max(0, Math.min(100, effect.amount)) / 100;
    if (preset.overlay === 'vignette') vignette = Math.max(vignette, amount);
    for (const filter of preset.filters) {
      const value = filter.min + (filter.max - filter.min) * amount;
      if (filter.name === 'blur') blur = Math.max(blur, value);
      else if (operations.length < MAX_FILTER_OPERATIONS) operations.push({ type: filterOperationIds[filter.name], value });
    }
  }
  return { operations, blur, vignette };
}

/** Creates a reusable GPU effect renderer for the editor canvas and video export. */
export function createEffectRenderer(): EffectRenderer | null {
  const output = document.createElement('canvas');
  const gl = output.getContext('webgl', { alpha: true, premultipliedAlpha: false, preserveDrawingBuffer: true });
  if (!gl) return null;
  const vertexShader = compileShader(gl, gl.VERTEX_SHADER, vertexSource);
  const fragmentShader = compileShader(gl, gl.FRAGMENT_SHADER, fragmentSource);
  if (!vertexShader || !fragmentShader) return null;
  const program = gl.createProgram();
  if (!program) return null;
  gl.attachShader(program, vertexShader);
  gl.attachShader(program, fragmentShader);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) return null;

  const texture = gl.createTexture();
  const buffer = gl.createBuffer();
  if (!texture || !buffer) return null;
  const resolutionLocation = gl.getUniformLocation(program, 'u_resolution');
  const blurLocation = gl.getUniformLocation(program, 'u_blur');
  const vignetteLocation = gl.getUniformLocation(program, 'u_vignette');
  const operationCountLocation = gl.getUniformLocation(program, 'u_operationCount');
  const operationTypesLocation = gl.getUniformLocation(program, 'u_operationTypes[0]');
  const operationValuesLocation = gl.getUniformLocation(program, 'u_operationValues[0]');
  gl.useProgram(program);
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, 'a_position');
  gl.enableVertexAttribArray(position);
  gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
  gl.uniform1i(gl.getUniformLocation(program, 'u_source'), 0);

  /** Applies the selected effects to a transparent clip frame using WebGL. */
  const render = (source: HTMLCanvasElement, effects: ClipEffect[], animationBlur: number): HTMLCanvasElement => {
    if (output.width !== source.width) output.width = source.width;
    if (output.height !== source.height) output.height = source.height;
    gl.viewport(0, 0, output.width, output.height);
    gl.useProgram(program);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    const result = getEffectOperations(effects);
    const operations = result.operations.slice(0, MAX_FILTER_OPERATIONS);
    const types = new Int32Array(MAX_FILTER_OPERATIONS);
    const values = new Float32Array(MAX_FILTER_OPERATIONS);
    operations.forEach((operation, index) => { types[index] = operation.type; values[index] = operation.value; });
    gl.uniform2f(resolutionLocation, source.width, source.height);
    gl.uniform1f(blurLocation, Math.max(result.blur, animationBlur));
    gl.uniform1f(vignetteLocation, result.vignette);
    gl.uniform1i(operationCountLocation, operations.length);
    gl.uniform1iv(operationTypesLocation, types);
    gl.uniform1fv(operationValuesLocation, values);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    return output;
  };

  return { render };
}
