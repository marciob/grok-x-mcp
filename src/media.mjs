// Media of a post (photos, videos, GIFs) in one shape, and the
// download of images for MCP image content.
//
// One media item: { type: 'photo'|'video'|'gif', url, preview, alt, width, height, duration_ms }
//   url      direct original URL (photo: the image at name=orig; video/GIF: the best MP4)
//   preview  image URL (photo: the same image; video/GIF: the poster image), or null
//   alt      the author's alt text, or null when there is none. Never made up.
//   width, height, duration_ms   numbers, or null when the provider does not give them
//
// Provider shapes (read from the raw answers, 2026-11-24):
// - mdfromx: post.media = { all: [...], photos: [...], videos: [...] }; item: type, url, thumbnail_url, width,
//   height, alt | altText, duration_ms | duration (s), variants [{ url, content_type, bitrate }]
//   (mdfromx SDK MediaItem, github.com/pc-style/x-md packages/sdk/src/generated/types.ts).
// - SocialAPI: tweet.extended_entities.media (or entities.media); item: type, media_url_https, ext_alt_text,
//   original_info { width, height }, video_info { duration_millis, variants }.
// - X API v2 (Grokbot): post.attachments.media_keys + includes.media; item: media_key, type, url,
//   preview_image_url, alt_text, width, height, duration_ms, variants.

const TYPES = { photo: 'photo', video: 'video', animated_gif: 'gif', gif: 'gif' };
const n = v => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const s = v => (typeof v === 'string' && v.trim() ? v : null);

// The MP4 with the highest bitrate, else the first variant with a URL.
function bestVideo(variants) {
  const mp4 = (variants || []).filter(v => v?.url && /mp4/i.test(v.content_type || v.url));
  mp4.sort((a, b) => (b.bitrate || 0) - (a.bitrate || 0));
  return mp4[0]?.url || (variants || []).find(v => v?.url)?.url || null;
}

// A pbs.twimg.com photo URL at its original size.
export function originalPhoto(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.hostname !== 'pbs.twimg.com' || !u.pathname.startsWith('/media/')) return url;
    u.searchParams.set('name', 'orig');
    return u.toString();
  } catch { return url; }
}

function item({ type, url, preview, alt, width, height, duration_ms }) {
  const t = TYPES[type] || (type ? String(type) : 'photo');
  const direct = t === 'photo' ? originalPhoto(url || preview) : url || null;
  if (!direct && !preview) return null;
  return { type: t, url: direct, preview: t === 'photo' ? direct : preview || null, alt: s(alt), width: n(width), height: n(height), duration_ms: n(duration_ms) };
}

export function fromMdfromxMedia(p) {
  const m = p?.media;
  if (!m) return [];
  const list = Array.isArray(m.all) && m.all.length ? m.all : [...(m.photos || []), ...(m.videos || []), ...(m.animated || []), ...(m.gifs || [])];
  return list.map(x => item({
    type: x.type, url: x.type === 'photo' ? x.url : bestVideo(x.variants) || x.url, preview: x.thumbnail_url || (x.type === 'photo' ? x.url : null),
    alt: x.alt ?? x.altText, width: x.width, height: x.height,
    duration_ms: x.duration_ms ?? (typeof x.duration === 'number' ? Math.round(x.duration * 1000) : null),
  })).filter(Boolean);
}

export function fromSocialapiMedia(t) {
  const list = t?.extended_entities?.media || t?.entities?.media || [];
  return list.map(x => item({
    type: x.type, url: x.type === 'photo' ? x.media_url_https : bestVideo(x.video_info?.variants), preview: x.media_url_https,
    alt: x.ext_alt_text, width: x.original_info?.width ?? x.sizes?.large?.w, height: x.original_info?.height ?? x.sizes?.large?.h,
    duration_ms: x.video_info?.duration_millis,
  })).filter(Boolean);
}

export function fromV2Media(p, includesMedia = []) {
  const keys = p?.attachments?.media_keys || [];
  return keys.map(k => includesMedia.find(x => x.media_key === k)).filter(Boolean).map(x => item({
    type: x.type, url: x.type === 'photo' ? x.url : bestVideo(x.variants), preview: x.type === 'photo' ? x.url : x.preview_image_url,
    alt: x.alt_text, width: x.width, height: x.height, duration_ms: x.duration_ms,
  })).filter(Boolean);
}

