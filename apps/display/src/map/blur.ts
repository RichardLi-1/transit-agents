// The glass's blur, drawn by the map itself (glass.ts says why). Each frame the
// map is drawn first on a small target, a texel to every two CSS pixels and
// multisampled so its lines glide rather than step as the map moves; blurred
// across and then down under each pane, reading only inside the pane and
// mirroring at its edges, as Chrome's backdrop-filter does; and then, once the
// map is drawn at full size, laid inside each pane's rounded or squircle corners
// on the page's ground, saturated and brightened as the pane's frost says, in the
// same pass. The full-size map is never read back or drawn over twice, which on a
// tiled GPU is what a blur costs; the small passes cost little.
import { CORNER_BOX_GLSL, deviceRect, gaussian, lowResFactor, lowSigma, MAX_TAPS, type DeviceRect, type GlassRect, type Rgb } from "./glass.ts";
import { compile } from "./shaders.ts";

// A box on the target, in its pixels: left, bottom, right, top.
const BOX_VERTEX = `#version 300 es
uniform vec4 uBox;
uniform vec2 uTarget;
void main() {
  vec2 corner = vec2(float(gl_VertexID & 1), float((gl_VertexID >> 1) & 1));
  gl_Position = vec4(mix(uBox.xy, uBox.zw, corner) / uTarget * 2.0 - 1.0, 0.0, 1.0);
}`;

// One direction of the Gaussian, inside the pane's bounds (in texels), mirrored at them.
const BLUR_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uSource;
uniform vec2 uTexel;
uniform vec2 uStep;
uniform vec4 uBounds;
uniform float uOffsets[${MAX_TAPS}];
uniform float uWeights[${MAX_TAPS}];
uniform int uTaps;
out vec4 color;
vec4 read(vec2 p) {
  p = mix(p, 2.0 * uBounds.xy - p, step(p, uBounds.xy));
  p = mix(p, 2.0 * uBounds.zw - p, step(uBounds.zw, p));
  return texture(uSource, clamp(p, uBounds.xy, uBounds.zw) * uTexel);
}
void main() {
  vec2 p = gl_FragCoord.xy;
  vec4 sum = read(p) * uWeights[0];
  for (int i = 1; i < ${MAX_TAPS}; i++) {
    if (i >= uTaps) break;
    vec2 d = uStep * uOffsets[i];
    sum += (read(p + d) + read(p - d)) * uWeights[i];
  }
  color = sum;
}`;

// The blur inside the pane, round or squircle cornered, its edge smoothed over a
// pixel, on the page's ground, then saturate() and brightness() as CSS applies
// them, in sRGB.
const GLASS_FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uBlur;
uniform vec2 uCanvas;
uniform vec2 uCenter;
uniform vec2 uHalf;
uniform vec4 uRadii;
uniform float uCorner;
uniform vec3 uGround;
uniform float uSaturate;
uniform float uBrightness;
uniform float uOpacity;
out vec4 color;
${CORNER_BOX_GLSL}
void main() {
  float cover = clamp(0.5 - cornerBox(gl_FragCoord.xy - uCenter, uHalf, uRadii, uCorner), 0.0, 1.0) * uOpacity;
  if (cover <= 0.0) discard;
  vec4 map = texture(uBlur, gl_FragCoord.xy / uCanvas);
  vec3 rgb = map.rgb + uGround * (1.0 - map.a);
  float s = uSaturate;
  mat3 saturate = mat3(
    0.213 + 0.787 * s, 0.213 - 0.213 * s, 0.213 - 0.213 * s,
    0.715 - 0.715 * s, 0.715 + 0.285 * s, 0.715 - 0.715 * s,
    0.072 - 0.072 * s, 0.072 - 0.072 * s, 0.072 + 0.928 * s);
  rgb = clamp(clamp(saturate * rgb, 0.0, 1.0) * uBrightness, 0.0, 1.0);
  color = vec4(rgb * cover, cover);
}`;

type Target = { texture: WebGLTexture; framebuffer: WebGLFramebuffer };
type Scene = { framebuffer: WebGLFramebuffer; buffers: WebGLRenderbuffer[] };
type Program = { program: WebGLProgram; at: (name: string) => WebGLUniformLocation | null };

