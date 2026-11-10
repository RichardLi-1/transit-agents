// The aerial photos, drawn by the map under everything else (tiles.ts says which
// tiles, and where). Tiles load as the camera comes to them, a few at a time,
// coarsest first; each becomes a mip-mapped texture on its own grid, fading toward
// the horizon as the network does. A tile still loading shows the part of its
// nearest loaded ancestor it covers, so the ground is never empty for long. At
// most CACHE tiles stay on the GPU, the least lately drawn going first.
import { compile } from "./shaders.ts";
import { GRID_INDICES, MIN_ZOOM, parent, tileGrid, tileKey, tilesInView, tileUrl, uvWithin, type Tile } from "./tiles.ts";

// About 70 MB of textures, mipmaps included: a full view of tiles, and their ancestors.
const CACHE = 200;
// Fetches at once: as many as a browser makes to one site.
const LOADS = 6;
// A tile that failed to load is asked for again after this long.
const RETRY_MS = 30_000;

const vertex = (header: string) => `${header}
in vec2 aPosition;
in vec2 aUv;
uniform vec4 uUv;
out vec2 vUv;
out float vFade;
void main() {
  vUv = aUv * uUv.xy + uUv.zw;
  vFade = fade(aPosition);
  gl_Position = uViewProjection * vec4(aPosition, 0.0, 1.0);
}`;

const FRAGMENT = `#version 300 es
precision highp float;
uniform sampler2D uPhoto;
uniform float uBrightness;
in vec2 vUv;
in float vFade;
out vec4 color;
void main() {
  vec4 photo = texture(uPhoto, vUv);
  float alpha = photo.a * vFade;
  color = vec4(photo.rgb * uBrightness * alpha, alpha);
}`;

type Entry = {
  tile: Tile;
  vao: WebGLVertexArrayObject;
  buffer: WebGLBuffer;
  texture: WebGLTexture | null;
  state: "waiting" | "loading" | "ready" | "missing";
  retry: number;
  used: number;
};

export class Imagery {
  readonly program: WebGLProgram;
  private readonly gl: WebGL2RenderingContext;
  private readonly onLoad: () => void;
  private readonly indices: WebGLBuffer;
  private readonly entries = new Map<string, Entry>();
  private readonly anisotropy: { name: number; max: number } | null;
  private chosen: Tile[] = [];
  private chosenFor = "";
  private loading = 0;
  private frame = 0;

