// Draws the TTC network on white, tilted toward a horizon that fades out.
// There is no basemap: bus routes trace the street grid well enough, and with
// no tiles the map loads instantly, works offline and calls no third parties.

type Vec3 = [number, number, number];
export type Point = [number, number];

export type Camera = {
  x: number;
  y: number;
  distance: number;
  pitch: number;
  bearing: number;
};

export type NetworkRoute = { id: string; type: number; color: string; service: number[][] };
export type Polyline = { route: number; start: number; count: number };
export type NetworkData = { coordinates: Int16Array; polylines: Polyline[]; routes: NetworkRoute[]; unitMetres: number };

const MAGENTA: Vec3 = [176 / 255, 52 / 255, 136 / 255];
const SLATE: Vec3 = [0.42, 0.45, 0.5];
const GREY: Vec3 = [0.58, 0.6, 0.63];
const FAILING: Vec3 = [0.3, 0.32, 0.36];
const FIELD_OF_VIEW = (32 * Math.PI) / 180;

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

const RIBBON_VERTEX = `${HEADER}
in vec2 aPosition;
in float aAlong;
in vec3 aColor;
uniform float uProgress;
uniform float uFogged;
out vec4 vColor;
out float vAlong;
void main() {
  vAlong = aAlong;
  // The network fades into the distance. The study line doesn't: it is the subject.
  vColor = vec4(aColor, mix(1.0, fade(aPosition), uFogged));
  gl_Position = uViewProjection * vec4(aPosition, 0.0, 1.0);
}`;

const RIBBON_FRAGMENT = `#version 300 es
precision highp float;
in vec4 vColor;
in float vAlong;
uniform float uProgress;
out vec4 color;
void main() {
  if (vAlong > uProgress) discard;
  color = vec4(vColor.rgb * vColor.a, vColor.a);
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
  gl_PointSize = clamp(uScale / gl_Position.w, 3.0, 22.0);
}`;

