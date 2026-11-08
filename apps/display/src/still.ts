// A still from a video, for its thumbnail. It is drawn to a canvas and kept as a
// data: URL, which the page's policy allows for images, unlike blob: URLs.
export type Still = { src: string; width: number; height: number };

const WAIT_MS = 20_000;
// The short side of the still, in pixels: enough for a sharp thumbnail.
const SIDE = 160;

const stills = new Map<string, Promise<Still | null>>();

// One capture per video, however many thumbnails show it. Null when the browser
// can't play the file.
export function stillOf(url: string): Promise<Still | null> {
  let still = stills.get(url);
  if (!still) {
    still = capture(url);
    stills.set(url, still);
  }
  return still;
}

function capture(url: string): Promise<Still | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    const done = (still: Still | null) => {
      clearTimeout(timer);
      video.removeAttribute("src");
      video.load();
      resolve(still);
    };
    const timer = window.setTimeout(() => done(null), WAIT_MS);
    video.muted = true;
    video.playsInline = true;
    video.preload = "metadata";
    video.onerror = () => done(null);
    // A second in, past any fade from black, or a quarter of the way in a short clip.
    video.onloadedmetadata = () => {
      video.currentTime = Math.min(1, (video.duration || 0) / 4);
    };
    video.onseeked = () => {
      const { videoWidth: width, videoHeight: height } = video;
      const canvas = document.createElement("canvas");
      const scale = Math.min(1, SIDE / Math.min(width, height));
      canvas.width = Math.round(width * scale);
      canvas.height = Math.round(height * scale);
      const context = canvas.getContext("2d");
      if (!context || !canvas.width || !canvas.height) return done(null);
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      done({ src: canvas.toDataURL("image/jpeg", 0.85), width, height });
    };
    video.src = url;
  });
}
