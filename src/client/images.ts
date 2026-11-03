/** Turn dropped / pasted / picked images into self-contained data URLs, so they sync to peers and save (and encrypt) with the doc. */

export interface ImageData {
  src: string;
  alt: string;
  w: number;
  h: number;
}

/** Stored bytes cap: bigger photos are re-encoded down to this. */
const MAX_BYTES = 1_200_000;
const MAX_EDGE = 1600;

function load(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image failed to load"));
    img.src = src;
  });
}

function readAsDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Display size: natural size, at most `maxW` wide. */
function fit(w: number, h: number, maxW: number): { w: number; h: number } {
  const scale = Math.min(1, maxW / Math.max(1, w));
  return { w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) };
}

export async function imageFromBlob(blob: Blob, alt: string, maxW: number): Promise<ImageData> {
  let src = await readAsDataUrl(blob);
  let img = await load(src);
  const nw = img.naturalWidth || 1;
  const nh = img.naturalHeight || 1;
  if (blob.size > MAX_BYTES || Math.max(nw, nh) > MAX_EDGE) {
    const scale = Math.min(1, MAX_EDGE / Math.max(nw, nh));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(nw * scale));
    canvas.height = Math.max(1, Math.round(nh * scale));
    canvas.getContext("2d")!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const png = blob.type === "image/png" || blob.type === "image/gif";
    src = canvas.toDataURL(png ? "image/png" : "image/jpeg", 0.85);
    if (src.length * 0.75 > MAX_BYTES) src = canvas.toDataURL("image/jpeg", 0.75);
    img = await load(src);
  }
  return { src, alt, ...fit(nw, nh, maxW) };
}

/** An image from another page: inline it when CORS allows, else keep the URL. */
export async function imageFromUrl(url: string, alt: string, maxW: number): Promise<ImageData> {
  if (url.startsWith("data:image/")) {
    const blob = await (await fetch(url)).blob();
    return imageFromBlob(blob, alt, maxW);
  }
  try {
    const res = await fetch(url, { mode: "cors" });
    const blob = await res.blob();
    if (res.ok && blob.type.startsWith("image/")) return await imageFromBlob(blob, alt, maxW);
  } catch {
    // Cross-origin without CORS: fall through to linking the URL.
  }
  const img = await load(url);
  return { src: url, alt, ...fit(img.naturalWidth, img.naturalHeight, maxW) };
}

function altFromName(name: string): string {
  return name.replace(/\.[a-z0-9]+$/i, "") || "Image";
}

/** The images a drop or paste carries, in order; empty when it is not an image transfer. */
export function imageSources(dt: DataTransfer): { files: File[]; urls: { url: string; alt: string }[] } {
  const files = [...(dt.files || [])].filter((f) => f.type.startsWith("image/"));
  if (!files.length) {
    for (const item of [...(dt.items || [])]) {
      if (item.kind === "file" && item.type.startsWith("image/")) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
  }
  const urls: { url: string; alt: string }[] = [];
  if (!files.length) {
    const html = dt.getData("text/html");
    if (html && /<img\b/i.test(html)) {
      const doc = new DOMParser().parseFromString(html, "text/html");
      const text = (doc.body.textContent || "").trim();
      // Only treat it as an image transfer when the HTML is just image(s), like dragging a picture off a page.
      if (!text) for (const img of doc.querySelectorAll("img")) if (img.getAttribute("src")) urls.push({ url: img.getAttribute("src")!, alt: img.alt || "Image" });
    }
    if (!urls.length) {
      const list = dt.getData("text/uri-list").split(/\r?\n/).filter((l) => l && !l.startsWith("#"));
      for (const url of list) if (/^data:image\/|\.(png|jpe?g|gif|webp|svg|avif|bmp)(\?|#|$)/i.test(url)) urls.push({ url, alt: "Image" });
    }
  }
  return { files, urls };
}

export async function loadImages(dt: { files: File[]; urls: { url: string; alt: string }[] }, maxW: number): Promise<ImageData[]> {
  const out: ImageData[] = [];
  for (const f of dt.files) out.push(await imageFromBlob(f, altFromName(f.name), maxW));
  for (const u of dt.urls) {
    try {
      out.push(await imageFromUrl(u.url, u.alt, maxW));
    } catch {
      // Unloadable image: skip it.
    }
  }
  return out;
}
