/**
 * The company file = an llmcouncil library folder per ticker.
 *
 * This replicates llmcouncil's context management verbatim — same library
 * store, same note rows the council's own write_library_note tool produces,
 * same per-tier context contracts at intake — with the ring-fence moved from
 * "a chat session" to "a company": every room turn passes the company folder
 * as library_context, and the Desk files evidence notes into it daily.
 */

function base(): string {
  return (process.env.LLMC3_COUNCIL_URL ?? "").replace(/\/$/, "");
}

async function api<T>(
  path: string,
  init?: RequestInit
): Promise<T | null> {
  if (!base()) return null;
  try {
    const res = await fetch(`${base()}${path}`, {
      ...init,
      cache: "no-store",
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

function folderName(ticker: string): string {
  return `${ticker.toUpperCase()} · desk file`;
}

type DocPreview = { type?: string; name?: string; content?: string; url?: string; mime_type?: string };
const previewCache = ((globalThis as Record<string, unknown>).__ammIntentPreviewCache ??=
  new Map<string, { expiresAt: number; value: DocPreview }>()) as Map<string, { expiresAt: number; value: DocPreview }>;
const PREVIEW_CACHE_TTL_MS = 5 * 60_000;

function previewCacheKey(email: string, docId: string): string {
  return `${email.toLowerCase()}::${docId}`;
}

/** Idempotently ensure the user + their company folder exist; returns folder id. */
export async function ensureCompanyFolder(
  email: string,
  ticker: string
): Promise<string | null> {
  const sym = ticker.toUpperCase();
  const q = `email=${encodeURIComponent(email)}`;

  await api(`/api/auth/provision`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email }),
  });

  const workspaces = await api<Array<{ id: string }>>(`/api/library?${q}`);
  const ws = workspaces?.[0]?.id;
  if (!ws) return null;

  const folders = await api<Array<{ id: string; name: string }>>(
    `/api/library/workspaces/${ws}/folders?${q}`
  );
  const existing = folders?.find((f) => f.name === folderName(sym));
  if (existing) return existing.id;

  const created = await api<{ id: string }>(
    `/api/library/workspaces/${ws}/folders?${q}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: folderName(sym) }),
    }
  );
  return created?.id ?? null;
}

export interface FileDoc {
  id: string;
  name: string;
  mime_type: string;
  estimated_tokens: number;
}

/** List every document in the company folder. */
export async function listFolderDocs(
  email: string,
  folderId: string
): Promise<FileDoc[]> {
  const docs = await api<Array<Record<string, unknown>>>(
    `/api/library/folders/${folderId}/documents?email=${encodeURIComponent(email)}`
  );
  if (!Array.isArray(docs)) return [];
  return docs
    .filter((d) => d && typeof d.id === "string")
    .map((d) => ({
      id: String(d.id),
      name: String(d.name ?? "untitled"),
      mime_type: String(d.mime_type ?? "text/markdown"),
      estimated_tokens: Number(d.estimated_tokens ?? 0) || 0,
    }));
}

/** Update a note's name/content in place. */
export async function updateNote(
  email: string,
  docId: string,
  patch: { name?: string; content?: string }
): Promise<boolean> {
  const res = await api<{ error?: string }>(
    `/api/library/documents/${docId}/content?email=${encodeURIComponent(email)}`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    }
  );
  const ok = res != null && !res.error;
  if (ok) previewCache.delete(previewCacheKey(email, docId));
  return ok;
}

/** Fetch a document's text (or signed URL for binary files) for the viewer. */
export async function previewDoc(
  email: string,
  docId: string
): Promise<DocPreview | null> {
  return api(
    `/api/library/documents/${docId}/preview?email=${encodeURIComponent(email)}`
  );
}

/** Short-lived read-through cache for per-question intent matching. */
export async function previewDocForIntent(email: string, docId: string): Promise<DocPreview | null> {
  const key = previewCacheKey(email, docId);
  const cached = previewCache.get(key);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) previewCache.delete(key);
  const value = await previewDoc(email, docId);
  if (value?.content) previewCache.set(key, { expiresAt: Date.now() + PREVIEW_CACHE_TTL_MS, value });
  return value;
}

/** Upload a binary file (PDF etc.) into the company folder — one-machine attach. */
export async function uploadFileToFolder(
  email: string,
  folderId: string,
  file: File
): Promise<{ id?: string; name?: string } | null> {
  if (!base()) return null;
  try {
    const fd = new FormData();
    fd.append("file", file, file.name);
    const res = await fetch(
      `${base()}/api/library/folders/${folderId}/upload?email=${encodeURIComponent(email)}`,
      { method: "POST", body: fd, signal: AbortSignal.timeout(30_000) }
    );
    if (!res.ok) return null;
    return (await res.json()) as { id?: string; name?: string };
  } catch {
    return null;
  }
}

/** File a markdown evidence note into the company folder. */
export async function addEvidenceNote(
  email: string,
  folderId: string,
  name: string,
  content: string
): Promise<boolean> {
  const res = await api<{ error?: string }>(
    `/api/library/folders/${folderId}/notes?email=${encodeURIComponent(email)}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, content }),
    }
  );
  return res != null && !res.error;
}
