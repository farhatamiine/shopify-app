export type ProductSnapshot = {
  id: string;
  title: string;
  descriptionHtml: string | null;
  tags: string[];
  seoTitle: string | null | undefined;
  seoDescription: string | null | undefined;
};

export type OptimizedContent = {
  descriptionHtml: string;
  tags: string[];
  seoTitle: string;
  seoDescription: string;
};

const OPENAI_ENDPOINT = "https://api.openai.com/v1/chat/completions";
const DEFAULT_MODEL = process.env.OPENAI_MODEL ?? "gpt-4o-mini";

export class OptimizationError extends Error {}

export async function createOptimizedContent(
  snapshot: ProductSnapshot,
): Promise<OptimizedContent> {
  try {
    const aiResult = await generateWithOpenAI(snapshot);
    return sanitizeOptimizedResult(snapshot, aiResult);
  } catch (error) {
    const fallback = generateFallbackContent(snapshot);

    if (error instanceof OptimizationError) {
      return fallback;
    }

    console.error("OpenAI request failed, using fallback content", error);
    return fallback;
  }
}

async function generateWithOpenAI(
  snapshot: ProductSnapshot,
): Promise<OptimizedContent> {
  if (!process.env.OPENAI_API_KEY) {
    throw new OptimizationError("OPENAI_API_KEY is not configured");
  }

  const { title, descriptionHtml, tags, seoTitle, seoDescription } = snapshot;
  const plainDescription = stripHtml(descriptionHtml ?? "");

  const systemPrompt =
    "You are an ecommerce SEO copywriter. Improve product descriptions, tags, and SEO metadata while staying accurate to the product.";

  const userPrompt = `Product title: ${title}
Current description: ${plainDescription || "(none)"}
Current tags: ${tags.join(", ") || "(none)"}
Current SEO title: ${seoTitle ?? "(none)"}
Current SEO description: ${seoDescription ?? "(none)"}

Return JSON with keys descriptionHtml, tags (array of 3-8 concise keyword phrases), seoTitle (35-60 characters) and seoDescription (110-160 characters). Use simple HTML paragraphs and lists for the description. Do not invent features that are not mentioned.`;

  const response = await fetch(OPENAI_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      temperature: 0.6,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });

  const payload = await response.json();

  if (!response.ok) {
    throw new OptimizationError(payload?.error?.message ?? "OpenAI request failed");
  }

  const content: string | undefined = payload?.choices?.[0]?.message?.content;

  if (!content) {
    throw new OptimizationError("OpenAI response did not include content");
  }

  const parsed = safeJsonParse<OptimizedContent>(content);

  if (!parsed) {
    throw new OptimizationError("OpenAI response was not valid JSON");
  }

  return parsed;
}

function sanitizeOptimizedResult(
  snapshot: ProductSnapshot,
  result: OptimizedContent,
): OptimizedContent {
  const descriptionHtml = normalizeDescription(result.descriptionHtml);
  const tags = normalizeTags(result.tags, snapshot);
  const seoTitle = enforceLength(
    result.seoTitle,
    35,
    60,
    fallbackSeoTitle(snapshot),
  );
  const seoDescription = enforceLength(
    result.seoDescription,
    110,
    160,
    fallbackSeoDescription(snapshot),
  );

  return {
    descriptionHtml,
    tags,
    seoTitle,
    seoDescription,
  };
}

function generateFallbackContent(snapshot: ProductSnapshot): OptimizedContent {
  const { title } = snapshot;
  const baseDescription = stripHtml(snapshot.descriptionHtml ?? "");
  const intro = baseDescription || `${title} delivers quality and value for your store.`;
  const keyBenefits = buildKeywordsFromTitle(title).slice(0, 4);
  const descriptionHtml = [
    wrapInParagraph(intro),
    keyBenefits.length
      ? `<ul>${keyBenefits.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`
      : "",
    wrapInParagraph(
      "Enjoy fast shipping, secure checkout, and responsive customer support when you order today.",
    ),
  ]
    .filter(Boolean)
    .join("");

  const tags = normalizeTags(snapshot.tags.length ? snapshot.tags : keyBenefits, snapshot);
  const seoTitle = enforceLength(fallbackSeoTitle(snapshot), 35, 60);
  const seoDescription = enforceLength(fallbackSeoDescription(snapshot), 110, 160);

  return { descriptionHtml, tags, seoTitle, seoDescription };
}

function fallbackSeoTitle(snapshot: ProductSnapshot): string {
  const keywords = buildKeywordsFromTitle(snapshot.title).slice(0, 3);
  const suffix = keywords.length ? ` | ${keywords.join(" • ")}` : " | Shop Now";
  return `${snapshot.title}${suffix}`;
}

function fallbackSeoDescription(snapshot: ProductSnapshot): string {
  const description = stripHtml(snapshot.descriptionHtml ?? "");
  const base = description
    ? description
    : `${snapshot.title} is crafted to help customers feel confident in their purchase.`;
  const closing =
    " Shop now for quick shipping, secure checkout, and helpful customer service.";
  return `${base}${closing}`;
}

function normalizeDescription(content: string): string {
  const trimmed = content.trim();
  if (!trimmed) {
    return "";
  }

  if (!/<p|<ul|<ol|<div/i.test(trimmed)) {
    return wrapInParagraph(trimmed);
  }

  return trimmed;
}

function normalizeTags(tags: unknown, snapshot: ProductSnapshot): string[] {
  let normalized: string[] = [];

  if (Array.isArray(tags)) {
    normalized = tags.map((tag) => String(tag).trim()).filter(Boolean);
  } else if (typeof tags === "string") {
    normalized = tags
      .split(/[,\n]/)
      .map((tag) => tag.trim())
      .filter(Boolean);
  }

  if (!normalized.length) {
    normalized = buildKeywordsFromTitle(snapshot.title);
  }

  const deduped = Array.from(new Set(normalized.map((tag) => tag.toLowerCase())));
  const cased = deduped.map((tag) => capitalize(tag));

  return cased.slice(0, 8);
}

function enforceLength(
  value: string,
  min: number,
  max: number,
  fallback?: string,
): string {
  let text = value?.trim() || "";

  if (!text && fallback) {
    text = fallback.trim();
  }

  if (!text) {
    text = "Shop our curated collection today.";
  }

  if (text.length > max) {
    text = `${text.slice(0, max - 1).trimEnd()}…`;
  }

  while (text.length < min) {
    text = `${text}${text.endsWith(".") ? "" : "."} Discover more in our store.`;
    if (text.length > max) {
      text = `${text.slice(0, max - 1).trimEnd()}…`;
      break;
    }
  }

  return text;
}

function safeJsonParse<T>(value: string): T | null {
  const cleaned = value
    .replace(/^```json/i, "")
    .replace(/^```/, "")
    .replace(/```$/, "")
    .trim();

  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    console.warn("Failed to parse JSON content", error, value);
    return null;
  }
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}

function wrapInParagraph(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }

  return `<p>${escapeHtml(trimmed)}</p>`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function buildKeywordsFromTitle(title: string): string[] {
  return title
    .split(/\s+/)
    .map((word) => word.replace(/[^a-z0-9-]/gi, "").toLowerCase())
    .filter((word) => word.length > 2)
    .slice(0, 6);
}

function capitalize(value: string): string {
  if (!value) {
    return value;
  }

  return value.charAt(0).toUpperCase() + value.slice(1);
}
