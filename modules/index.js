"use strict";

(() => {
  const BASE_URL = "https://sushiscan.net";
  const HOST = "sushiscan.net";
  const DEFAULT_HEADERS = {
    Accept: "text/html,application/xhtml+xml",
    "Accept-Language": "fr-FR,fr;q=0.9",
    Referer: `${BASE_URL}/`,
  };
  const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
  const MAX_ATTEMPTS = 3;
  const MIN_REQUEST_SPACING = 500;
  let lastRequestAt = 0;

  function sleep(milliseconds) {
    return new Promise((resolve) => {
      if (typeof globalThis.setTimeout === "function") globalThis.setTimeout(resolve, milliseconds);
      else Promise.resolve().then(resolve);
    });
  }

  function decodeEntities(value) {
    const named = { amp: "&", apos: "'", gt: ">", lt: "<", nbsp: " ", quot: '"' };
    return String(value || "")
      .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
      .replace(/&#([0-9]+);/g, (_, decimal) => String.fromCodePoint(parseInt(decimal, 10)))
      .replace(/&([a-z]+);/gi, (match, name) => named[name.toLowerCase()] || match);
  }

  function stripHTML(value) {
    return decodeEntities(
      String(value || "")
        .replace(/<script\b[\s\S]*?<\/script>/gi, " ")
        .replace(/<style\b[\s\S]*?<\/style>/gi, " ")
        .replace(/<br\s*\/?\s*>/gi, "\n")
        .replace(/<[^>]+>/g, " "),
    )
      .replace(/[ \t]+/g, " ")
      .replace(/\s*\n\s*/g, "\n")
      .trim();
  }

  function attribute(tag, name) {
    const match = String(tag || "").match(
      new RegExp(`\\b${name}\\s*=\\s*(["'])([\\s\\S]*?)\\1`, "i"),
    );
    return match ? decodeEntities(match[2].trim()) : "";
  }

  async function responseText(response) {
    if (!response) return "";
    if (typeof response.text === "function") {
      const value = await response.text();
      if (typeof value === "string") return value;
    }
    return typeof response.body === "string" ? response.body : "";
  }

  function looksLikeChallenge(html) {
    return /<title>\s*(?:Just a moment|Attention Required|Un instant)/i.test(html)
      || /cf-browser-verification|challenge-platform/i.test(html) && !/id=["']chapterlist["']|class=["']bsx["']/i.test(html);
  }

  async function fetchDirect(url, options = {}) {
    if (typeof globalThis.fetchv2 !== "function") {
      throw new Error("SushiScan requires the fetchv2 bridge.");
    }
    let lastError = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      if (attempt > 1) await sleep(1000 * (attempt - 1));
      const wait = lastRequestAt + MIN_REQUEST_SPACING - Date.now();
      if (wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      let response = null;
      try {
        response = await globalThis.fetchv2(
          url,
          { ...DEFAULT_HEADERS, ...(options.headers || {}) },
          "GET",
          null,
          { followRedirects: true, maxBytesHint: options.maxBytesHint || null, responseClass: "html" },
        );
      } catch (error) {
        lastError = error instanceof Error ? error : new Error(String(error));
        continue;
      }
      const status = Number(response && response.status);
      if (status === 403) {
        throw new Error("SushiScan blocked the request (HTTP 403, likely a Cloudflare challenge).");
      }
      if (!response || response.ok === false || (status && (status < 200 || status >= 300))) {
        lastError = new Error(`SushiScan request failed with HTTP ${status || "error"}.`);
        if (status && !RETRYABLE_STATUS.has(status)) break;
        continue;
      }
      if (response.bodyDropped) {
        throw new Error(`SushiScan response was dropped: ${response.dropReason || "size policy"}.`);
      }
      const body = await responseText(response);
      if (looksLikeChallenge(body)) {
        throw new Error("SushiScan returned a challenge page instead of content.");
      }
      if (body) return body;
      lastError = new Error("SushiScan returned an empty response.");
    }
    throw lastError || new Error("SushiScan request failed.");
  }

  function absoluteURL(value) {
    const input = String(value || "").trim();
    if (!input) return "";
    if (input.startsWith("https://")) return input;
    if (input.startsWith("http://")) return `https://${input.slice(7)}`;
    if (input.startsWith("//")) return `https:${input}`;
    if (input.startsWith("/")) return `${BASE_URL}${input}`;
    return `${BASE_URL}/${input}`;
  }

  function normalizedSeriesURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/(?:https:\/\/sushiscan\.net)?\/?catalogue\/([a-z0-9][a-z0-9-]*)/i);
    if (match) return `${BASE_URL}/catalogue/${match[1].toLowerCase()}/`;
    if (/^[a-z0-9][a-z0-9-]*$/i.test(input)) return `${BASE_URL}/catalogue/${input.toLowerCase()}/`;
    throw new Error("Invalid SushiScan series identifier.");
  }

  function normalizedChapterURL(value) {
    const input = String(value || "").trim();
    const match = input.match(/^(?:https:\/\/sushiscan\.net)?\/?([a-z0-9][a-z0-9-]*)\/?(?:[?#]|$)/i);
    if (!match || /^(?:catalogue|page|genres?|author|wp-[a-z]+|feed|tag)$/i.test(match[1])) {
      throw new Error("Invalid SushiScan chapter identifier.");
    }
    return `${BASE_URL}/${match[1].toLowerCase()}/`;
  }

  function chapterNumber(title, href) {
    const fromTitle = String(title || "").match(/(?:chapitre|chapter|ch\.?|volume|vol\.?|tome)[\s#:.-]*([0-9]+(?:[.,][0-9]+)?)/i);
    if (fromTitle) return Number(fromTitle[1].replace(",", "."));
    const fromHref = String(href || "").match(/-(?:chapitre|chapter|volume|tome)-([0-9]+(?:-[0-9]+)?)\/?$/i);
    return fromHref ? Number(fromHref[1].replace("-", ".")) : null;
  }

  function imageOf(tag) {
    const candidate = attribute(tag, "data-src") || attribute(tag, "data-lazy-src") || attribute(tag, "src");
    return candidate.startsWith("data:") ? "" : absoluteURL(candidate);
  }

  function parseSearchHTML(html) {
    const items = [];
    const seen = new Set();
    const pattern = /<div class=["']bsx["'][^>]*>\s*<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(html)) !== null) {
      const href = absoluteURL(attribute(match[1], "href"));
      if (!/\/catalogue\/[^/]+\/?$/i.test(href) || seen.has(href)) continue;
      const title = attribute(match[1], "title")
        || stripHTML((match[2].match(/<div class=["']tt["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "");
      if (!title) continue;
      const img = (match[2].match(/<img\b[^>]*>/i) || [""])[0];
      seen.add(href);
      items.push({ id: href, href, title, image: img ? imageOf(img) : "" });
    }
    const hasMore = /<a\b[^>]*class=["'][^"']*\bnext\b[^"']*["']/i.test(html)
      || /<a\b[^>]*class=["'][^"']*\br\b[^"']*["'][^>]*>\s*Suivant/i.test(html);
    return { items, hasMore };
  }

  function parseDetailsHTML(html, href) {
    const title = stripHTML((html.match(/<h1\b[^>]*class=["'][^"']*entry-title[^"']*["'][^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "")
      || stripHTML((html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i) || [])[1] || "");
    if (!title) throw new Error("SushiScan details did not contain a title.");

    const thumb = (html.match(/<div class=["']thumb["'][^>]*>[\s\S]*?(<img\b[^>]*>)/i) || [])[1] || "";
    const image = thumb ? imageOf(thumb) : decodeEntities((html.match(/og:image["']\s+content=["']([^"']+)["']/i) || [])[1] || "");

    const infoValue = (label) => {
      const row = html.match(
        new RegExp(`<td[^>]*>\\s*${label}\\s*<\\/td>\\s*<td[^>]*>([\\s\\S]*?)<\\/td>`, "i"),
      );
      return row ? stripHTML(row[1]) : "";
    };
    const author = infoValue("(?:Auteur|Author)");
    const authors = author ? author.split(/\s*[,/]\s*/).filter(Boolean) : [];
    const rawStatus = infoValue("(?:Statut|Status)");
    const genreBlock = (html.match(/<span class=["']mgen["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "";
    const genres = Array.from(genreBlock.matchAll(/<a\b[^>]*>([\s\S]*?)<\/a>/gi))
      .map((entry) => stripHTML(entry[1]))
      .filter(Boolean);
    const descBlock = (html.match(/<div class=["']entry-content[^"']*["'][^>]*itemprop=["']description["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";

    return {
      id: href,
      href,
      url: href,
      title,
      description: stripHTML(descBlock),
      image,
      authors,
      author: authors.join(", "),
      genres,
      status: rawStatus || "Unknown",
    };
  }

  function chapterListHTML(html) {
    // Only the selected series' own #chapterlist; "latest" or "related"
    // widgets elsewhere on the page also link to other chapters.
    const match = String(html || "").match(/<div\b[^>]*id=["']chapterlist["'][^>]*>([\s\S]*?)<\/ul>/i);
    return match ? match[1] : "";
  }

  function parseChaptersHTML(html, seriesURL) {
    const chapters = [];
    const seen = new Set();
    const chapterMarkup = chapterListHTML(html);
    if (!chapterMarkup) return chapters;
    const seriesPrefix = normalizedSeriesURL(seriesURL).replace(/\/catalogue\/.*$/i, "/").toLowerCase();
    const pattern = /<li\b[^>]*>\s*<div class=["']chbox["'][\s\S]*?<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
    let match;
    while ((match = pattern.exec(chapterMarkup)) !== null) {
      const href = absoluteURL(attribute(match[1], "href"));
      if (!href.toLowerCase().startsWith(seriesPrefix) || seen.has(href)) continue;
      if (/\/catalogue\//i.test(href)) continue;
      const title = stripHTML((match[2].match(/<span class=["']chapternum["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || match[2]);
      if (!title) continue;
      const date = stripHTML((match[2].match(/<span class=["']chapterdate["'][^>]*>([\s\S]*?)<\/span>/i) || [])[1] || "");
      seen.add(href);
      chapters.push({
        id: href,
        href,
        url: href,
        title,
        number: chapterNumber(title, href),
        releaseDate: date || null,
        language: "fr",
      });
    }
    return chapters;
  }

  function imageEntry(url) {
    return {
      url,
      headers: { Accept: "image/avif,image/webp,image/*,*/*", Referer: `${BASE_URL}/` },
    };
  }

  function parseImagesHTML(html) {
    const pages = [];
    const seen = new Set();
    const push = (value) => {
      const url = absoluteURL(String(value || "").replace(/\\\//g, "/"));
      if (!url.startsWith("https://") || seen.has(url)) return;
      if (!/\.(?:jpg|jpeg|png|webp|avif|gif)(?:\?|$)/i.test(url)) return;
      seen.add(url);
      pages.push(imageEntry(url));
    };

    const run = String(html).match(/ts_reader\.run\(\s*(\{[\s\S]*?\})\s*\)\s*;/i);
    if (run) {
      try {
        const data = JSON.parse(run[1]);
        const source = (data.sources || []).find((entry) => Array.isArray(entry.images) && entry.images.length);
        if (source) source.images.forEach(push);
      } catch (_) {
        const arrayMatch = run[1].match(/"images"\s*:\s*(\[[\s\S]*?\])/);
        if (arrayMatch) Array.from(arrayMatch[1].matchAll(/"([^"]+)"/g)).forEach((entry) => push(entry[1]));
      }
    }
    if (!pages.length) {
      const area = (String(html).match(/<div\b[^>]*id=["']readerarea["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1] || "";
      for (const tag of area.match(/<img\b[^>]*>/gi) || []) push(imageOf(tag));
    }
    return pages;
  }

  function listURL(query, page) {
    const currentPage = Math.max(1, Number(page) || 1);
    const params = [];
    if (query === "__feed:popular") params.push("order=popular");
    else if (query === "__feed:latest") params.push("order=update");
    else params.push(`title=${encodeURIComponent(String(query || "").trim().slice(0, 200))}`);
    if (currentPage > 1) params.push(`page=${currentPage}`);
    return `${BASE_URL}/catalogue/?${params.join("&")}`;
  }

  async function searchResults(query, page = 1) {
    return parseSearchHTML(await fetchDirect(listURL(query, page), { maxBytesHint: 2 * 1024 * 1024 }));
  }

  async function extractDetails(id) {
    const href = normalizedSeriesURL(id);
    return parseDetailsHTML(await fetchDirect(href, { maxBytesHint: 3 * 1024 * 1024 }), href);
  }

  async function extractChapters(id) {
    const href = normalizedSeriesURL(id);
    const chapters = parseChaptersHTML(await fetchDirect(href, { maxBytesHint: 8 * 1024 * 1024 }), href);
    if (!chapters.length) throw new Error("SushiScan returned no chapters for this series.");
    return chapters;
  }

  async function extractImages(id) {
    const href = normalizedChapterURL(id);
    const pages = parseImagesHTML(await fetchDirect(href, { maxBytesHint: 4 * 1024 * 1024 }));
    if (!pages.length) throw new Error("SushiScan chapter returned no readable pages.");
    return pages;
  }

  async function discoveryHome() {
    const popular = await searchResults("__feed:popular", 1);
    const latest = await searchResults("__feed:latest", 1);
    return {
      sections: [
        { id: "popular", title: "Populaires", items: popular.items },
        { id: "latest", title: "Dernières mises à jour", items: latest.items },
      ],
    };
  }

  async function discoveryFeed(feedID, page = 1) {
    const feed = String(feedID || "").toLowerCase() === "latest" ? "latest" : "popular";
    return searchResults(`__feed:${feed}`, page);
  }

  const handlers = { searchResults, extractDetails, extractChapters, extractImages, discoveryHome, discoveryFeed };
  globalThis.SynthetiqModule = handlers;
  Object.assign(globalThis, handlers);
})();
