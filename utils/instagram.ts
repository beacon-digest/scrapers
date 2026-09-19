import type { Browser, Page } from "puppeteer";

/**
 * Fetches the public data of a single Instagram post (caption + carousel
 * images) using headless Chrome. No login is required: Instagram still renders
 * the post's Open Graph tags and the carousel <img> elements behind its
 * "Log in / Sign up" overlay.
 *
 * Plain HTTP requests (curl/fetch) get a 600KB JavaScript shell with no post
 * data, so a real browser is the only reliable route. The /embed/captioned/
 * endpoint is smaller but some accounts disable embedding ("The link to this
 * photo or video may be broken"), so the main /p/ page is used.
 */

const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";

export interface InstagramImage {
  /** Full-resolution CDN URL (signed, expires after a while). For a captured
   * Reel frame there is no real URL (the video is a browser-only `blob:`
   * source), so this is just a descriptive label. */
  url: string;
  /** Instagram's auto-generated alt text, often containing OCR'd poster text. */
  alt: string;
  /** Already-available image bytes (e.g. a captured Reel frame). When set,
   * callers should use this directly instead of downloading `url`. */
  base64?: { data: string; mediaType: "image/png" };
}

export interface InstagramPost {
  /** Canonical URL without query params, e.g. https://www.instagram.com/p/XYZ/ */
  url: string;
  /** The post shortcode, e.g. "DcvrRvhkQ_1". */
  shortcode: string;
  /** Account handle, e.g. "happyvalleybeacon". */
  author: string;
  /** Display name of the account, e.g. "Happy Valley Beacon" (if found). */
  authorName?: string;
  /** Date the post was published, as written by Instagram ("September 1, 2026"). */
  postedOn?: string;
  /** Full caption text. */
  caption: string;
  /** Carousel images in order (a single-image post has one entry). */
  images: InstagramImage[];
}

const SHORTCODE_RE = /instagram\.com\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/i;

/** Extracts the shortcode from any Instagram post/reel URL, or throws. */
export function parseInstagramUrl(input: string): { shortcode: string; url: string } {
  const m = SHORTCODE_RE.exec(input.trim());
  if (!m) {
    throw new Error(
      `Not a recognizable Instagram post URL: ${input}. Expected https://www.instagram.com/p/<shortcode>/`,
    );
  }
  const shortcode = m[1];
  return { shortcode, url: `https://www.instagram.com/p/${shortcode}/` };
}

// og:description looks like:
//   111 likes, 3 comments - happyvalleybeacon on September 1, 2026: "CAPTION".
// The caption may contain newlines and quotes, so we anchor on the surrounding
// structure rather than the quote characters alone.
const OG_DESC_RE =
  /^(?:.*?\s-\s)?([A-Za-z0-9._]+) on ([A-Z][a-z]+ \d{1,2}, \d{4}): "([\s\S]*)"\.?\s*$/;

interface RawPageData {
  ogDescription?: string;
  ogTitle?: string;
  bodyText: string;
  images: { src: string; alt: string; width: number }[];
}

// Runs inside the browser. Kept as a string because tsx/esbuild injects a
// `__name` helper into transpiled functions, which is undefined in the page.
const COLLECT_SCRIPT = `(() => {
  const meta = (p) => document.querySelector('meta[property="' + p + '"]')?.content;
  const images = [...document.querySelectorAll("img")].map((i) => ({
    src: i.currentSrc || i.src,
    alt: i.alt || "",
    width: i.naturalWidth,
  }));
  return {
    ogDescription: meta("og:description"),
    ogTitle: meta("og:title"),
    bodyText: document.body.innerText,
    images,
  };
})()`;

// CDN thumbnail size markers used by profile pictures and the "More posts from"
// grid. Carousel slides are served without a size suffix.
const THUMBNAIL_MARKERS = ["s150x150", "s100x100", "s640x640", "p240x240", "s320x320"];

function isThumbnail(src: string): boolean {
  return THUMBNAIL_MARKERS.some((m) => src.includes(m));
}

