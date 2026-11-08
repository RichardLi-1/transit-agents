// Draws the TTC network on white, tilted toward a horizon that fades out.
// There is no basemap: bus routes trace the street grid well enough, and with
// no tiles the map loads instantly, works offline and calls no third parties.

import { LINE_COLORS, TTC_RED } from "./views.ts";

type Vec3 = [number, number, number];
export type Point = [number, number];

export type Camera = {
  x: number;
  y: number;
  distance: number;
  pitch: number;
  bearing: number;
};

// What the page needs to put things on the map: the camera, and the canvas size in
// CSS pixels.
export type TiltedView = { camera: Camera; width: number; height: number };

export type NetworkRoute = { id: string; type: number; color: string; service: number[][] };
export type Polyline = { route: number; start: number; count: number };
export type NetworkData = { coordinates: Int16Array; polylines: Polyline[]; routes: NetworkRoute[]; unitMetres: number };

// Workers in some browsers have no requestAnimationFrame, so fall back to a timer.
const nextFrame: (callback: (time: number) => void) => number =
  typeof requestAnimationFrame === "function"
    ? (callback) => requestAnimationFrame(callback)
    : (callback) => setTimeout(() => callback(performance.now()), 16) as unknown as number;
const cancelFrame: (id: number) => void = typeof cancelAnimationFrame === "function" ? (id) => cancelAnimationFrame(id) : (id) => clearTimeout(id);

const FAILING: Vec3 = [0.3, 0.32, 0.36];
export const FIELD_OF_VIEW = (32 * Math.PI) / 180;

// While a study is shown, the other rail lines fade this far toward grey, so the
// study leads. Each keeps its own colour, whatever the study's colour is.
const RAIL_MUTE = 0.3;

// A proposed segment is dashed in the line's colour, so it reads as unbuilt: dash
// and gap, in metres.
const DASH_METRES = 260;
const GAP_METRES = 140;
const NO_DASH: Vec3 = [2, 1, 1];

function perspective(fovy: number, aspect: number, near: number, far: number): Float32Array {
  const f = 1 / Math.tan(fovy / 2);
  const out = new Float32Array(16);
  out[0] = f / aspect;
  out[5] = f;
  out[10] = (far + near) / (near - far);
  out[11] = -1;
  out[14] = (2 * far * near) / (near - far);
  return out;
}

const subtract = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const normalize = (a: Vec3): Vec3 => {
  const length = Math.hypot(...a) || 1;
  return [a[0] / length, a[1] / length, a[2] / length];
};

function lookAt(eye: Vec3, center: Vec3, up: Vec3): Float32Array {
  const z = normalize(subtract(eye, center));
  const x = normalize(cross(up, z));
  const y = cross(z, x);
  // prettier-ignore
  return new Float32Array([
    x[0], y[0], z[0], 0,
    x[1], y[1], z[1], 0,
    x[2], y[2], z[2], 0,
    -dot(x, eye), -dot(y, eye), -dot(z, eye), 1,
  ]);
}

function multiply(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      let sum = 0;
      for (let k = 0; k < 4; k++) sum += (a[k * 4 + row] as number) * (b[col * 4 + k] as number);
      out[col * 4 + row] = sum;
    }
  }
  return out;
}

// The eye, and the matrix from the ground to the screen. Anything the page pins to
// the map uses this too, so the two can't drift apart.
export function cameraView(camera: Camera, aspect: number): { eye: Vec3; viewProjection: Float32Array } {
  const forward: Vec3 = [Math.sin(camera.bearing), Math.cos(camera.bearing), 0];
  const back = camera.distance * Math.sin(camera.pitch);
  const eye: Vec3 = [camera.x - forward[0] * back, camera.y - forward[1] * back, camera.distance * Math.cos(camera.pitch)];
  const view = lookAt(eye, [camera.x, camera.y, 0], [0, 0, 1]);
  const projection = perspective(FIELD_OF_VIEW, aspect, 50, camera.distance * 12);
  return { eye, viewProjection: multiply(projection, view) };
}

const HEADER = `#version 300 es
precision highp float;
uniform mat4 uViewProjection;
uniform vec3 uEye;
uniform vec2 uFog;
float fade(vec2 ground) {
  float distanceToEye = length(vec3(ground, 0.0) - uEye);
  return 1.0 - smoothstep(uFog.x, uFog.y, distanceToEye);
}
`;

