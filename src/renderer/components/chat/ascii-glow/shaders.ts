/**
 * WGSL for the chat start ASCII glow, from the @bin shader on OpenShaders
 * (https://openshaders.com/@bin). Two passes: a glow field drawn into a
 * small scene texture, then an ASCII pass that turns it into glyphs.
 *
 * Changed from the original: the output is one ink colour with a low alpha
 * on a transparent canvas (monochrome, and it sits on any theme), the faint
 * "." haze is left out, and the field renders at a fraction of the canvas
 * size because it is soft and the ASCII pass only samples it per cell.
 */

/** Shared by both passes. 12 floats (48 bytes, WGSL struct alignment). */
const UNIFORMS = `struct Uniforms {
  resolution: vec2f,
  time: f32,
  pixelRatio: f32,
  ink: vec3f,
  opacity: f32,
  sceneSize: vec2f,
}
@group(0) @binding(0) var<uniform> u: Uniforms;
@vertex fn vertexMain(@builtin(vertex_index) index: u32) -> @builtin(position) vec4f {
  let position = vec2f(f32((index << 1u) & 2u), f32(index & 2u));
  return vec4f(position * 2.0 - 1.0, 0.0, 1.0);
}
`

export const UNIFORM_FLOATS = 12

export const FIELD_SHADER = `${UNIFORMS}
const HUE: f32 = 0.584416628;
const HUE_SPREAD: f32 = -0.110372007;
const HUE_TRAVEL: f32 = 2.48884153;
const CHROMA: f32 = 0.12198624;
const LIGHTNESS: f32 = 0.563167751;
const COLOUR_CYCLE: f32 = 0.189758286;
const THETA: f32 = 2.14873004;
const SHEAR: f32 = 0.968558311;
const SHRINK: f32 = 0.954101026;
const LAYERS: f32 = 88.0;
const WARP_FREQ_X: f32 = 0.455201715;
const WARP_FREQ_Y: f32 = 2.5787766;
const WARP_AMP_X: f32 = 0.13994965;
const WARP_AMP_Y: f32 = 0.0234243236;
const ASPECT_X: f32 = 2.2232039;
const ASPECT_Y: f32 = 0.203713089;
const OFFSET_X: f32 = 0.387368023;
const OFFSET_Y: f32 = 0.0490567796;
const TILT: f32 = 2.48612237;
const ZOOM: f32 = 1.10355937;
const CENTRE_X: f32 = 0.17611523;
const CENTRE_Y: f32 = -0.626550734;
const GLOW_SIZE: f32 = 0.00404752837;
const FALLOFF: f32 = 0.378914386;
const VIGNETTE: f32 = 0.149347275;
const FLOW_SPEED: f32 = 0.626517951;
const BREATH_RATE: f32 = 0.615015924;
const BREATH_AMOUNT: f32 = 0.0715399832;
const PHASE: f32 = 74.475441;
const SOFTNESS: f32 = 0.00272942637;
const LIGHT_SWING: f32 = 0.147926658;
const TAU: f32 = 6.28318530718;
fn oklchToLinear(L: f32, C: f32, h: f32) -> vec3f {
  let a = C * cos(h);
  let b = C * sin(h);
  let l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  let m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  let s_ = L - 0.0894841775 * a - 1.2914855480 * b;
  var lms = vec3f(l_, m_, s_);
  lms = lms * lms * lms;
  return mat3x3f(4.0767416621, -1.2684380046, -0.0041960863,
                 -3.3077115913, 2.6097574011, -0.7034186147,
                 0.2309699292, -0.3413193965, 1.7076147010) * lms;
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let R = u.sceneSize;
  let frag = vec2f(position.x, R.y - position.y);
  let pos = (frag - 0.5 * R) / R.y;
  let t = u.time * FLOW_SPEED + PHASE;
  let breath = (-sin(u.time * BREATH_RATE * 1.5) + sin(u.time * BREATH_RATE + 1.0)) * 0.25 + 0.5;
  var p = (pos - vec2f(CENTRE_X, CENTRE_Y)) * (ZOOM - breath * BREATH_AMOUNT);
  let ct = cos(TILT);
  let st = sin(TILT);
  p = mat2x2f(ct, st, -st, ct) * p;
  let fold = mat2x2f(cos(THETA), sin(THETA), -SHEAR, cos(THETA));
  let hue0 = HUE * TAU;
  let hue1 = hue0 + HUE_SPREAD * TAU;
  var color = vec3f(0.0);
  for (var i: f32 = 1.0; i <= LAYERS; i += 1.0) {
    p.x += -sin(p.y * WARP_FREQ_X + t + i * 0.007) * WARP_AMP_X;
    p.y += -sin(p.x * WARP_FREQ_Y - t + i * 0.02) * WARP_AMP_Y;
    p = fold * p * SHRINK;
    let q = p - vec2f(OFFSET_X + breath * 0.1, OFFSET_Y);
    let s = vec2f(q.x * ASPECT_X, q.y * ASPECT_Y);
    let glow = GLOW_SIZE / (dot(s, s) + SOFTNESS) * (0.25 + breath * 0.4);
    let r = length(p);
    let k = sin(i * COLOUR_CYCLE + t * 1.2 + r * HUE_TRAVEL) * 0.5 + 0.5;
    let tint = clamp(oklchToLinear(LIGHTNESS + LIGHT_SWING * k, CHROMA * (0.75 + 0.35 * k), mix(hue0, hue1, k)), vec3f(0.0), vec3f(1.0));
    color += glow * tint * exp2(-r * FALLOFF);
  }
  let x = max(color, vec3f(0.0));
  color = (x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14);
  color = pow(clamp(color, vec3f(0.0), vec3f(1.0)), vec3f(0.85, 0.92, 0.98));
  color *= 1.0 - smoothstep(0.5, 1.6, length(pos)) * VIGNETTE;
  return vec4f(color, 1.0);
}
`

