"use client";

// Console-token twin of app/ui/markdown.tsx for the admin portal (which renders
// inside .console-root, where the legacy design-system utility classes would not
// follow the console theme). Same rendering rules: CommonMark + GFM via react-markdown, no
// rehype-raw — embedded HTML/script in model output is escaped, safe for
// untrusted text.
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx } from "../../console/lib/format";

export function Markdown({ children, className }: { children: string; className?: string }) {
  return (
    <div className={cx("text-[length:var(--con-fs-sm)] leading-relaxed [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          p: (props) => <p className="my-2 whitespace-pre-wrap" {...props} />,
          a: ({ href, ...props }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-[color:var(--con-accent)] underline decoration-dotted" {...props} />
          ),
          ul: (props) => <ul className="my-2 list-disc space-y-1 pl-5" {...props} />,
          ol: (props) => <ol className="my-2 list-decimal space-y-1 pl-5" {...props} />,
          li: (props) => <li className="leading-relaxed" {...props} />,
          strong: (props) => <strong className="font-semibold text-[color:var(--con-fg)]" {...props} />,
          em: (props) => <em className="italic" {...props} />,
          h1: (props) => <h1 className="mb-1 mt-3 text-base font-semibold text-[color:var(--con-fg)]" {...props} />,
          h2: (props) => <h2 className="mb-1 mt-3 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]" {...props} />,
          h3: (props) => <h3 className="mb-1 mt-2 text-[length:var(--con-fs-sm)] font-semibold text-[color:var(--con-fg)]" {...props} />,
          blockquote: (props) => <blockquote className="my-2 border-l-2 border-[color:var(--con-line)] pl-3 text-[color:var(--con-muted)]" {...props} />,
          hr: () => <hr className="my-3 border-[color:var(--con-line)]" />,
          code: ({ className: cls, children: kids, ...props }) => {
            const isBlock = typeof cls === "string" && cls.includes("language-");
            if (isBlock) {
              return (
                <code className={cx("con-mono block overflow-x-auto rounded-[var(--con-radius-sm)] bg-[color:var(--con-surface-2)] p-2 text-[0.8rem]", cls)} {...props}>
                  {kids}
                </code>
              );
            }
            return (
              <code className="con-mono rounded bg-[color:var(--con-surface-2)] px-1 py-0.5 text-[0.85em]" {...props}>
                {kids}
              </code>
            );
          },
          pre: (props) => <pre className="my-2 overflow-x-auto" {...props} />,
          table: (props) => (
            <div className="my-2 overflow-x-auto">
              <table className="w-full border-collapse text-[length:var(--con-fs-xs)]" {...props} />
            </div>
          ),
          th: (props) => <th className="border border-[color:var(--con-line)] px-2 py-1 text-left font-semibold" {...props} />,
          td: (props) => <td className="border border-[color:var(--con-line)] px-2 py-1" {...props} />
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
