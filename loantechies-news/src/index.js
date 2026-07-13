/**
 * LoanTechies daily loan-news aggregator (Cloudflare cron Worker).
 *
 * scheduled() (cron — see wrangler.toml) fetches the curated feeds below, parses each RSS/Atom
 * document, keeps only loan/mortgage-relevant items from the last ~48h, dedupes them, sorts newest
 * first, and writes the result to KV under the key `latest`. The public site reads that key via its
 * own Worker (GET /api/articles) and renders the /news page + homepage widget.
 *
 * fetch() is a manual test/trigger hook: GET ?run=1 (with the configured token) re-runs the
 * aggregation on demand; any other GET returns the current KV payload so you can eyeball it.
 *
 * Design notes:
 *  - We only ever store {title, url, source, publishedAt, summary} and link OUT — never republish
 *    article bodies (copyright). Summaries are short, plain-text snippets from the feed itself.
 *  - Parsing is regex-based (no DOM in Workers without HTMLRewriter, which is awkward for XML). RSS
 *    is simple enough that this is robust in practice; a feed that fails to parse is skipped, never
 *    fatal — one bad source can't take down the whole run.
 */

// --- Curated sources (EDIT THIS to tune the site's news, then redeploy) ------
// Keep this a CURATED whitelist of reputable mortgage/housing outlets — quality beats volume.
// Each entry is a public RSS/Atom feed. Google News RSS queries (when:1d = last 24h) widen
// coverage; their links are news.google.com redirects that resolve to the publisher in the browser.
const FEEDS = [
  // Direct publisher feeds (canonical links)
  { url: 'https://www.mortgagenewsdaily.com/rss/full', source: 'Mortgage News Daily' },
  { url: 'https://www.housingwire.com/feed/', source: 'HousingWire' },
  { url: 'https://www.nationalmortgagenews.com/feed', source: 'National Mortgage News' },
  { url: 'https://www.consumerfinance.gov/about-us/newsroom/feed/', source: 'CFPB' },
  { url: 'https://www.nerdwallet.com/blog/mortgages/feed/', source: 'NerdWallet' },
  { url: 'https://themortgagereports.com/feed', source: 'The Mortgage Reports' },
  { url: 'https://www.calculatedriskblog.com/feeds/posts/default', source: 'Calculated Risk' },
  // Google News keyword queries (when:1d = last 24h)
  { url: 'https://news.google.com/rss/search?q=%22mortgage%20rates%22%20when:1d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  { url: 'https://news.google.com/rss/search?q=(refinance%20OR%20%22home%20loan%22%20OR%20%22FHA%20loan%22%20OR%20%22VA%20loan%22)%20when:1d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  { url: 'https://news.google.com/rss/search?q=(%22first-time%20homebuyer%22%20OR%20%22down%20payment%22%20OR%20CalHFA)%20when:1d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
  // California-focused query to boost CA coverage.
  { url: 'https://news.google.com/rss/search?q=California%20(mortgage%20OR%20housing%20OR%20%22home%20loan%22%20OR%20refinance%20OR%20%22home%20prices%22)%20when:1d&hl=en-US&gl=US&ceid=US:en', source: 'Google News' },
];

// An item must contain at least one of these (case-insensitive, in title or summary) to be kept —
// the loan/mortgage relevance gate that filters off-topic items out of broad feeds.
const KEYWORDS = [
  'mortgage', 'refinanc', 'refi', 'home loan', 'homebuyer', 'home buyer', 'home buying',
  'fha', 'va loan', 'usda', 'conforming', 'jumbo', 'down payment', 'closing cost',
  'interest rate', 'mortgage rate', 'rate cut', 'fed rate', 'freddie mac', 'fannie mae',
  'heloc', 'home equity', 'foreclosure', 'housing market', 'home price', 'calhfa',
  'pre-approval', 'preapproval', 'escrow', 'underwriting', 'loan limit', 'arm loan',
];

// --- Geo gate: keep NATIONAL + CALIFORNIA stories, drop other-state-local ones ---------------
// California signals → always keep.
const GEO_CA = /\b(california|calif\.?|calhfa|los angeles|san francisco|san diego|sacramento|san jose|bay area|silicon valley|oakland|fresno|central valley|orange county|riverside|long beach|anaheim|san bernardino|santa clara|napa|sonoma|inland empire|socal|norcal)\b/;
// US-national framing → rescues a story that mentions a FOREIGN place but is really about US policy.
// Deliberately narrow: real US institutions only. Generic "national"/"nationwide" are excluded —
// they show up in local "vs the national average" copy (and "Nationwide" is a UK lender).
const GEO_NATIONAL = /\b(federal reserve|the fed|fed\b|freddie mac|fannie mae|hud\b|cfpb|fhfa|u\.s\.|united states|u\.s\. treasury|mortgage bankers association|conforming loan limit|white house|congress)\b/;
// Other US states (by name) → a local story about one of these (without national framing) is dropped.
// "Washington" is intentionally omitted — in mortgage news it almost always means D.C./federal.
const GEO_OTHER_STATE = /\b(alabama|alaska|arizona|arkansas|colorado|connecticut|delaware|florida|georgia|hawaii|idaho|illinois|indiana|iowa|kansas|kentucky|louisiana|maine|maryland|massachusetts|michigan|minnesota|mississippi|missouri|montana|nebraska|nevada|new hampshire|new jersey|new mexico|new york|north carolina|north dakota|ohio|oklahoma|oregon|pennsylvania|rhode island|south carolina|south dakota|tennessee|texas|utah|vermont|virginia|west virginia|wisconsin|wyoming)\b/;
// Foreign / non-US signals → drop (this is a US + California news page). National US framing overrides.
const GEO_FOREIGN = /\b(u\.?k\.?|britain|british|england|english|brexit|bank of england|scotland|wales|ireland|irish|europe|european|eurozone|ecb|pound sterling|sterling|£|€|canada|canadian|australia|australian|new zealand|china|chinese|india|indian|japan|japanese|germany|german|france|french|spain|spanish|italy|mexico|mexican|dubai|singapore|hong kong)\b/;

const MAX_ITEMS = 18;            // cap stored items (we summarize each, so keep it modest)
const MAX_AGE_MS = 48 * 3600e3;  // drop anything older than ~48h so the page always feels fresh
const SUMMARY_LEN = 220;         // truncate snippets to keep payload small + cards tidy
const KV_KEY = 'latest';

// --- AI summary settings -----------------------------------------------------
// Each kept article gets a short ORIGINAL "Loan Techies take" written by an LLM (a link-out is shown
// alongside — we never republish the source text). Runs on CLOUDFLARE WORKERS AI (free open models),
// so there's no API key and no separate billing — just an `AI` binding on the Worker. Without that
// binding the run still works and items carry no aiSummary (the site falls back to the excerpt).
//
// MODEL: a free Cloudflare Workers AI text model. Cloudflare retires models periodically, so if a run
// starts failing with an AiError "model was deprecated", pick a current one from the Workers AI
// catalog and update this line. Test any candidate live (no redeploy) via
// `…/?debug=1&model=@cf/<id>`. Llama 4 Scout is an efficient MoE that fits the free daily allowance;
// '@cf/meta/llama-3.3-70b-instruct-fp8-fast' is sharper but uses more quota.
const MODEL = '@cf/meta/llama-4-scout-17b-16e-instruct';
const SUMMARY_CONCURRENCY = 4;   // parallel inferences (well under the Worker subrequest cap)
const SUMMARY_TTL = 4 * 24 * 3600; // cache each article's summary in KV this long (cuts repeat work)

// --- tiny XML/HTML helpers ---------------------------------------------------

// Decode the handful of XML/HTML entities that actually show up in feed titles/summaries.
function decodeEntities(s) {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'")
    .replace(/&#8217;|&rsquo;/g, '’').replace(/&#8216;|&lsquo;/g, '‘')
    .replace(/&#8220;|&ldquo;/g, '“').replace(/&#8221;|&rdquo;/g, '”')
    .replace(/&#8211;|&ndash;/g, '–').replace(/&#8212;|&mdash;/g, '—')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&'); // must run last so "&amp;lt;" style double-encodes resolve correctly
}

// Strip tags + collapse whitespace, then truncate to a clean snippet on a word boundary.
function toSnippet(html) {
  const text = decodeEntities(String(html || '').replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();
  if (text.length <= SUMMARY_LEN) return text;
  const cut = text.slice(0, SUMMARY_LEN);
  return cut.slice(0, cut.lastIndexOf(' ') > 0 ? cut.lastIndexOf(' ') : SUMMARY_LEN).trim() + '…';
}

// Pull the inner text of the first <tag>…</tag> (namespace-agnostic, CDATA-safe).
function tag(block, name) {
  const m = block.match(new RegExp('<' + name + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + name + '>', 'i'));
  return m ? decodeEntities(m[1]).trim() : '';
}

// Resolve the item link across RSS (<link>text</link>) and Atom (<link href="…"/>), preferring the
// alternate/text link over self/enclosure variants.
function linkOf(block) {
  const rss = tag(block, 'link');
  if (rss && /^https?:/i.test(rss)) return rss;
  // Atom: prefer rel="alternate" (or no rel); fall back to the first href.
  const links = [...block.matchAll(/<link\b[^>]*href="([^"]+)"[^>]*>/gi)].map(m => ({ href: m[1], rel: (m[0].match(/rel="([^"]+)"/) || [])[1] || 'alternate' }));
  const alt = links.find(l => l.rel === 'alternate') || links[0];
  return alt ? decodeEntities(alt.href) : '';
}

// --- feed parsing ------------------------------------------------------------

function parseFeed(xml, source) {
  const out = [];
  // RSS uses <item>, Atom uses <entry>.
  const blocks = xml.match(/<(item|entry)\b[\s\S]*?<\/\1>/gi) || [];
  for (const block of blocks) {
    let title = tag(block, 'title');
    let url = linkOf(block);
    if (!title || !url) continue;
    const dateRaw = tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated') || tag(block, 'dc:date');
    const ts = dateRaw ? Date.parse(dateRaw) : NaN;
    const summary = toSnippet(tag(block, 'description') || tag(block, 'summary') || tag(block, 'content'));
    // Google News titles are "Headline - Publisher"; keep the headline, surface the real publisher.
    let src = source;
    if (source === 'Google News') {
      const dash = title.lastIndexOf(' - ');
      if (dash > 0 && dash > title.length - 60) { src = title.slice(dash + 3).trim(); title = title.slice(0, dash).trim(); }
    }
    out.push({ title, url, source: src, publishedAt: isNaN(ts) ? null : new Date(ts).toISOString(), _ts: isNaN(ts) ? 0 : ts, summary });
  }
  return out;
}

function isRelevant(item) {
  const hay = (item.title + ' ' + item.summary).toLowerCase();
  return KEYWORDS.some(k => hay.includes(k));
}

// Keep US-national + California; drop only when the HEADLINE is about another state or a foreign
// place. State/country names are fine inside the body (a national roundup may list several states) —
// we judge by the title, which is what frames the story.
function isAllowedGeo(item) {
  const title = (item.title || '').toLowerCase();
  const all = (item.title + ' ' + item.summary).toLowerCase();
  if (GEO_CA.test(all)) return true;             // California anywhere → keep
  if (GEO_OTHER_STATE.test(title)) return false; // another state IN THE HEADLINE → drop
  if (GEO_NATIONAL.test(title)) return true;     // US institution in the headline → keep (overrides foreign)
  if (GEO_FOREIGN.test(title)) return false;     // foreign place IN THE HEADLINE → drop
  return true;                                   // national / unspecified → keep
}

// Dedup key: normalized title + link host. Catches the same story syndicated across feeds (and the
// Google-News-vs-publisher duplicate) without nuking distinct articles from the same site.
function dedupKey(item) {
  let host = '';
  try { host = new URL(item.url).hostname.replace(/^www\./, ''); } catch (e) { /* keep host '' */ }
  const title = item.title.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  return host + '|' + title;
}

// --- aggregation -------------------------------------------------------------

async function fetchFeed(feed) {
  try {
    const res = await fetch(feed.url, {
      headers: { 'user-agent': 'LoanTechiesNewsBot/1.0 (+https://www.loantechies.com)', accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml' },
      cf: { cacheTtl: 300, cacheEverything: true },
    });
    if (!res.ok) return [];
    return parseFeed(await res.text(), feed.source);
  } catch (e) {
    return []; // one bad feed never fails the run
  }
}

// --- AI summaries ------------------------------------------------------------

// Small deterministic hash → short hex, used as the KV cache key for a URL's summary.
function hashUrl(url) {
  let h = 2166136261 >>> 0; // FNV-1a
  for (let i = 0; i < url.length; i++) { h ^= url.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
  return 'sum:' + h.toString(16);
}

// Run an async fn over items with bounded concurrency (so we don't fire 18 Claude calls at once).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  });
  await Promise.all(workers);
  return out;
}

const SUMMARY_SYSTEM =
  "You are the voice of Loan Techies, a California mortgage brokerage run by Anand V. (NMLS #2471270). " +
  "Write a short, ORIGINAL summary of one mortgage/housing news item for everyday borrowers. " +
  "Use exactly two labeled sections:\n" +
  "What happened: 2-3 sentences neutrally summarizing the story.\n" +
  "What it means for you: 2-3 sentences of practical, non-pushy takeaway for a borrower.\n" +
  "Base it ONLY on the headline and excerpt provided. Do NOT invent specific rates, figures, dates, " +
  "or quotes that aren't given; if detail is thin, stay general and suggest reading the full article. " +
  "Around 200-300 words. Plain text only — no markdown, no preamble, output only the summary.";

// Generate (or read from cache) the AI summary for one article via the Cloudflare Workers AI binding.
// Returns a string, or null on any failure (the item just shows its excerpt instead — never blocks
// the run).
async function summarizeOne(env, item) {
  const cacheKey = hashUrl(item.url);
  try {
    const cached = await env.NEWS.get(cacheKey);
    if (cached) return cached;
  } catch (e) { /* cache miss path below */ }

  try {
    const result = await env.AI.run(MODEL, {
      max_tokens: 512,
      messages: [
        { role: 'system', content: SUMMARY_SYSTEM },
        { role: 'user', content: `Headline: ${item.title}\nSource: ${item.source}\nExcerpt: ${item.summary || '(none provided)'}` },
      ],
    });
    const text = ((result && result.response) || '').trim();
    if (!text) return null;
    try { await env.NEWS.put(cacheKey, text, { expirationTtl: SUMMARY_TTL }); } catch (e) { /* non-fatal */ }
    return text;
  } catch (e) {
    return null; // model unavailable / quota — degrade to excerpt
  }
}

async function aggregate(env) {
  const now = Date.now();
  const lists = await Promise.all(FEEDS.map(fetchFeed));
  const seen = new Set();
  const items = [];
  for (const item of lists.flat()) {
    if (!isRelevant(item)) continue;
    if (!isAllowedGeo(item)) continue; // national + California only
    if (item._ts && now - item._ts > MAX_AGE_MS) continue; // undated items are kept (no _ts)
    const key = dedupKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(item);
  }
  // Newest first; undated (_ts 0) sink to the bottom.
  items.sort((a, b) => b._ts - a._ts);
  const trimmed = items.slice(0, MAX_ITEMS).map(({ _ts, ...rest }) => rest);

  // Attach an original AI summary to each item (cached per-URL). Skipped entirely if the Workers AI
  // binding isn't configured, so the Worker still produces a useful list before `AI` is bound.
  if (env.AI) {
    await mapLimit(trimmed, SUMMARY_CONCURRENCY, async (item) => { item.aiSummary = await summarizeOne(env, item); });
  }

  const payload = { generatedAt: new Date(now).toISOString(), count: trimmed.length, items: trimmed };
  // 3-day TTL is a safety net: if the cron ever stops, stale data self-expires rather than lingering.
  await env.NEWS.put(KV_KEY, JSON.stringify(payload), { expirationTtl: 3 * 24 * 3600 });
  return payload;
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(aggregate(env).catch(() => {}));
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const json = (body, status = 200) => new Response(JSON.stringify(body, null, 2), {
      status, headers: { 'content-type': 'application/json; charset=utf-8' },
    });
    try {
      // Diagnostic: confirms which code is deployed, whether the Workers AI binding is present, and
      // whether a tiny live inference works.
      if (url.searchParams.get('debug') === '1') {
        // ?model=@cf/<id> tests a specific model live (no redeploy) — handy when a model is retired.
        const probeModel = url.searchParams.get('model') || MODEL;
        const out = { codeVersion: 'ai-summaries-v6-cf-geo', model: MODEL, probeModel, maxItems: MAX_ITEMS, hasAI: !!env.AI };
        if (env.AI) {
          try {
            const r = await env.AI.run(probeModel, { max_tokens: 16, messages: [{ role: 'user', content: 'Reply with: OK' }] });
            out.aiOk = true;
            out.aiSample = ((r && r.response) || '').slice(0, 40);
          } catch (e) { out.aiOk = false; out.aiError = String(e); }
        }
        return json(out);
      }
      // Manual re-run, token-gated so it can't be triggered by random traffic.
      if (url.searchParams.get('run') === '1') {
        if (env.TRIGGER_TOKEN && url.searchParams.get('token') !== env.TRIGGER_TOKEN) return json({ error: 'unauthorized' }, 401);
        return json(await aggregate(env));
      }
      // Otherwise just show what's currently stored (handy for verifying after deploy).
      const current = await env.NEWS.get(KV_KEY, 'json');
      return json(current || { generatedAt: null, count: 0, items: [], note: 'no data yet — run the cron or GET ?run=1&token=…' });
    } catch (e) {
      return json({ error: String(e) }, 500);
    }
  },
};
