import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface MarkdownArticleProps {
  content: string;
  className?: string;
}

const markdownComponents: Components = {
  a({ href, ...props }) {
    const isExternal = Boolean(href && /^https?:\/\//i.test(href));
    return <a href={href} {...props} target={isExternal ? "_blank" : undefined} rel={isExternal ? "noreferrer" : undefined} />;
  },
  code({ className, children, ...props }) {
    const raw = String(children);
    const text = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
    const isBlock = Boolean(className && /language-/.test(className));

    if (!isBlock) {
      return (
        <code className={className} {...props}>
          {text}
        </code>
      );
    }

    return (
      <code className={className} {...props}>
        {text}
      </code>
    );
  }
};

export function MarkdownArticle({ content, className }: MarkdownArticleProps) {
  return (
    <article className={className ? `markdown-article ${className}` : "markdown-article"}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[rehypeHighlight]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </article>
  );
}
