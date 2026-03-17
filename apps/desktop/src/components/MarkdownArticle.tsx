interface MarkdownArticleProps {
  content: string;
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

export function MarkdownArticle({ content }: MarkdownArticleProps) {
  const blocks = content
    .split(/\n{2,}/)
    .map((item) => item.trim())
    .filter(Boolean);

  return (
    <article className="markdown-article">
      {blocks.map((block, index) => {
        if (block.startsWith("### ")) {
          return <h3 key={index}>{block.slice(4)}</h3>;
        }
        if (block.startsWith("## ")) {
          return <h2 key={index}>{block.slice(3)}</h2>;
        }
        if (block.startsWith("# ")) {
          return <h1 key={index}>{block.slice(2)}</h1>;
        }
        if (block.startsWith("- ")) {
          const items = block.split("\n").map((item) => item.replace(/^- /, "").trim());
          return (
            <ul key={index}>
              {items.map((item, itemIndex) => (
                <li key={itemIndex}>{renderInline(item)}</li>
              ))}
            </ul>
          );
        }
        return <p key={index}>{renderInline(block)}</p>;
      })}
    </article>
  );
}
