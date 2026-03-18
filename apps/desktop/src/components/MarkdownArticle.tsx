interface MarkdownArticleProps {
  content: string;
  className?: string;
}

function renderInline(text: string) {
  const parts = text.split(/(`[^`]+`|\*\*[^*]+\*\*)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith("**") && part.endsWith("**")) {
      return <strong key={index}>{part.slice(2, -2)}</strong>;
    }
    if (part.startsWith("`") && part.endsWith("`")) {
      return <code key={index}>{part.slice(1, -1)}</code>;
    }
    return <span key={index}>{part}</span>;
  });
}

function renderBlock(block: string, index: number) {
  const lines = block
    .split("\n")
    .map((item) => item.trimEnd())
    .filter(Boolean);

  if (lines.length === 0) {
    return null;
  }

  if (lines.length === 1) {
    const line = lines[0].trim();
    if (line.startsWith("### ")) {
      return <h3 key={index}>{line.slice(4)}</h3>;
    }
    if (line.startsWith("## ")) {
      return <h2 key={index}>{line.slice(3)}</h2>;
    }
    if (line.startsWith("# ")) {
      return <h1 key={index}>{line.slice(2)}</h1>;
    }
  }

  if (lines.every((line) => /^[-*]\s+/.test(line.trim()))) {
    return (
      <ul key={index}>
        {lines.map((line, itemIndex) => (
          <li key={itemIndex}>{renderInline(line.trim().replace(/^[-*]\s+/, ""))}</li>
        ))}
      </ul>
    );
  }

  if (lines.every((line) => /^\d+\.\s+/.test(line.trim()))) {
    return (
      <ol key={index}>
        {lines.map((line, itemIndex) => (
          <li key={itemIndex}>{renderInline(line.trim().replace(/^\d+\.\s+/, ""))}</li>
        ))}
      </ol>
    );
  }

  return (
    <p key={index}>
      {lines.map((line, lineIndex) => (
        <span key={lineIndex}>
          {renderInline(line.trim())}
          {lineIndex < lines.length - 1 ? <br /> : null}
        </span>
      ))}
    </p>
  );
}

export function MarkdownArticle({ content, className }: MarkdownArticleProps) {
  const blocks = content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <article className={className ? `markdown-article ${className}` : "markdown-article"}>
      {blocks.map((block, index) => renderBlock(block, index))}
    </article>
  );
}
