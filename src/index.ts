interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  STORYBOOK_BUCKET: R2Bucket;
  GEMINI_API_KEY?: string;
  GEMINI_TEXT_MODEL?: string;
  GEMINI_IMAGE_MODEL?: string;
  MAX_PAGES?: string;
}

interface GenerateStoryRequest {
  prompt?: string;
  transcript?: string;
  audioBase64?: string;
  audioMimeType?: string;
  pageCount?: number;
}

interface StoryPage {
  pageNumber: number;
  text: string;
  imagePrompt: string;
}

interface GeneratedStory {
  title: string;
  transcript: string | null;
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
  const payload = (await request.json()) as GenerateStoryRequest;

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

  const generated = await generateStoryWithGemini(env, {
    prompt,
    transcript,
    pageCount,
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
  },
): Promise<GeneratedStory> {
  if (!env.GEMINI_API_KEY) {
    return generateFallbackStory(input.prompt, input.transcript, input.pageCount);
  }

  const model = env.GEMINI_TEXT_MODEL || "gemini-2.5-flash";
  const promptLines = [
    "You create illustrated children's storybooks.",
    "Return valid JSON only with this exact shape:",
    '{"title":"string","transcript":"string|null","pages":[{"pageNumber":1,"text":"string","imagePrompt":"string"}]}',
    `Create exactly ${input.pageCount} pages with pageNumber starting at 1 and increasing by 1.`,
    "Page text should be 35-70 words and age-appropriate.",
    "Each imagePrompt should describe the same scene from the page text in a warm illustrated style.",
    `Parent prompt: ${input.prompt}`,
  ];

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
    pages: normalizedPages,
  };
}

async function generateImageWithGemini(
  env: Env,
  input: { prompt: string; storyTitle: string; pageNumber: number },
): Promise<{ bytes: Uint8Array; contentType: string; extension: string } | null> {
  if (!env.GEMINI_API_KEY) {
    return createFallbackSvgImage(input.storyTitle, input.pageNumber, input.prompt);
  }

  const model = env.GEMINI_IMAGE_MODEL || "gemini-3.1-flash-image-preview";

  const prompt = [
    "Create a single illustration for a children's storybook page.",
    "No text, no watermark, no signatures.",
    "Soft, colorful, warm, expressive characters.",
    `Story title: ${input.storyTitle}`,
    `Page ${input.pageNumber}: ${input.prompt}`,
  ].join("\n");

  try {
    const response = await callGemini(env, model, {
      contents: [{ role: "user", parts: [{ text: prompt }] }],
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