/** Strips the size/format params so the same image at two sizes dedupes. */
function imageKey(src: string): string {
  try {
    return new URL(src).pathname;
  } catch {
    return src;
  }
}

/**
 * Advances the carousel until the "Next" button disappears, collecting the
 * <img> elements rendered at each step. Instagram only mounts the visible
 * slide and its neighbours, so a 5-slide post needs the clicks.
 */
async function collectCarouselImages(
  page: Page,
  verbose: boolean,
): Promise<{ src: string; alt: string; width: number }[]> {
  const seen = new Map<string, { src: string; alt: string; width: number }>();
  for (let step = 0; step < 20; step++) {
    const before = seen.size;
    const data = (await page.evaluate(COLLECT_SCRIPT)) as RawPageData;
    for (const img of data.images) {
      if (!img.src || isThumbnail(img.src)) continue;
      if (/profile picture/i.test(img.alt)) continue;
      if (img.width > 0 && img.width < 300) continue;
      const key = imageKey(img.src);
      if (!seen.has(key)) seen.set(key, img);
    }
    // A "Next" button can linger on the page after the last slide, so also
    // stop once a click stops revealing anything new.
    if (step > 0 && seen.size === before) break;
    const next = await page.$('button[aria-label="Next"]');
    if (!next) break;
    if (verbose) console.log(`[instagram] carousel: advancing to slide ${step + 2}`);
    await next.click().catch(() => {});
    await new Promise((r) => setTimeout(r, 700));
  }
  return [...seen.values()];
}

// Finds Instagram's logged-out "Sign up for Instagram" card by its "Sign up"
// button text, then walks up to the first ancestor that's roughly card-sized
// AND actually overlaps the video (ruling out an unrelated "Sign up" link in
// the page header, which sits in a similarly-sized container but elsewhere
// on the page). On Reels this card often covers the bottom ~40% of the
// video — exactly where flyer-style posts tend to put the date/time — so it
// needs to be hidden before screenshotting, not just cropped around.
const HIDE_SIGNUP_OVERLAY_SCRIPT = `(() => {
  const video = document.querySelector("video");
  if (!video) return false;
  const vRect = video.getBoundingClientRect();
  const candidates = [...document.querySelectorAll("body *")].filter(
    (el) => el.children.length === 0 && /^sign up$/i.test((el.textContent || "").trim()),
  );
  for (const start of candidates) {
    let node = start;
    for (let i = 0; i < 15 && node.parentElement; i++) {
      node = node.parentElement;
      const r = node.getBoundingClientRect();
      const overlaps = r.top < vRect.bottom && r.bottom > vRect.top && r.left < vRect.right && r.right > vRect.left;
      if (r.height >= 100 && r.height <= 600 && r.width > 250 && overlaps) {
        node.style.setProperty("display", "none", "important");
        return true;
      }
    }
  }
  return false;
})()`;

interface ReelFrame {
  data: string;
  alt: string;
}

const REEL_FRAME_COUNT = 8;

/**
 * Captures evenly-spaced screenshots of a Reel's <video> element. Instagram
 * serves Reel video from a browser-only `blob:` source (MediaSource
 * Extensions), so there's no plain URL to download — the only way to read a
 * frame is the way a human would see it: seek the actual <video> element in
 * the page and screenshot it. Requires the browser to have been launched
 * with an autoplay policy that lets the video actually load/decode
 * (`--autoplay-policy=no-user-gesture-required`).
 */