export class GlassBlur {
  private readonly gl: WebGL2RenderingContext;
  private readonly blurring: Program;
  private readonly laying: Program;
  private readonly samples: number;
  // The small map, multisampled, with a stencil for the layers' polygons; then
  // resolved, blurred across, and blurred down.
  private scene: Scene | null = null;
  private targets: [Target, Target, Target] | null = null;
  private lowSize: [number, number] = [0, 0];
  // Whether every target can be drawn on, which some GPUs may refuse.
  private complete = false;
  private canvasSize: [number, number] = [0, 0];
  private readonly kernels = new Map<number, { offsets: Float32Array; weights: Float32Array; taps: number }>();

  constructor(gl: WebGL2RenderingContext) {
    this.gl = gl;
    const program = (vertex: string, fragment: string): Program => {
      const built = compile(gl, vertex, fragment);
      const locations = new Map<string, WebGLUniformLocation | null>();
      return {
        program: built,
        at: (name) => {
          if (!locations.has(name)) locations.set(name, gl.getUniformLocation(built, name));
          return locations.get(name) ?? null;
        },
      };
    };
    this.blurring = program(BOX_VERTEX, BLUR_FRAGMENT);
    this.laying = program(BOX_VERTEX, GLASS_FRAGMENT);
    this.samples = Math.min(4, Number(gl.getParameter(gl.MAX_SAMPLES)) || 0);
  }

