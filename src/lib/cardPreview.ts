/** Keep collapsed desk cards short even when a thesis carries full citation markup. */
export function cardPreviewText(value: string, max = 180): string {
  const plain = value
    .replace(/\[(?:\d+\s*·\s*)?\d{4}-\d{2}-\d{2}\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/g, "")
    .replace(/\[([^\]]+)\]\(https?:\/\/[^\s)]+(?:\s+"[^"]*")?\)/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[*_`#]/g, "")
    .replace(/\s+([,.;:!?])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();

  if (plain.length <= max) return plain;
  const clipped = plain.slice(0, Math.max(0, max - 1));
  const boundary = clipped.lastIndexOf(" ");
  return `${clipped.slice(0, boundary > max * 0.7 ? boundary : clipped.length).trim()}…`;
}

/**
 * Turn the chairman's full directional proposition into a short card hook.
 * The full thesis remains untouched in the dossier; this only removes the
 * repeated direction/horizon boilerplate from the desk preview when a clear
 * "because" mechanism is available.
 */
export function cardPreviewHook(value: string, maxWords = 16): string {
  const plain = cardPreviewText(value, 10_000)
    .split(/\s+(?:the\s+)?risk\s+is\b/i)[0]
    .trim();
  const mechanism = plain.match(/\bbecause\s+(.+)$/i)?.[1]?.trim();
  const eventLead = plain.split(/,\s+so\b/i)[0]?.trim();
  const candidate = mechanism && mechanism.split(/\s+/).length >= 5
    ? mechanism
    : eventLead && eventLead.split(/\s+/).length >= 5
      ? eventLead
      : plain;
  const words = candidate.split(/\s+/).filter(Boolean);
  const clipped = words.slice(0, maxWords).join(" ").replace(/[,:;]+$/, "");
  const hook = `${clipped}${words.length > maxWords ? "…" : ""}`;
  return hook ? hook.charAt(0).toUpperCase() + hook.slice(1) : "Research update";
}