  // `header` declares the shared uniforms and fade(), as the map's other programs
  // have them. onLoad is told when a tile arrives, to draw again.
  constructor(gl: WebGL2RenderingContext, header: string, onLoad: () => void) {
    this.gl = gl;
    this.onLoad = onLoad;
    this.program = compile(gl, vertex(header), FRAGMENT);
    this.indices = gl.createBuffer();
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, GRID_INDICES, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, null);
    const ext = gl.getExtension("EXT_texture_filter_anisotropic");
    this.anisotropy = ext ? { name: ext.TEXTURE_MAX_ANISOTROPY_EXT, max: Math.min(4, Number(gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT)) || 1) } : null;
  }

  // Picks the tiles for this camera, once a frame, before the passes that draw
  // them, from the canvas's size in device pixels and how far the ground shows.
  choose(viewProjection: Float32Array, eye: [number, number, number], far: number, width: number, height: number) {
    this.frame++;
    const key = `${Array.from(viewProjection).join(",")} ${width} ${height}`;
    if (key === this.chosenFor) return;
    this.chosenFor = key;
    this.chosen = tilesInView(viewProjection, eye, far, width, height);
    for (const tile of this.chosen) if (!this.entries.has(tileKey(tile))) this.add(tile);
    this.pump();
    this.evict();
  }

  // Draws the chosen tiles with the program in use and its shared uniforms set.
  draw(brightness: number) {
    const { gl } = this;
    gl.activeTexture(gl.TEXTURE0);
    gl.uniform1i(gl.getUniformLocation(this.program, "uPhoto"), 0);
    gl.uniform1f(gl.getUniformLocation(this.program, "uBrightness"), brightness);
    const uv = gl.getUniformLocation(this.program, "uUv");
    for (const tile of this.chosen) {
      const own = this.entries.get(tileKey(tile));
      if (!own) continue;
      own.used = this.frame;
      let source = tile;
      let entry: Entry | undefined = own;
      while (entry?.state !== "ready" && source.z > MIN_ZOOM) {
        source = parent(source);
        entry = this.entries.get(tileKey(source));
      }
      if (entry?.state !== "ready" || !entry.texture) continue;
      entry.used = this.frame;
      gl.bindTexture(gl.TEXTURE_2D, entry.texture);
      gl.uniform4fv(uv, uvWithin(tile, source));
      gl.bindVertexArray(own.vao);
      gl.drawElements(gl.TRIANGLES, GRID_INDICES.length, gl.UNSIGNED_SHORT, 0);
    }
    gl.bindVertexArray(null);
  }

  private add(tile: Tile) {
    const { gl } = this;
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, tileGrid(tile), gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 16, 0);
    const uv = gl.getAttribLocation(this.program, "aUv");
    gl.enableVertexAttribArray(uv);
    gl.vertexAttribPointer(uv, 2, gl.FLOAT, false, 16, 8);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.indices);
    gl.bindVertexArray(null);
    this.entries.set(tileKey(tile), { tile, vao, buffer, texture: null, state: "waiting", retry: 0, used: this.frame });
  }

  // Starts loading what's wanted, coarsest first, a few at a time.
  private pump() {
    if (this.loading >= LOADS) return;
    const now = performance.now();
    const wanted = this.chosen
      .map((tile) => this.entries.get(tileKey(tile)))
      .filter((entry): entry is Entry => Boolean(entry && (entry.state === "waiting" || (entry.state === "missing" && entry.retry && entry.retry < now))))
      .sort((a, b) => a.tile.z - b.tile.z);
    for (const entry of wanted.slice(0, LOADS - this.loading)) void this.load(entry);
  }

  private async load(entry: Entry) {
    entry.state = "loading";
    this.loading++;
    try {
      const response = await fetch(tileUrl(entry.tile));
      // None there: the City has no photo of it, so it's never asked for again.
      if (response.status === 404) return void (entry.state = "missing");
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const bitmap = await createImageBitmap(await response.blob(), { premultiplyAlpha: "none" });
      if (this.entries.get(tileKey(entry.tile)) !== entry) return void bitmap.close();
      this.upload(entry, bitmap);
      bitmap.close();
      this.onLoad();
    } catch {
      entry.state = "missing";
      entry.retry = performance.now() + RETRY_MS;
    } finally {
      this.loading--;
      this.pump();
    }
  }

  private upload(entry: Entry, bitmap: ImageBitmap) {
    const { gl } = this;
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, bitmap);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    if (this.anisotropy) gl.texParameterf(gl.TEXTURE_2D, this.anisotropy.name, this.anisotropy.max);
    entry.texture = texture;
    entry.state = "ready";
  }

  // Keeps at most CACHE tiles, dropping the least lately drawn that this frame doesn't need.
  private evict() {
    const needed = new Set(this.chosen.map(tileKey));
    const idle = [...this.entries.entries()].filter(([key, entry]) => !needed.has(key) && entry.state !== "loading");
    // Waiting tiles no longer wanted go at once: they were never fetched.
    for (const [key, entry] of idle) if (entry.state === "waiting") this.drop(key, entry);
    const over = this.entries.size - CACHE;
    if (over <= 0) return;
    const oldest = idle.filter(([, entry]) => entry.state !== "waiting").sort((a, b) => a[1].used - b[1].used);
    for (const [key, entry] of oldest.slice(0, over)) this.drop(key, entry);
  }

  private drop(key: string, entry: Entry) {
    const { gl } = this;
    if (entry.texture) gl.deleteTexture(entry.texture);
    gl.deleteVertexArray(entry.vao);
    gl.deleteBuffer(entry.buffer);
    this.entries.delete(key);
  }
}