export const ASCII_SHADER = `${UNIFORMS}
@group(0) @binding(1) var sceneSampler: sampler;
@group(0) @binding(2) var tScene: texture_2d<f32>;
@group(0) @binding(3) var glyphSampler: sampler;
@group(0) @binding(4) var tGlyphs: texture_2d<f32>;
const STRENGTH: f32 = 1.24888599;
const SCALE: f32 = 0.964551747;
const GLYPH_COUNT: f32 = 10.0;
const LUMA = vec3f(0.2126, 0.7152, 0.0722);
fn sceneLuma(uv: vec2f) -> f32 {
  let c = clamp(uv, vec2f(0.0), vec2f(1.0));
  return dot(textureSample(tScene, sceneSampler, vec2f(c.x, 1.0 - c.y)).rgb, LUMA);
}
@fragment fn fragmentMain(@builtin(position) position: vec4f) -> @location(0) vec4f {
  let frag = vec2f(position.x, u.resolution.y - position.y);
  let cellPx = vec2f(0.62, 1.0) * floor(SCALE * 9.0 * u.pixelRatio + 0.5);
  let cell = floor(frag / cellPx);
  let centre = (cell + 0.5) * cellPx;
  var ink = sceneLuma(centre / u.resolution) * 2.0;
  ink += sceneLuma((centre + cellPx * vec2f(0.3, 0.3)) / u.resolution);
  ink += sceneLuma((centre + cellPx * vec2f(-0.3, 0.3)) / u.resolution);
  ink += sceneLuma((centre + cellPx * vec2f(0.3, -0.3)) / u.resolution);
  ink += sceneLuma((centre + cellPx * vec2f(-0.3, -0.3)) / u.resolution);
  ink /= 6.0;
  let level = pow(clamp(ink * (0.9 + 0.3 * STRENGTH), 0.0, 1.0), 0.9);
  let glyph = floor(level * (GLYPH_COUNT - 1.0) + 0.5);
  let local = (frag - cell * cellPx) / cellPx;
  let atlas = vec2f((glyph + local.x) / GLYPH_COUNT, 1.0 - local.y);
  let mask = textureSample(tGlyphs, glyphSampler, atlas).r;
  // Glyph 0 is a space and glyph 1 the "." haze: both stay empty.
  let alpha = select(0.0, mask * u.opacity, glyph >= 2.0);
  return vec4f(u.ink * alpha, alpha);
}
`

export const GLYPHS = ' .:;+*oO8@'