const NETWORK_VERTEX = `${HEADER}
in vec2 aPosition;
in float aRoute;
uniform float uUnit;
uniform sampler2D uRoutes;
out vec4 vColor;
void main() {
  vec2 ground = aPosition * uUnit;
  vec4 route = texelFetch(uRoutes, ivec2(int(aRoute), 0), 0);
  vColor = vec4(route.rgb, route.a * fade(ground));
  gl_Position = uViewProjection * vec4(ground, 0.0, 1.0);
}`;

const COLOR_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
out vec4 color;
void main() { color = vec4(vColor.rgb * vColor.a, vColor.a); }`;

// Lines are drawn as transit maps draw them: a soft glow in the line's colour, a
// casing to part it from what it crosses, and the line itself on top, with round
// joins and ends. Widths are in screen pixels at the camera's target, so a line
// keeps its weight as the map zooms, and thins with distance toward the horizon.
// aNormal is the unit offset from the centre line: across a strip, or out to a
// round join's rim. uWidth is the layer's half width in metres.
const RIBBON_VERTEX = `${HEADER}
in vec2 aPosition;
in vec2 aNormal;
in float aAlong;
in vec3 aColor;
in vec3 aCasing;
uniform float uWidth;
uniform float uLayer;
uniform float uFogged;
uniform float uMute;
out vec4 vColor;
out float vAlong;
out vec2 vNormal;
void main() {
  vAlong = aAlong;
  vNormal = aNormal;
  vec3 rgb = uLayer > 0.5 && uLayer < 1.5 ? aCasing : aColor;
  // The network fades into the distance. The study line doesn't: it is the subject.
  vColor = vec4(mix(rgb, vec3(0.58, 0.6, 0.63), uMute), mix(1.0, fade(aPosition), uFogged));
  gl_Position = uViewProjection * vec4(aPosition + aNormal * uWidth, 0.0, 1.0);
}`;

// uDash: where along the line the dashes start, their period, and the dash's share
// of it. uFeather: the share of the half width that one pixel takes, for a smooth edge.
const RIBBON_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
in float vAlong;
in vec2 vNormal;
uniform float uProgress;
uniform vec3 uDash;
uniform float uFeather;
uniform float uLayer;
out vec4 color;
void main() {
  if (vAlong > uProgress) discard;
  if (vAlong > uDash.x && fract((vAlong - uDash.x) / uDash.y) > uDash.z) discard;
  float r = min(length(vNormal), 1.0);
  float edge = uLayer < 0.5 ? 0.3 * (1.0 - r) * (1.0 - r) : 1.0 - smoothstep(1.0 - uFeather, 1.0, r);
  float alpha = vColor.a * edge;
  color = vec4(vColor.rgb * alpha, alpha);
}`;

const VEHICLE_VERTEX = `${HEADER}
in vec3 aVehicle;
uniform float uScale;
out float vKind;
out float vFade;
void main() {
  vec2 ground = aVehicle.xy;
  vKind = aVehicle.z;
  vFade = 1.0;
  gl_Position = uViewProjection * vec4(ground, 0.0, 1.0);
  gl_PointSize = clamp(uScale / gl_Position.w, 9.0, 26.0);
}`;

const VEHICLE_FRAGMENT = `#version 300 es
precision highp float;
in float vKind;
in float vFade;
uniform vec3 uColor;
out vec4 color;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float outer = 1.0 - smoothstep(0.88, 1.0, r);
  // A white halo keeps every vehicle visible on top of the line. Live vehicles
  // are solid; scheduled ones are white with a coloured outline.
  float core = 1.0 - smoothstep(0.62, 0.72, r);
  float hole = 1.0 - smoothstep(0.34, 0.44, r);
  float tint = vKind > 0.5 ? core : core - hole;
  vec3 rgb = mix(vec3(1.0), uColor, tint);
  float alpha = outer * vFade;
  color = vec4(rgb * alpha, alpha);
}`;

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, vertex],
    [gl.FRAGMENT_SHADER, fragment],
  ] as const) {
    const shader = gl.createShader(type) as WebGLShader;
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "Shader failed");
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "Link failed");
  return program;
}

const hexToRgb = (hex: string): Vec3 => [
  parseInt(hex.slice(0, 2), 16) / 255,
  parseInt(hex.slice(2, 4), 16) / 255,
  parseInt(hex.slice(4, 6), 16) / 255,
];