async function captureReelFrames(page: Page, verbose: boolean): Promise<ReelFrame[]> {
  const hid = await page.evaluate(HIDE_SIGNUP_OVERLAY_SCRIPT);
  if (verbose) console.log(`[instagram] reel: sign-up overlay ${hid ? "hidden" : "not found"}`);

  const videoHandle = await page.$("video");
  if (!videoHandle) return [];

  const duration = (await page.evaluate(`document.querySelector("video")?.duration`)) as
    | number
    | undefined;
  if (!duration || !Number.isFinite(duration) || duration <= 0) {
    if (verbose) console.warn("[instagram] reel: video has no readable duration; skipping frame capture.");
    return [];
  }
  await page.evaluate(`document.querySelector("video")?.pause()`);

  const frames: ReelFrame[] = [];
  for (let i = 0; i < REEL_FRAME_COUNT; i++) {
    const t = (duration * (i + 0.5)) / REEL_FRAME_COUNT;
    const seeked = await page.evaluate(`new Promise((resolve) => {
      const el = document.querySelector("video");
      if (!el) return resolve(false);
      const onSeeked = () => { el.removeEventListener("seeked", onSeeked); resolve(true); };
      el.addEventListener("seeked", onSeeked);
      el.currentTime = ${t};
    })`);
    if (!seeked) break; // the video element disappeared mid-capture
    await new Promise((r) => setTimeout(r, 250));
    try {
      // Puppeteer types this as Uint8Array, and calling .toString("base64")
      // straight on that silently produces garbage (a comma-joined decimal
      // list, not base64) — Buffer.from() is required to get a real Buffer.
      const buf = Buffer.from((await videoHandle.screenshot({ encoding: "binary" })) as Uint8Array);
      frames.push({ data: buf.toString("base64"), alt: `Reel frame at ${t.toFixed(1)}s of ${duration.toFixed(1)}s` });
    } catch (err) {
      if (verbose) {
        console.warn(`[instagram] reel: failed to capture frame at ${t.toFixed(1)}s: ${(err as Error).message}`);
      }
      break;
    }
  }
  if (verbose) {
    console.log(`[instagram] reel: captured ${frames.length}/${REEL_FRAME_COUNT} frame(s) over ${duration.toFixed(1)}s`);
  }
  return frames;
}

export interface FetchInstagramOptions {
  browser: Browser;
  verbose?: boolean;
}

/**
 * Loads an Instagram post in headless Chrome and returns its caption and
 * carousel images. Throws if the post could not be read (private account,
 * deleted post, rate limiting / login wall with no OG data).
 */