// One text line for each media item, so a client that shows only text still gets the URLs.
export function mediaLines(media, attached = new Map()) {
  return (media || []).map((m, i) => {
    const size = m.width && m.height ? ` ${m.width}x${m.height}` : '';
    const dur = m.duration_ms ? ` ${Math.round(m.duration_ms / 1000)}s` : '';
    const prev = m.type !== 'photo' && m.preview ? ` · preview ${m.preview}` : '';
    const img = attached.has(m) ? ` · attached as image ${attached.get(m)}` : '';
    return `  media ${i + 1}: ${m.type}${size}${dur} ${m.url || m.preview}${prev} · alt: ${m.alt == null ? 'none' : JSON.stringify(m.alt)}${img}`;
  });
}

// ---------- Images as MCP image content ----------
// Only pbs.twimg.com images are fetched (photos and video posters). The download asks for name=medium
// (at most 1200 px wide) to keep the payload small; the text line keeps the original URL.
export const IMAGE_LIMITS = { maxImages: 4, maxBytes: 1_000_000, maxTotalBytes: 3_000_000, timeoutMs: 8000 };
const MIMES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

export function downloadUrl(url) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:' || u.hostname !== 'pbs.twimg.com') return null;
  if (u.pathname.startsWith('/media/')) {
    const m = u.pathname.match(/^\/media\/([^./]+)(?:\.(jpg|jpeg|png|webp|gif))?$/);
    if (!m) return null;
    const format = u.searchParams.get('format') || (m[2] === 'jpeg' ? 'jpg' : m[2]) || 'jpg';
    return `https://pbs.twimg.com/media/${m[1]}?format=${format}&name=medium`;
  }
  // Video posters live under /ext_tw_video_thumb/, /amplify_video_thumb/, /tweet_video_thumb/.
  if (/^\/(ext_tw_video_thumb|amplify_video_thumb|tweet_video_thumb)\//.test(u.pathname)) return u.toString();
  return null;
}

async function fetchOne(url, { maxBytes, timeoutMs }, fetchImpl) {
  const r = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const mime = String(r.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
  if (!MIMES.has(mime)) throw new Error(`not an image (${mime || 'no content-type'})`);
  const len = Number(r.headers.get('content-length'));
  if (len > maxBytes) throw new Error(`too big (${len} bytes)`);
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > maxBytes) throw new Error(`too big (${buf.length} bytes)`);
  return { mime, buf };
}

// posts: [{ media: [...] }]. Returns { images: [{ type:'image', data, mimeType }], attached: Map(item -> n), notes: [] }.
// A failed image gives a note; the text of the post never depends on it.
export async function fetchImages(posts, opts = {}, fetchImpl = globalThis.fetch) {
  const lim = { ...IMAGE_LIMITS, ...opts };
  const wanted = [];
  for (const p of posts) for (const m of p.media || []) {
    if (wanted.length >= lim.maxImages) break;
    const src = m.type === 'photo' ? m.url : m.preview;
    const dl = src && downloadUrl(src);
    if (dl) wanted.push({ m, dl });
  }
  const results = await Promise.allSettled(wanted.map(w => fetchOne(w.dl, lim, fetchImpl)));
  const images = [], attached = new Map(), notes = [];
  let total = 0;
  results.forEach((r, i) => {
    const { m } = wanted[i];
    const label = m.url || m.preview;
    if (r.status === 'rejected') return notes.push(`Image not attached (${label}): ${r.reason?.message || r.reason}. Use the URL.`);
    if (total + r.value.buf.length > lim.maxTotalBytes) return notes.push(`Image not attached (${label}): the images of this answer passed ${lim.maxTotalBytes} bytes. Use the URL.`);
    total += r.value.buf.length;
    images.push({ type: 'image', data: r.value.buf.toString('base64'), mimeType: r.value.mime });
    attached.set(m, images.length);
  });
  return { images, attached, notes };
}