export const isRail = (route: NetworkRoute) => /^[1-6]$/.test(route.id);

function cumulative(points: Point[]): number[] {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    lengths.push((lengths[i - 1] as number) + Math.hypot(b[0] - a[0], b[1] - a[1]));
  }
  return lengths;
}

const longest = (lines: Point[][]) => Math.max(0, ...lines.map((line) => cumulative(line).at(-1) ?? 0));

// The casing under a line: white, so the line stands clear of what it crosses, or,
// for a pale line such as Line 1's yellow, a darker shade of it, so it still
// stands out on the white map.
function casingOf(color: Vec3): Vec3 {
  const linear = color.map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  const luminance = 0.2126 * (linear[0] as number) + 0.7152 * (linear[1] as number) + 0.0722 * (linear[2] as number);
  return luminance > 0.25 ? [color[0] * 0.55, color[1] * 0.55, color[2] * 0.55] : [1, 1, 1];
}

const ROUND = 12;
const FLOATS = 11;

// Triangles along a line: a strip for each segment, and a round disc at each bend
// and end, so joins and ends are round. `along` is the share of the draw-in
// animation the line spans, or null for a line that doesn't animate.
function ribbon(points: Point[], color: Vec3, casing: Vec3, out: number[], along: [number, number] | null = [0, 1]) {
  const lengths = cumulative(points);
  const total = lengths.at(-1) ?? 0;
  const at = (i: number) => (along ? along[0] + ((along[1] - along[0]) * (lengths[i] as number)) / (total || 1) : 0);
  const vertex = (p: Point, nx: number, ny: number, t: number) => out.push(p[0], p[1], nx, ny, t, ...color, ...casing);
  const disc = (i: number) => {
    const p = points[i] as Point;
    const t = at(i);
    for (let k = 0; k < ROUND; k++) {
      const a0 = (k / ROUND) * Math.PI * 2;
      const a1 = ((k + 1) / ROUND) * Math.PI * 2;
      vertex(p, 0, 0, t);
      vertex(p, Math.cos(a0), Math.sin(a0), t);
      vertex(p, Math.cos(a1), Math.sin(a1), t);
    }
  };
  let previous: Point | null = null;
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i] as Point;
    const b = points[i + 1] as Point;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy);
    if (!length) continue;
    const n: Point = [-dy / length, dx / length];
    // A disc only where the line turns, or at its start.
    if (!previous || Math.abs(previous[0] * n[1] - previous[1] * n[0]) > 0.02 || previous[0] * n[0] + previous[1] * n[1] < 0) disc(i);
    previous = n;
    const [ta, tb] = [at(i), at(i + 1)];
    vertex(a, n[0], n[1], ta);
    vertex(a, -n[0], -n[1], ta);
    vertex(b, n[0], n[1], tb);
    vertex(b, n[0], n[1], tb);
    vertex(a, -n[0], -n[1], ta);
    vertex(b, -n[0], -n[1], tb);
  }
  if (points.length > 1) disc(points.length - 1);
}

// Each layer's full width in CSS pixels at the camera's target: glow, casing, line.
const RAIL_WIDTHS: Vec3 = [16, 8, 5];
const STUDY_WIDTHS: Vec3 = [30, 14, 9];

export class MapEngine {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement | OffscreenCanvas;
  private readonly network: WebGLProgram;
  private readonly ribbons: WebGLProgram;
  private readonly vehicles: WebGLProgram;

  private networkVao: WebGLVertexArrayObject | null = null;
  private networkIndexCount = 0;
  private routeTexture: WebGLTexture | null = null;
  private routes: NetworkRoute[] = [];
  private unit = 2;

  private railVao: WebGLVertexArrayObject | null = null;
  private railCount = 0;
  private studyVao: WebGLVertexArrayObject | null = null;
  private studyCount = 0;
  private studyProgress = 1;
  private vehicleVao: WebGLVertexArrayObject | null = null;
  private vehicleBuffer: WebGLBuffer | null = null;
  private vehicleCount = 0;

  camera: Camera = { x: 0, y: 0, distance: 16000, pitch: 1.1, bearing: 0 };
  private frame = 0;
  private size: [number, number] = [0, 0];