export async function fetchInstagramPost(
  input: string,
  { browser, verbose = false }: FetchInstagramOptions,
): Promise<InstagramPost> {
  const { shortcode, url } = parseInstagramUrl(input);
  const page = await browser.newPage();
  try {
    await page.setUserAgent(USER_AGENT);
    await page.setViewport({ width: 1280, height: 1400 });
    if (verbose) console.log(`[instagram] loading ${url}`);
    // Chrome can wedge on a connection Instagram refuses (ERR_SOCKET_NOT_CONNECTED),
    // so cap the navigation ourselves and let the caller decide on a fallback.
    const response = await withTimeout(
      page.goto(url, { waitUntil: "networkidle2", timeout: 60000 }),
      75000,
      `Timed out loading ${url}`,
    );
    if (response && response.status() >= 400) {
      throw new Error(`Instagram returned HTTP ${response.status()} for ${url}`);
    }
    // Give the client-side app a moment to hydrate the OG tags and carousel.
    await new Promise((r) => setTimeout(r, 2000));

    const first = (await page.evaluate(COLLECT_SCRIPT)) as RawPageData;
    if (!first.ogDescription) {
      const hint = /may be broken|isn't available|not available/i.test(first.bodyText)
        ? "Instagram says the post is unavailable (deleted or private)."
        : "No Open Graph data rendered — possibly a login wall or rate limit. Try again in a few minutes.";
      throw new Error(`Could not read Instagram post ${shortcode}. ${hint}`);
    }

    const m = OG_DESC_RE.exec(first.ogDescription);
    let author = "";
    let postedOn: string | undefined;
    let caption = first.ogDescription;
    if (m) {
      author = m[1];
      postedOn = m[2];
      caption = m[3];
    } else if (verbose) {
      console.warn(`[instagram] og:description did not match expected shape; using it verbatim.`);
    }

    // og:title is "Author Name on Instagram: ..." on hydrated pages; fall back
    // to the alt-text "Photo by <Name> on <date>" pattern below.
    let authorName = first.ogTitle?.split(" on Instagram")[0]?.trim();

    const rawImages = await collectCarouselImages(page, verbose);

    // Prefer images whose alt text names the post date; that's how Instagram
    // labels the post's own slides ("Photo by X on September 01, 2026"), which
    // separates them from anything else on the page that slipped through.
    const postDateAltRe = postedOn
      ? new RegExp(
          `on ${postedOn.replace(/(\w+) (\d{1,2}), (\d{4})/, (_s, mon, d, y) => `${mon} 0?${d}, ${y}`)}`,
          "i",
        )
      : undefined;
    let slides = postDateAltRe ? rawImages.filter((i) => postDateAltRe.test(i.alt)) : [];
    let reelFrames: ReelFrame[] = [];
    if (slides.length === 0) {
      // No carousel image belongs to this post's own date — on a Reel, the
      // <img> tags found are just other posts in a sidebar, not this post's
      // content. Capture the actual video frames instead of sending those.
      const hasVideo = (await page.evaluate(`!!document.querySelector("video")`)) as boolean;
      if (hasVideo) {
        if (verbose) console.log("[instagram] no dated carousel images found; this looks like a Reel.");
        reelFrames = await captureReelFrames(page, verbose);
      } else {
        slides = rawImages;
      }
    }

    if (!authorName) {
      const byMatch = /^(?:Photo|Video) by (.+?) on [A-Z][a-z]+ \d{2}, \d{4}/.exec(
        slides[0]?.alt ?? "",
      );
      if (byMatch) authorName = byMatch[1];
    }

    const images: InstagramImage[] =
      reelFrames.length > 0
        ? reelFrames.map((f, i) => ({
            url: `reel-frame:${shortcode}:${i}`,
            alt: f.alt,
            base64: { data: f.data, mediaType: "image/png" },
          }))
        : slides.map((i) => ({ url: i.src, alt: i.alt }));

    const post: InstagramPost = {
      url,
      shortcode,
      author,
      authorName: authorName || undefined,
      postedOn,
      caption: caption.trim(),
      images,
    };
    if (verbose) {
      console.log(
        `[instagram] @${post.author} (${post.authorName ?? "?"}) posted ${post.postedOn ?? "?"}: ` +
          `${post.caption.length} chars caption, ${post.images.length} image(s)`,
      );
    }
    return post;
  } finally {
    // Closing a wedged page can hang too; don't let it block the caller.
    await withTimeout(page.close(), 5000, "page.close timed out").catch(() => {});
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Downloads an image and returns it base64-encoded with its media type, ready
 * to send to a vision model. Instagram's CDN serves signed URLs that work
 * without cookies for a limited time.
 */
export async function downloadImageAsBase64(
  url: string,
): Promise<{ data: string; mediaType: "image/jpeg" | "image/png" | "image/webp" | "image/gif" }> {
  let res: Response;
  try {
    // Instagram's CDN occasionally accepts a connection and then stalls
    // without ever sending data; a plain fetch() has no default timeout for
    // that, so it would otherwise hang forever.
    res = await fetch(url, {
      headers: { "User-Agent": USER_AGENT },
      signal: AbortSignal.timeout(20000),
    });
  } catch (err) {
    if ((err as Error).name === "TimeoutError") {
      throw new Error(`Timed out downloading image after 20s: ${url}`);
    }
    throw err;
  }
  if (!res.ok) throw new Error(`Failed to download image (${res.status}): ${url}`);
  const contentType = res.headers.get("content-type") ?? "image/jpeg";
  const mediaType = (["image/jpeg", "image/png", "image/webp", "image/gif"] as const).find((t) =>
    contentType.includes(t),
  );
  if (!mediaType) throw new Error(`Unsupported image type "${contentType}" for ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { data: buf.toString("base64"), mediaType };
}
