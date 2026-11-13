"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

/** Paper Round-styled markdown for council output: headings, tables, links. */
export default function Md({ text }: { text: string }) {
  return (
    <div className="nd-md text-[14px] leading-relaxed">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h3 className="pp-disp font-extrabold text-[18px] mt-4 mb-1.5 tracking-tight">{children}</h3>
          ),
          h2: ({ children }) => (
            <h3 className="pp-disp font-extrabold text-[17px] mt-4 mb-1.5 tracking-tight">{children}</h3>
          ),
          h3: ({ children }) => (
            <h4 className="pp-disp font-bold text-[15px] mt-3.5 mb-1">{children}</h4>
          ),
          p: ({ children }) => <p className="my-1.5">{children}</p>,
          ul: ({ children }) => <ul className="my-1.5 pl-5 list-disc space-y-1">{children}</ul>,
          ol: ({ children }) => <ol className="my-1.5 pl-5 list-decimal space-y-1">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          a: ({ href, children, title }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              title={title}
              className={String(children).includes(" · 20")
                ? "inline-flex items-center rounded px-1.5 py-0.5 no-underline pp-mono text-[10px] font-semibold whitespace-nowrap"
                : "underline break-all"}
              style={String(children).includes(" · 20")
                ? { color: "var(--pr-blue)", background: "rgba(43,75,242,.1)", border: "1px solid rgba(43,75,242,.25)" }
                : { color: "var(--pr-blue)" }}
            >
              {children}
            </a>
          ),
          strong: ({ children }) => <strong className="font-bold">{children}</strong>,
          em: ({ children }) => <em>{children}</em>,
          hr: () => (
            <hr className="my-3 border-0" style={{ borderTop: "1.5px solid rgba(22,21,15,.2)" }} />
          ),
          blockquote: ({ children }) => (
            <blockquote
              className="my-2 pl-3 italic"
              style={{ borderLeft: "3px solid var(--pr-orange)", color: "var(--pr-dim)" }}
            >
              {children}
            </blockquote>
          ),
          code: ({ children, className }) =>
            className ? (
              <pre
                className="pp-mono text-[11.5px] p-3 rounded-lg overflow-x-auto my-2"
                style={{ background: "#FBF8F1", border: "1.5px solid rgba(22,21,15,.25)" }}
              >
                <code>{children}</code>
              </pre>
            ) : (
              <code
                className="pp-mono text-[12px] px-1 py-0.5 rounded"
                style={{ background: "rgba(22,21,15,.07)" }}
              >
                {children}
              </code>
            ),
          table: ({ children }) => (
            <div className="overflow-x-auto my-2.5">
              <table
                className="w-full text-[12.5px]"
                style={{ border: "2px solid var(--pr-ink)", borderCollapse: "collapse" }}
              >
                {children}
              </table>
            </div>
          ),
          thead: ({ children }) => (
            <thead
              className="pp-mono text-[10px] uppercase tracking-[0.1em]"
              style={{ background: "var(--pr-ink)", color: "var(--pr-paper)" }}
            >
              {children}
            </thead>
          ),
          th: ({ children }) => (
            <th className="text-left px-2.5 py-1.5 font-medium" style={{ border: "1px solid rgba(22,21,15,.3)" }}>
              {children}
            </th>
          ),
          td: ({ children }) => (
            <td className="px-2.5 py-1.5 align-top" style={{ border: "1px solid rgba(22,21,15,.25)" }}>
              {children}
            </td>
          ),
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}