  private resize(width: number, height: number) {
    const { gl } = this;
    if (this.scene) {
      gl.deleteFramebuffer(this.scene.framebuffer);
      for (const buffer of this.scene.buffers) gl.deleteRenderbuffer(buffer);
    }
    for (const target of this.targets ?? []) {
      gl.deleteTexture(target.texture);
      gl.deleteFramebuffer(target.framebuffer);
    }
    const framebuffer = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
    const buffers = (
      [
        [gl.RGBA8, gl.COLOR_ATTACHMENT0],
        [gl.DEPTH24_STENCIL8, gl.DEPTH_STENCIL_ATTACHMENT],
      ] as const
    ).map(([format, attachment]) => {
      const buffer = gl.createRenderbuffer();
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
      gl.renderbufferStorageMultisample(gl.RENDERBUFFER, this.samples, format, width, height);
      gl.framebufferRenderbuffer(gl.FRAMEBUFFER, attachment, gl.RENDERBUFFER, buffer);
      return buffer;
    });
    this.scene = { framebuffer, buffers };
    let complete = gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
    const target = (): Target => {
      const texture = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      const framebuffer = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, framebuffer);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      complete &&= gl.checkFramebufferStatus(gl.FRAMEBUFFER) === gl.FRAMEBUFFER_COMPLETE;
      return { texture, framebuffer };
    };
    this.targets = [target(), target(), target()];
    this.lowSize = [width, height];
    this.complete = complete;
  }

  private kernel(sigma: number) {
    const key = Math.round(sigma * 100) / 100;
    let kernel = this.kernels.get(key);
    if (!kernel) {
      const { offsets, weights } = gaussian(key);
      const pad = (values: number[]) => {
        const out = new Float32Array(MAX_TAPS);
        out.set(values.slice(0, MAX_TAPS));
        return out;
      };
      kernel = { offsets: pad(offsets), weights: pad(weights), taps: Math.min(offsets.length, MAX_TAPS) };
      this.kernels.set(key, kernel);
    }
    return kernel;
  }

  // Binds the small map for the scene to be drawn on, for a canvas width × height
  // device pixels, `ratio` of them to a CSS pixel. Returns its size, and how many
  // of the canvas's pixels across one of its texels spans; or null where the GPU
  // can't draw on it, when the page's CSS blurs instead.
  begin(width: number, height: number, ratio: number): [number, number, number] | null {
    const factor = lowResFactor(ratio);
    const low: [number, number] = [Math.max(1, Math.round(width / factor)), Math.max(1, Math.round(height / factor))];
    if (low[0] !== this.lowSize[0] || low[1] !== this.lowSize[1]) this.resize(...low);
    if (!this.complete) return null;
    this.canvasSize = [width, height];
    const { gl } = this;
    gl.bindFramebuffer(gl.FRAMEBUFFER, (this.scene as Scene).framebuffer);
    gl.viewport(0, 0, low[0], low[1]);
    return [low[0], low[1], width / low[0]];
  }

  // Blurs the small map under each pane, once the scene is drawn on it.
  blur(rects: GlassRect[], ratio: number) {
    const { gl } = this;
    const [lowWidth, lowHeight] = this.lowSize;
    const [width, height] = this.canvasSize;
    const [resolved, across, blurred] = this.targets as [Target, Target, Target];
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, (this.scene as Scene).framebuffer);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, resolved.framebuffer);
    gl.blitFramebuffer(0, 0, lowWidth, lowHeight, 0, 0, lowWidth, lowHeight, gl.COLOR_BUFFER_BIT, gl.NEAREST);

    const [sx, sy] = [lowWidth / width, lowHeight / height];
    const { blurring } = this;
    gl.disable(gl.BLEND);
    gl.activeTexture(gl.TEXTURE0);
    gl.useProgram(blurring.program);
    gl.uniform1i(blurring.at("uSource"), 0);
    gl.uniform2f(blurring.at("uTexel"), 1 / lowWidth, 1 / lowHeight);
    gl.uniform2f(blurring.at("uTarget"), lowWidth, lowHeight);
    const panes = this.panes(rects, ratio);
    for (const [source, into, step] of [
      [resolved, across, [1, 0]],
      [across, blurred, [0, 1]],
    ] as const) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, into.framebuffer);
      gl.bindTexture(gl.TEXTURE_2D, source.texture);
      gl.uniform2f(blurring.at("uStep"), step[0], step[1]);
      for (const { rect, box } of panes) {
        const [left, bottom, right, top] = [box.left * sx, box.bottom * sy, box.right * sx, box.top * sy];
        const kernel = this.kernel(lowSigma(rect.frost.blur, ratio, width / lowWidth));
        gl.uniform4f(blurring.at("uBounds"), left, bottom, right, top);
        gl.uniform4f(blurring.at("uBox"), Math.max(0, Math.floor(left)), Math.max(0, Math.floor(bottom)), Math.min(lowWidth, Math.ceil(right)), Math.min(lowHeight, Math.ceil(top)));
        gl.uniform1fv(blurring.at("uOffsets"), kernel.offsets);
        gl.uniform1fv(blurring.at("uWeights"), kernel.weights);
        gl.uniform1i(blurring.at("uTaps"), kernel.taps);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
      }
    }
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  // Lays the blur inside each pane, over the full-size map just drawn on the canvas.
  composite(rects: GlassRect[], ground: Rgb, ratio: number) {
    const { gl, laying } = this;
    const [width, height] = this.canvasSize;
    gl.useProgram(laying.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, (this.targets as [Target, Target, Target])[2].texture);
    gl.uniform1i(laying.at("uBlur"), 0);
    gl.uniform2f(laying.at("uCanvas"), width, height);
    gl.uniform2f(laying.at("uTarget"), width, height);
    gl.uniform3fv(laying.at("uGround"), ground);
    for (const { rect, box } of this.panes(rects, ratio)) {
      gl.uniform4f(laying.at("uBox"), box.left - 1, box.bottom - 1, box.right + 1, box.top + 1);
      gl.uniform2fv(laying.at("uCenter"), box.center);
      gl.uniform2fv(laying.at("uHalf"), box.half);
      gl.uniform4fv(laying.at("uRadii"), box.radii);
      gl.uniform1f(laying.at("uCorner"), rect.corner);
      gl.uniform1f(laying.at("uSaturate"), rect.frost.saturate);
      gl.uniform1f(laying.at("uBrightness"), rect.frost.brightness);
      gl.uniform1f(laying.at("uOpacity"), rect.opacity);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
  }

  // The panes on the canvas, in its device pixels.
  private panes(rects: GlassRect[], ratio: number): { rect: GlassRect; box: DeviceRect }[] {
    const [width, height] = this.canvasSize;
    return rects
      .map((rect) => ({ rect, box: deviceRect(rect, ratio, height) }))
      .filter(({ box }) => box.right > 0 && box.left < width && box.top > 0 && box.bottom < height);
  }
}
