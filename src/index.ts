interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STORYBOOK_BUCKET: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
  GEMINI_IMAGE_MODEL?: string;
  MAX_PAGES?: string;
  TURNSTILE_SITE_KEY?: string;
  TURNSTILE_SECRET_KEY?: string;
  DAILY_LIMIT_PER_IP?: string;
}

interface ReferenceImage {
  base64: string;
  mimeType: string;
  description: string;
}

interface GenerateStoryRequest {
  prompt?: string;
  transcript?: string;
  audioBase64?: string;
  audioMimeType?: string;
  pageCount?: number;
  turnstileToken?: string;
  referenceImages?: ReferenceImage[];
}

interface StoryPage {
  pageNumber: number;
  text: string;
  imagePrompt: string;
}

interface GeneratedStory {
  title: string;
  transcript: string | null;
  characterSheet: string;
  pages: StoryPage[];
}

interface StoryRow {
  id: string;
  title: string;
  prompt: string;
  transcript: string | null;
  cover_image_key: string | null;
  created_at: string;
  updated_at: string;
  page_count?: number;
}

interface PageRow {
  id: number;
  story_id: string;
  page_number: number;
  text: string;
  image_prompt: string;
  image_key: string | null;
  created_at: string;
}

const jsonHeaders = {
  "content-type": "application/json; charset=utf-8",
};

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, env, ctx, url);
    }

    return env.ASSETS.fetch(request);
  },
};

async function handleApiRequest(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  url: URL,
): Promise<Response> {
  if (request.method === "OPTIONS") {
    return new Response(null, { status: 204 });
  }

  try {
    if (request.method === "GET" && url.pathname === "/api/config") {
      return jsonResponse({
        turnstileSiteKey: env.TURNSTILE_SITE_KEY || null,
      });
    }

    if (request.method === "GET" && url.pathname === "/api/health") {
      return jsonResponse({ ok: true, timestamp: new Date().toISOString() });
    }

    if (request.method === "GET" && url.pathname === "/api/stories") {
      return listStories(env);
    }

    if (request.method === "POST" && url.pathname === "/api/stories/generate") {
      return createStory(request, env);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/stories/")) {
      const storyId = url.pathname.replace("/api/stories/", "").trim();
      if (!storyId) {
        return jsonResponse({ error: "Missing story id." }, 400);
      }
      return getStory(env, storyId);
    }

    if (request.method === "GET" && url.pathname.startsWith("/api/images/")) {
      const key = decodeURIComponent(url.pathname.replace("/api/images/", "")).trim();
      if (!key) {
        return jsonResponse({ error: "Missing image key." }, 400);
      }
      return getImage(env, key);
    }

    return jsonResponse({ error: "Not found." }, 404);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unexpected server error.";
    return jsonResponse({ error: message }, 500);
  }
}

async function listStories(env: Env): Promise<Response> {
  const result = await env.DB.prepare(
    `SELECT
      s.id,
      s.title,
      s.prompt,
      s.transcript,
      s.cover_image_key,
      s.created_at,
      s.updated_at,
      COUNT(p.id) AS page_count
    FROM stories s
    LEFT JOIN pages p ON p.story_id = s.id
    GROUP BY s.id
    ORDER BY s.created_at DESC
    LIMIT 50`,
  ).all<StoryRow>();

  const stories = (result.results ?? []).map((row) => ({
    id: row.id,
    title: row.title,
    prompt: row.prompt,
    transcript: row.transcript,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    pageCount: Number(row.page_count ?? 0),
    coverImageUrl: row.cover_image_key ? `/api/images/${encodeURIComponent(row.cover_image_key)}` : null,
  }));

  return jsonResponse({ stories });
}

async function getStory(env: Env, storyId: string): Promise<Response> {
  const storyResult = await env.DB.prepare(
    `SELECT id, title, prompt, transcript, cover_image_key, created_at, updated_at
    FROM stories
    WHERE id = ?1
    LIMIT 1`,
  )
    .bind(storyId)
    .all<StoryRow>();

  const story = storyResult.results?.[0];

  if (!story) {
    return jsonResponse({ error: "Story not found." }, 404);
  }

  const pagesResult = await env.DB.prepare(
    `SELECT id, story_id, page_number, text, image_prompt, image_key, created_at
    FROM pages
    WHERE story_id = ?1
    ORDER BY page_number ASC`,
  )
    .bind(storyId)
    .all<PageRow>();

  return jsonResponse({
    story: {
      id: story.id,
      title: story.title,
      prompt: story.prompt,
      transcript: story.transcript,
      createdAt: story.created_at,
      updatedAt: story.updated_at,
      coverImageUrl: story.cover_image_key
        ? `/api/images/${encodeURIComponent(story.cover_image_key)}`
        : null,
      pages: (pagesResult.results ?? []).map((page) => ({
        id: page.id,
        pageNumber: page.page_number,
        text: page.text,
        imagePrompt: page.image_prompt,
        imageUrl: page.image_key ? `/api/images/${encodeURIComponent(page.image_key)}` : null,
      })),
    },
  });
}