  // Told when the camera moves or the canvas resizes, so the page can keep things
  // pinned to the map. It is told a frame before the draw, about the time a message
  // from the worker takes to reach the page, or, with `drawn`, as the map is drawn
  // at once. Never while the camera holds still.
  onView: ((view: TiltedView, drawn: boolean) => void) | null = null;
  private reported = "";

  constructor(canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 is not available");
    this.gl = gl;
    this.canvas = canvas;
    this.network = compile(gl, NETWORK_VERTEX, COLOR_FRAGMENT);
    this.ribbons = compile(gl, RIBBON_VERTEX, RIBBON_FRAGMENT);
    this.vehicles = compile(gl, VEHICLE_VERTEX, VEHICLE_FRAGMENT);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  setNetwork(data: NetworkData) {
    const { gl } = this;
    this.routes = data.routes;
    this.unit = data.unitMetres;

    const vertexCount = data.coordinates.length / 2;
    const routeOfVertex = new Uint16Array(vertexCount);
    const indices: number[] = [];
    const rail: number[] = [];
    for (const line of data.polylines) {
      const route = data.routes[line.route] as NetworkRoute;
      routeOfVertex.fill(line.route, line.start, line.start + line.count);
      if (isRail(route)) {
        const points: Point[] = [];
        for (let i = line.start; i < line.start + line.count; i++) {
          points.push([(data.coordinates[i * 2] as number) * this.unit, (data.coordinates[i * 2 + 1] as number) * this.unit]);
        }
        const color = hexToRgb(LINE_COLORS[route.id] ?? route.color);
        ribbon(points, color, casingOf(color), rail, null);
      } else {
        for (let i = line.start; i + 1 < line.start + line.count; i++) indices.push(i, i + 1);
      }
    }

    this.networkVao = gl.createVertexArray();
    gl.bindVertexArray(this.networkVao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data.coordinates, gl.STATIC_DRAW);
    const position = gl.getAttribLocation(this.network, "aPosition");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.SHORT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, routeOfVertex, gl.STATIC_DRAW);
    const route = gl.getAttribLocation(this.network, "aRoute");
    gl.enableVertexAttribArray(route);
    gl.vertexAttribPointer(route, 1, gl.UNSIGNED_SHORT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint32Array(indices), gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.networkIndexCount = indices.length;

    this.railVao = this.ribbonVao(new Float32Array(rail));
    this.railCount = rail.length / FLOATS;

    this.routeTexture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.routeTexture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    this.setClock(1, 12);

    this.vehicleVao = gl.createVertexArray();
    gl.bindVertexArray(this.vehicleVao);
    this.vehicleBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vehicleBuffer);
    const vehicle = gl.getAttribLocation(this.vehicles, "aVehicle");
    gl.enableVertexAttribArray(vehicle);
    gl.vertexAttribPointer(vehicle, 3, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
  }

  private ribbonVao(data: Float32Array): WebGLVertexArrayObject {
    const { gl } = this;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    const stride = FLOATS * 4;
    const attributes: [string, number, number][] = [
      ["aPosition", 2, 0],
      ["aNormal", 2, 2],
      ["aAlong", 1, 4],
      ["aColor", 3, 5],
      ["aCasing", 3, 8],
    ];
    for (const [name, size, offset] of attributes) {
      const location = gl.getAttribLocation(this.ribbons, name);
      gl.enableVertexAttribArray(location);
      gl.vertexAttribPointer(location, size, gl.FLOAT, false, stride, offset * 4);
    }
    gl.bindVertexArray(null);
    return vao;
  }

  // Each route brightens and dims with its real timetable. A day type of null
  // means no timetable covers the moment, so every route is drawn at one level.
  setClock(dayType: number | null, hour: number) {
    const { gl, routes } = this;
    if (!this.routeTexture || !routes.length) return;
    const pixels = new Uint8Array(routes.length * 4);
    const h0 = Math.floor(hour) % 24;
    const h1 = (h0 + 1) % 24;
    const blend = hour - Math.floor(hour);
    // Buses and streetcars are drawn in TTC Red, the TTC's colour for local routes.
    const red = hexToRgb(TTC_RED).map((c) => c * 255);
    routes.forEach((route, i) => {
      const day = route.service[dayType ?? 0] ?? [];
      const peak = Math.max(...(route.service[0] ?? [1]), 1);
      const now = (day[h0] ?? 0) * (1 - blend) + (day[h1] ?? 0) * blend;
      const level = dayType === null ? 0.35 : Math.min(now / peak, 1);
      pixels.set([...red, (0.08 + 0.52 * Math.sqrt(level)) * 255], i * 4);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.routeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, routes.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.requestDraw();
  }

  private studyLines: Point[][] = [];
  private proposedLines: Point[][] = [];
  private studyFailing = false;
  private studyDash: Vec3 = NO_DASH;
  private studyColor: Vec3 = hexToRgb("b03488");

  // `color` is the line's colour as hex, such as "0082c9".
  setStudyLines(lines: Point[][], proposed: Point[][] = [], color = "b03488") {
    this.studyLines = lines;
    this.proposedLines = proposed;
    this.studyColor = hexToRgb(color);
    this.rebuildStudy();
  }

  // A failing study keeps its shape but loses its colour.
  setStudyFailing(failing: boolean) {
    if (failing === this.studyFailing) return;
    this.studyFailing = failing;
    this.rebuildStudy();
  }

  private rebuildStudy() {
    const color = this.studyFailing ? FAILING : this.studyColor;
    const data: number[] = [];
    // A proposed extension draws on once the line it extends is drawn, at one speed.
    const built = longest(this.studyLines);
    const total = built + longest(this.proposedLines) || 1;
    const split = this.proposedLines.length ? built / total : 1;
    // A proposed segment's casing is a pale tint of its colour, so the gaps between
    // its dashes read as one unbuilt line.
    const tint: Vec3 = [color[0] * 0.3 + 0.7, color[1] * 0.3 + 0.7, color[2] * 0.3 + 0.7];
    for (const line of this.studyLines) ribbon(line, color, casingOf(color), data, [0, split]);
    for (const line of this.proposedLines) ribbon(line, color, tint, data, [split, 1]);
    const period = DASH_METRES + GAP_METRES;
    this.studyDash = this.proposedLines.length ? [split, period / total, DASH_METRES / period] : NO_DASH;
    this.studyVao = this.ribbonVao(new Float32Array(data));
    this.studyCount = data.length / FLOATS;
    this.requestDraw();
  }

  drawStudyLine(duration: number) {
    this.animate(duration, (t) => {
      this.studyProgress = t;
    });
  }

  // Counts flights, so one ends when another starts or the camera is set, as
  // when the user takes the map.
  private flight = 0;

  flyTo(target: Camera, duration: number) {
    const flight = ++this.flight;
    const from = { ...this.camera };
    // The short way round.
    const delta = Math.atan2(Math.sin(target.bearing - from.bearing), Math.cos(target.bearing - from.bearing));
    this.animate(duration, (t) => {
      if (flight !== this.flight) return false;
      const e = t * t * (3 - 2 * t);
      this.camera = {
        x: from.x + (target.x - from.x) * e,
        y: from.y + (target.y - from.y) * e,
        distance: from.distance + (target.distance - from.distance) * e,
        pitch: from.pitch + (target.pitch - from.pitch) * e,
        bearing: from.bearing + delta * e,
      };
    });
  }

  // A step that returns false ends the animation.
  private animate(duration: number, step: (t: number) => boolean | void) {
    if (duration <= 0) {
      step(1);
      this.requestDraw();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      if (step(t) === false) return;
      this.requestDraw();
      if (t < 1) nextFrame(tick);
    };
    nextFrame(tick);
  }

  // Each vehicle is x, y, kind: 1 for live, 0 for scheduled.
  setVehicles(data: Float32Array) {
    const { gl } = this;
    if (!this.vehicleBuffer) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vehicleBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    this.vehicleCount = data.length / 3;
    this.requestDraw();
  }

  // `now` draws at once, for a caller already in a frame, as the hand's controls
  // are, so the map shows the move in this frame rather than the next.
  setCamera(camera: Partial<Camera>, now = false) {
    this.flight++;
    Object.assign(this.camera, camera);
    if (!now) return this.requestDraw();
    cancelFrame(this.frame);
    this.frame = 0;
    this.report(true);
    this.draw();
  }

  // Sizes come from the page, because a canvas in a worker can't measure itself.
  resize(cssWidth: number, cssHeight: number, devicePixelRatio: number) {
    const ratio = Math.min(devicePixelRatio || 1, 2);
    this.size = [cssWidth, cssHeight];
    const width = Math.round(cssWidth * ratio);
    const height = Math.round(cssHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.requestDraw();
  }

  requestDraw() {
    this.report();
    if (!this.frame) {
      this.frame = nextFrame(() => {
        this.frame = 0;
        this.draw();
      });
    }
  }

  private draw() {
    const { gl, canvas, camera } = this;
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (!this.networkVao) return;

    const { eye, viewProjection } = cameraView(camera, canvas.width / canvas.height);
    const fog: Point = [camera.distance * 1.05, camera.distance * 2.6];

    const shared = (program: WebGLProgram) => {
      gl.useProgram(program);
      gl.uniformMatrix4fv(gl.getUniformLocation(program, "uViewProjection"), false, viewProjection);
      gl.uniform3fv(gl.getUniformLocation(program, "uEye"), eye);
      gl.uniform2fv(gl.getUniformLocation(program, "uFog"), fog);
    };

    shared(this.network);
    gl.uniform1f(gl.getUniformLocation(this.network, "uUnit"), this.unit);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.routeTexture);
    gl.uniform1i(gl.getUniformLocation(this.network, "uRoutes"), 0);
    gl.bindVertexArray(this.networkVao);
    gl.drawElements(gl.LINES, this.networkIndexCount, gl.UNSIGNED_INT, 0);

    // Metres a CSS pixel spans at the camera's target, and a gentle growth as the
    // map zooms in, as transit maps thicken their lines.
    const metresPerPixel = (2 * camera.distance * Math.tan(FIELD_OF_VIEW / 2)) / (this.size[1] || canvas.height);
    const zoom = Math.min(Math.max((16000 / camera.distance) ** 0.35, 0.9), 1.8);
    const layers = (vao: WebGLVertexArrayObject | null, count: number, widths: Vec3, dash: Vec3) => {
      gl.bindVertexArray(vao);
      widths.forEach((px, layer) => {
        gl.uniform1f(gl.getUniformLocation(this.ribbons, "uLayer"), layer);
        gl.uniform1f(gl.getUniformLocation(this.ribbons, "uWidth"), (px / 2) * zoom * metresPerPixel);
        gl.uniform1f(gl.getUniformLocation(this.ribbons, "uFeather"), Math.min(2 / (px * zoom), 1));
        gl.uniform3fv(gl.getUniformLocation(this.ribbons, "uDash"), layer === 2 ? dash : NO_DASH);
        // Glow overlaps itself at every join, so take the brighter, not the sum.
        gl.blendEquation(layer === 0 ? gl.MAX : gl.FUNC_ADD);
        gl.drawArrays(gl.TRIANGLES, 0, count);
      });
      gl.blendEquation(gl.FUNC_ADD);
    };

    shared(this.ribbons);
    gl.uniform1f(gl.getUniformLocation(this.ribbons, "uProgress"), 2);
    gl.uniform1f(gl.getUniformLocation(this.ribbons, "uFogged"), 1);
    gl.uniform1f(gl.getUniformLocation(this.ribbons, "uMute"), this.studyCount ? RAIL_MUTE : 0);
    layers(this.railVao, this.railCount, RAIL_WIDTHS, NO_DASH);
    if (this.studyVao) {
      gl.uniform1f(gl.getUniformLocation(this.ribbons, "uFogged"), 0);
      gl.uniform1f(gl.getUniformLocation(this.ribbons, "uMute"), 0);
      gl.uniform1f(gl.getUniformLocation(this.ribbons, "uProgress"), this.studyProgress);
      layers(this.studyVao, this.studyCount, STUDY_WIDTHS, this.studyDash);
    }

    if (this.vehicleCount) {
      shared(this.vehicles);
      gl.uniform3fv(gl.getUniformLocation(this.vehicles, "uColor"), this.studyFailing ? FAILING : this.studyColor);
      gl.uniform1f(gl.getUniformLocation(this.vehicles, "uScale"), 140000 * (canvas.height / 1000));
      gl.bindVertexArray(this.vehicleVao);
      gl.drawArrays(gl.POINTS, 0, this.vehicleCount);
    }
    gl.bindVertexArray(null);
  }

  private report(drawn = false) {
    const { camera, size, onView } = this;
    const key = `${camera.x} ${camera.y} ${camera.distance} ${camera.pitch} ${camera.bearing} ${size[0]} ${size[1]}`;
    if (!onView || !this.networkVao || key === this.reported || !size[0] || !size[1]) return;
    this.reported = key;
    onView({ camera: { ...camera }, width: size[0], height: size[1] }, drawn);
  }
}