const VEHICLE_FRAGMENT = `#version 300 es
precision highp float;
in float vKind;
in float vFade;
uniform vec3 uColor;
out vec4 color;
void main() {
  float r = length(gl_PointCoord - 0.5) * 2.0;
  float disc = 1.0 - smoothstep(0.82, 1.0, r);
  // Live vehicles are solid. Scheduled vehicles are rings.
  float ring = disc * smoothstep(0.42, 0.58, r);
  float alpha = (vKind > 0.5 ? disc : ring) * vFade;
  color = vec4(uColor * alpha, alpha);
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

const isRail = (route: NetworkRoute) => /^[1-6]$/.test(route.id);

// A flat strip of triangles along a line, joined with mitres.
function ribbon(points: Point[], width: number, color: Vec3, out: number[], along = true) {
  let total = 0;
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1] as Point;
    const b = points[i] as Point;
    total += Math.hypot(b[0] - a[0], b[1] - a[1]);
    lengths.push(total);
  }
  const side = (i: number): Point => {
    const a = points[Math.max(i - 1, 0)] as Point;
    const b = points[Math.min(i + 1, points.length - 1)] as Point;
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    const length = Math.hypot(dx, dy) || 1;
    return [-dy / length, dx / length];
  };
  const vertex = (i: number, sign: number) => {
    const p = points[i] as Point;
    const n = side(i);
    const t = along ? (lengths[i] as number) / (total || 1) : 0;
    out.push(p[0] + n[0] * sign * width, p[1] + n[1] * sign * width, t, color[0], color[1], color[2]);
  };
  for (let i = 0; i + 1 < points.length; i++) {
    vertex(i, 1);
    vertex(i, -1);
    vertex(i + 1, 1);
    vertex(i + 1, 1);
    vertex(i, -1);
    vertex(i + 1, -1);
  }
}

export class MapEngine {
  private readonly gl: WebGL2RenderingContext;
  private readonly canvas: HTMLCanvasElement;
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

  constructor(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { antialias: true, alpha: true, premultipliedAlpha: true });
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
        ribbon(points, 20, hexToRgb(route.color), rail, false);
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
    this.railCount = rail.length / 6;

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
    const stride = 6 * 4;
    const position = gl.getAttribLocation(this.ribbons, "aPosition");
    const along = gl.getAttribLocation(this.ribbons, "aAlong");
    const color = gl.getAttribLocation(this.ribbons, "aColor");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, stride, 0);
    gl.enableVertexAttribArray(along);
    gl.vertexAttribPointer(along, 1, gl.FLOAT, false, stride, 8);
    gl.enableVertexAttribArray(color);
    gl.vertexAttribPointer(color, 3, gl.FLOAT, false, stride, 12);
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
    routes.forEach((route, i) => {
      const day = route.service[dayType ?? 0] ?? [];
      const peak = Math.max(...(route.service[0] ?? [1]), 1);
      const now = (day[h0] ?? 0) * (1 - blend) + (day[h1] ?? 0) * blend;
      const level = dayType === null ? 0.35 : Math.min(now / peak, 1);
      const rgb = route.type === 0 ? SLATE : GREY;
      pixels.set([rgb[0] * 255, rgb[1] * 255, rgb[2] * 255, (0.08 + 0.62 * Math.sqrt(level)) * 255], i * 4);
    });
    gl.bindTexture(gl.TEXTURE_2D, this.routeTexture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, routes.length, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
    this.requestDraw();
  }

  private studyLines: Point[][] = [];
  private studyFailing = false;

  setStudyLines(lines: Point[][]) {
    this.studyLines = lines;
    this.rebuildStudy();
  }

  // A failing study keeps its shape but loses its colour.
  setStudyFailing(failing: boolean) {
    if (failing === this.studyFailing) return;
    this.studyFailing = failing;
    this.rebuildStudy();
  }

  private rebuildStudy() {
    const color = this.studyFailing ? FAILING : MAGENTA;
    const data: number[] = [];
    for (const line of this.studyLines) ribbon(line, 34, color, data);
    this.studyVao = this.ribbonVao(new Float32Array(data));
    this.studyCount = data.length / 6;
    this.requestDraw();
  }

  drawStudyLine(duration: number) {
    this.animate(duration, (t) => {
      this.studyProgress = t;
    });
  }

  flyTo(target: Camera, duration: number) {
    const from = { ...this.camera };
    const delta = ((target.bearing - from.bearing + Math.PI) % (2 * Math.PI)) - Math.PI;
    this.animate(duration, (t) => {
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

  private animate(duration: number, step: (t: number) => void) {
    if (duration <= 0) {
      step(1);
      this.requestDraw();
      return;
    }
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      step(t);
      this.requestDraw();
      if (t < 1) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
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

  setCamera(camera: Partial<Camera>) {
    Object.assign(this.camera, camera);
    this.requestDraw();
  }

  resize() {
    const ratio = Math.min(window.devicePixelRatio || 1, 2);
    const width = Math.round(this.canvas.clientWidth * ratio);
    const height = Math.round(this.canvas.clientHeight * ratio);
    if (this.canvas.width !== width || this.canvas.height !== height) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.requestDraw();
  }

  requestDraw() {
    if (!this.frame) {
      this.frame = requestAnimationFrame(() => {
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

    const forward: Vec3 = [Math.sin(camera.bearing), Math.cos(camera.bearing), 0];
    const back = camera.distance * Math.sin(camera.pitch);
    const eye: Vec3 = [
      camera.x - forward[0] * back,
      camera.y - forward[1] * back,
      camera.distance * Math.cos(camera.pitch),
    ];
    const view = lookAt(eye, [camera.x, camera.y, 0], [0, 0, 1]);
    const projection = perspective(FIELD_OF_VIEW, canvas.width / canvas.height, 50, camera.distance * 12);
    const viewProjection = multiply(projection, view);
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

    shared(this.ribbons);
    gl.uniform1f(gl.getUniformLocation(this.ribbons, "uProgress"), 2);
    gl.uniform1f(gl.getUniformLocation(this.ribbons, "uFogged"), 1);
    gl.bindVertexArray(this.railVao);
    gl.drawArrays(gl.TRIANGLES, 0, this.railCount);
    if (this.studyVao) {
      gl.uniform1f(gl.getUniformLocation(this.ribbons, "uFogged"), 0);
      gl.uniform1f(gl.getUniformLocation(this.ribbons, "uProgress"), this.studyProgress);
      gl.bindVertexArray(this.studyVao);
      gl.drawArrays(gl.TRIANGLES, 0, this.studyCount);
    }

    if (this.vehicleCount) {
      shared(this.vehicles);
      gl.uniform3fv(gl.getUniformLocation(this.vehicles, "uColor"), MAGENTA);
      gl.uniform1f(gl.getUniformLocation(this.vehicles, "uScale"), 60000 * (canvas.height / 1000));
      gl.bindVertexArray(this.vehicleVao);
      gl.drawArrays(gl.POINTS, 0, this.vehicleCount);
    }
    gl.bindVertexArray(null);
  }
}