async function getImage(env: Env, key: string): Promise<Response> {
  const object = await env.STORYBOOK_BUCKET.get(key);

  if (!object) {
    return jsonResponse({ error: "Image not found." }, 404);
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("cache-control", "public, max-age=31536000, immutable");

  return new Response(object.body, {
    status: 200,
    headers,
  });
}

async function createStory(request: Request, env: Env): Promise<Response> {
  const clientIp = request.headers.get("cf-connecting-ip") || "unknown";

  const payload = (await request.json()) as GenerateStoryRequest;

  // Turnstile verification
  if (env.TURNSTILE_SECRET_KEY) {
    const token = payload.turnstileToken ?? "";
    if (!token) {
      return jsonResponse({ error: "Please complete the verification challenge." }, 403);
    }

    const verified = await verifyTurnstile(env.TURNSTILE_SECRET_KEY, token, clientIp);
    if (!verified) {
      return jsonResponse({ error: "Verification failed. Please try again." }, 403);
    }
  }

  // IP-based daily rate limit
  const dailyLimit = Number.parseInt(env.DAILY_LIMIT_PER_IP ?? "5", 10);
  const rateLimitResult = await checkAndIncrementRateLimit(env.DB, clientIp, dailyLimit);
  if (!rateLimitResult.allowed) {
    return jsonResponse({
      error: `You've reached the daily limit of ${dailyLimit} stories. Come back tomorrow!`,
    }, 429);
  }

  const prompt = payload.prompt?.trim() ?? "";
  if (!prompt) {
    return jsonResponse({ error: "Prompt is required." }, 400);
  }

  const maxPages = Number.parseInt(env.MAX_PAGES ?? "8", 10);
  const pageCount = clampNumber(payload.pageCount ?? 8, 4, Number.isFinite(maxPages) ? maxPages : 8);

  const transcriptFromAudio =
    payload.audioBase64 && payload.audioMimeType
      ? await transcribeAudioWithGemini(env, payload.audioBase64, payload.audioMimeType)
      : null;

  const transcript = payload.transcript?.trim() || transcriptFromAudio;

  // Validate and limit reference images (max 10, reasonable size)
  const referenceImages: ReferenceImage[] = Array.isArray(payload.referenceImages)
    ? payload.referenceImages
        .filter(
          (img): img is ReferenceImage =>
            !!img &&
            typeof img.base64 === "string" &&
            img.base64.length > 0 &&
            img.base64.length < 10_000_000 && // ~7.5MB max per image
            typeof img.mimeType === "string" &&
            typeof img.description === "string",
        )
        .slice(0, 10)
    : [];

  const generated = await generateStoryWithGemini(env, {
    prompt,
    transcript,
    pageCount,
    referenceImages,
  });

  const storyId = crypto.randomUUID();
  const now = new Date().toISOString();

  await env.DB.prepare(
    `INSERT INTO stories (id, title, prompt, transcript, cover_image_key, created_at, updated_at)
    VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?6)`,
  )
    .bind(storyId, generated.title, prompt, generated.transcript, now, now)
    .run();

  let coverImageKey: string | null = null;

  for (const page of generated.pages) {
    const imageResult = await generateImageWithGemini(env, {
      prompt: page.imagePrompt,
      storyTitle: generated.title,
      pageNumber: page.pageNumber,
      characterSheet: generated.characterSheet,
      referenceImages,
    });

    let imageKey: string | null = null;

    if (imageResult) {
      imageKey = `stories/${storyId}/page-${String(page.pageNumber).padStart(2, "0")}.${imageResult.extension}`;
      await env.STORYBOOK_BUCKET.put(imageKey, imageResult.bytes, {
        httpMetadata: {
          contentType: imageResult.contentType,
          cacheControl: "public, max-age=31536000, immutable",
        },
      });

      if (!coverImageKey) {
        coverImageKey = imageKey;
      }
    }

    await env.DB.prepare(
      `INSERT INTO pages (story_id, page_number, text, image_prompt, image_key, created_at)
      VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
    )
      .bind(storyId, page.pageNumber, page.text, page.imagePrompt, imageKey, now)
      .run();
  }

  if (coverImageKey) {
    await env.DB.prepare(`UPDATE stories SET cover_image_key = ?1, updated_at = ?2 WHERE id = ?3`)
      .bind(coverImageKey, now, storyId)
      .run();
  }

  return getStory(env, storyId);
}

async function transcribeAudioWithGemini(
  env: Env,
  audioBase64: string,
  audioMimeType: string,
): Promise<string | null> {
  if (!env.GEMINI_API_KEY) {
    return null;
  }

  const model = env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";

  try {
    const response = await callGemini(env, model, {
      contents: [
        {
          role: "user",
          parts: [
            {
              text: "Transcribe this children's story narration into clean plain text. Return only the transcription.",
            },
            {
              inlineData: {
                mimeType: audioMimeType,
                data: audioBase64,
              },
            },
          ],
        },
      ],
    });

    const transcript = extractFirstTextPart(response)?.trim();
    return transcript || null;
  } catch {
    return null;
  }
}

async function generateStoryWithGemini(
  env: Env,
  input: {
    prompt: string;
    transcript: string | null;
    pageCount: number;
    referenceImages: ReferenceImage[];
  },
): Promise<GeneratedStory> {
  if (!env.GEMINI_API_KEY) {
    return generateFallbackStory(input.prompt, input.transcript, input.pageCount);
  }

  const model = env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const promptLines = [
    "You create illustrated children's storybooks.",
    "Return valid JSON only with this exact shape:",
    '{"title":"string","transcript":"string|null","characterSheet":"string","pages":[{"pageNumber":1,"text":"string","imagePrompt":"string"}]}',
    "",
    "characterSheet: A detailed visual reference describing EVERY character in the story.",
    "For each character include: species/type, exact colors (fur, skin, hair, eyes), body shape/size,",
    "clothing or accessories, and any distinguishing features. Be very specific so an illustrator",
    "could draw the same character consistently across all pages. Example:",
    '"Lola: a small round guinea pig with golden-orange fur, a white patch on her forehead shaped like a star, big dark brown eyes, wearing a tiny red bandana around her neck."',
    "",
    `Create exactly ${input.pageCount} pages with pageNumber starting at 1 and increasing by 1.`,
    "Page text should be 35-70 words and age-appropriate.",
    "Each imagePrompt MUST begin with the full characterSheet text, then describe the specific scene",
    "from that page in a warm children's book illustration style. This ensures every illustration",
    "depicts the characters with identical appearance.",
    `Parent prompt: ${input.prompt}`,
  ];

  if (input.referenceImages.length > 0) {
    promptLines.push("");
    promptLines.push("The user has provided reference photos. Use them as inspiration for the story.");
    promptLines.push("Base the characterSheet on these descriptions:");
    for (const img of input.referenceImages) {
      if (img.description) {
        promptLines.push(`- ${img.description}`);
      }
    }
    promptLines.push("Feature the subjects from these photos as characters, settings, or elements in the story.");
  }

  if (input.transcript) {
    promptLines.push(`Narration transcript: ${input.transcript}`);
  }

  const response = await callGemini(env, model, {
    contents: [
      {
        role: "user",
        parts: [{ text: promptLines.join("\n") }],
      },
    ],
    generationConfig: {
      responseMimeType: "application/json",
      temperature: 0.9,
    },
  });

  const rawText = extractFirstTextPart(response);
  if (!rawText) {
    throw new Error("Gemini returned an empty story response.");
  }

  const parsed = parseJsonObject(rawText);
  const title = typeof parsed.title === "string" && parsed.title.trim() ? parsed.title.trim() : "Untitled Story";
  const transcript = typeof parsed.transcript === "string" && parsed.transcript.trim() ? parsed.transcript.trim() : input.transcript;
  const characterSheet = typeof parsed.characterSheet === "string" && parsed.characterSheet.trim() ? parsed.characterSheet.trim() : "";

  const pages = Array.isArray(parsed.pages)
    ? parsed.pages
        .map((page, index) => {
          if (!page || typeof page !== "object") {
            return null;
          }

          const pageNumberCandidate = (page as Record<string, unknown>).pageNumber;
          const textCandidate = (page as Record<string, unknown>).text;
          const imagePromptCandidate = (page as Record<string, unknown>).imagePrompt;

          const pageNumber =
            typeof pageNumberCandidate === "number" && Number.isFinite(pageNumberCandidate)
              ? Math.trunc(pageNumberCandidate)
              : index + 1;

          if (typeof textCandidate !== "string" || !textCandidate.trim()) {
            return null;
          }

          if (typeof imagePromptCandidate !== "string" || !imagePromptCandidate.trim()) {
            return null;
          }

          return {
            pageNumber,
            text: textCandidate.trim(),
            imagePrompt: imagePromptCandidate.trim(),
          } as StoryPage;
        })
        .filter((page): page is StoryPage => page !== null)
    : [];

  if (!pages.length) {
    throw new Error("Gemini returned story JSON without usable pages.");
  }

  const normalizedPages = pages
    .slice(0, input.pageCount)
    .map((page, index) => ({
      pageNumber: index + 1,
      text: page.text,
      imagePrompt: page.imagePrompt,
    }));

  return {
    title,
    transcript: transcript ?? null,
    characterSheet,
    pages: normalizedPages,
  };
}

async function generateImageWithGemini(
  env: Env,
  input: {
    prompt: string;
    storyTitle: string;
    pageNumber: number;
    characterSheet: string;
    referenceImages: ReferenceImage[];
  },
): Promise<{ bytes: Uint8Array; contentType: string; extension: string } | null> {
  if (!env.GEMINI_API_KEY) {
    return createFallbackSvgImage(input.storyTitle, input.pageNumber, input.prompt);
  }

  const model = env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";

  const promptParts = [
    "Create a single illustration for a children's storybook page.",
    "No text, no watermark, no signatures.",
    "Soft, colorful, warm, expressive characters.",
    "",
    "IMPORTANT — Character visual reference (draw characters EXACTLY as described):",
    input.characterSheet,
  ];

  if (input.referenceImages.length > 0) {
    promptParts.push("");
    promptParts.push("Reference photos are attached. Make the illustrated subjects resemble what's");
    promptParts.push("in the photos (same colors, features, appearance) but rendered in warm");
    promptParts.push("children's storybook illustration style.");
    for (const img of input.referenceImages) {
      if (img.description) {
        promptParts.push(`Photo: ${img.description}`);
      }
    }
  }

  promptParts.push("");
  promptParts.push(`Story title: ${input.storyTitle}`);
  promptParts.push(`Page ${input.pageNumber}: ${input.prompt}`);

  const prompt = promptParts.join("\n");

  // Build parts array: text prompt + reference images
  const parts: Record<string, unknown>[] = [{ text: prompt }];
  for (const img of input.referenceImages) {
    parts.push({
      inlineData: {
        mimeType: img.mimeType,
        data: img.base64,
      },
    });
  }

  try {
    const response = await callGemini(env, model, {
      contents: [{ role: "user", parts }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    });

    const imagePart = findInlineDataPart(response);
    if (!imagePart?.data || !imagePart?.mimeType) {
      return createFallbackSvgImage(input.storyTitle, input.pageNumber, input.prompt);
    }

    const bytes = base64ToBytes(imagePart.data);
    const extension = imagePart.mimeType.includes("png") ? "png" : "jpg";

    return {
      bytes,
      contentType: imagePart.mimeType,
      extension,
    };
  } catch {
    return createFallbackSvgImage(input.storyTitle, input.pageNumber, input.prompt);
  }
}

function createFallbackSvgImage(
  title: string,
  pageNumber: number,
  prompt: string,
): { bytes: Uint8Array; contentType: string; extension: string } {
  const safeTitle = escapeHtml(title);
  const safePrompt = escapeHtml(prompt).slice(0, 160);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
<defs>
  <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0%" stop-color="#ffe08c"/>
    <stop offset="100%" stop-color="#ffa69e"/>
  </linearGradient>
</defs>
<rect width="1024" height="1024" fill="url(#bg)"/>
<rect x="64" y="64" width="896" height="896" rx="36" fill="rgba(255,255,255,0.75)"/>
<text x="96" y="150" font-size="42" font-family="Georgia, serif" fill="#1c1b29">${safeTitle}</text>
<text x="96" y="220" font-size="32" font-family="Georgia, serif" fill="#1c1b29">Page ${pageNumber}</text>
<foreignObject x="96" y="280" width="832" height="640">
  <div xmlns="http://www.w3.org/1999/xhtml" style="font-size:30px;line-height:1.35;color:#1c1b29;font-family:Georgia,serif;">
    ${safePrompt}
  </div>
</foreignObject>
</svg>`;

  return {
    bytes: new TextEncoder().encode(svg),
    contentType: "image/svg+xml",
    extension: "svg",
  };
}

function generateFallbackStory(prompt: string, transcript: string | null, pageCount: number): GeneratedStory {
  const storySeed = transcript || prompt;
  const titleSeed = storySeed.split(/[.!?\n]/).map((line) => line.trim()).find(Boolean) || "A New Adventure";

  const pages: StoryPage[] = Array.from({ length: pageCount }, (_, index) => {
    const pageNumber = index + 1;
    return {
      pageNumber,
      text: `On page ${pageNumber}, our heroes follow this idea: ${prompt}. They notice small clues, help each other, and make a brave choice that moves the adventure forward with kindness and curiosity.`,
      imagePrompt: `Illustrated children's scene for page ${pageNumber}: ${prompt}. Friendly characters, storybook style, bright colors, cozy lighting.`,
    };
  });

  return {
    title: titleSeed.slice(0, 80),
    transcript,
    characterSheet: "",
    pages,
  };
}

async function callGemini(env: Env, model: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not configured.");
  }

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(env.GEMINI_API_KEY)}`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const bodyText = await response.text();

  if (!response.ok) {
    throw new Error(`Gemini API error ${response.status}: ${bodyText.slice(0, 500)}`);
  }

  try {
    return JSON.parse(bodyText) as Record<string, unknown>;
  } catch {
    throw new Error("Gemini API returned non-JSON response.");
  }
}

function extractFirstTextPart(response: Record<string, unknown>): string | null {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  const firstCandidate = candidates[0] as Record<string, unknown>;
  const content = firstCandidate.content as Record<string, unknown> | undefined;
  const parts = content?.parts;

  if (!Array.isArray(parts)) {
    return null;
  }

  for (const part of parts) {
    if (!part || typeof part !== "object") {
      continue;
    }

    const text = (part as Record<string, unknown>).text;
    if (typeof text === "string" && text.trim()) {
      return text;
    }
  }

  return null;
}

function findInlineDataPart(response: Record<string, unknown>): { data: string; mimeType: string } | null {
  const candidates = response.candidates;
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return null;
  }

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") {
      continue;
    }

    const content = (candidate as Record<string, unknown>).content;
    if (!content || typeof content !== "object") {
      continue;
    }

    const parts = (content as Record<string, unknown>).parts;
    if (!Array.isArray(parts)) {
      continue;
    }

    for (const part of parts) {
      if (!part || typeof part !== "object") {
        continue;
      }

      const inlineData = (part as Record<string, unknown>).inlineData;
      if (!inlineData || typeof inlineData !== "object") {
        continue;
      }

      const mimeType = (inlineData as Record<string, unknown>).mimeType;
      const data = (inlineData as Record<string, unknown>).data;

      if (typeof mimeType === "string" && typeof data === "string" && data.length > 0) {
        return { data, mimeType };
      }
    }
  }

  return null;
}

async function verifyTurnstile(secretKey: string, token: string, ip: string): Promise<boolean> {
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        secret: secretKey,
        response: token,
        remoteip: ip,
      }),
    });

    const result = (await response.json()) as Record<string, unknown>;
    return result.success === true;
  } catch {
    return false;
  }
}

async function checkAndIncrementRateLimit(
  db: D1Database,
  ip: string,
  dailyLimit: number,
): Promise<{ allowed: boolean; count: number }> {
  const dateKey = new Date().toISOString().slice(0, 10); // YYYY-MM-DD UTC

  const row = await db
    .prepare("SELECT request_count FROM rate_limits WHERE ip = ?1 AND date_key = ?2")
    .bind(ip, dateKey)
    .first<{ request_count: number }>();

  const currentCount = row?.request_count ?? 0;

  if (currentCount >= dailyLimit) {
    return { allowed: false, count: currentCount };
  }

  await db
    .prepare(
      `INSERT INTO rate_limits (ip, date_key, request_count) VALUES (?1, ?2, 1)
       ON CONFLICT (ip, date_key) DO UPDATE SET request_count = request_count + 1`,
    )
    .bind(ip, dateKey)
    .run();

  return { allowed: true, count: currentCount + 1 };
}

function parseJsonObject(rawText: string): Record<string, unknown> {
  const trimmed = rawText.trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const withoutFence = trimmed.replace(/^```json\s*/i, "").replace(/```$/i, "").trim();
    return JSON.parse(withoutFence) as Record<string, unknown>;
  }
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }

  return bytes;
}

function clampNumber(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }

  return Math.min(max, Math.max(min, Math.round(value)));
}

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: jsonHeaders,
  });
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
