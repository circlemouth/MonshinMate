import { useEffect, useState } from 'react';
import { Box, Spinner, Text } from '@chakra-ui/react';

/**
 * 管理画面: ライセンス本文表示ページ。
 * `frontend/public/docs/LICENSE_GPL-3.0.md` を取得して最小Markdownで表示する。
 */
export default function AdminLicense() {
  const [content, setContent] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    fetch('/docs/LICENSE_GPL-3.0.md')
      .then((res) => {
        if (!res.ok) throw new Error();
        return res.text();
      })
      .then((text) => setContent(text))
      .catch(() => setError('ライセンス本文の取得に失敗しました'));
  }, []);

  if (error) return <Text color="red.500" fontSize="sm">{error}</Text>;
  if (!content) return <Spinner />;

  const mdToHtml = (md: string) => {
    const lines = md.split(/\r?\n/);
    const html: string[] = [];
    let inUl = false;
    let inOl = false;
    const flushLists = () => {
      if (inUl) { html.push('</ul>'); inUl = false; }
      if (inOl) { html.push('</ol>'); inOl = false; }
    };
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const inline = (s: string) => {
      s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
      s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
      s = s.replace(/\*([^*]+)\*/g, '<em>$1</em>');
      s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noreferrer">$1</a>');
      return s;
    };
    for (const raw of lines) {
      const line = raw.trimEnd();
      if (!line.trim()) { flushLists(); html.push(''); continue; }
      const m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) { flushLists(); const level = m[1].length; html.push(`<h${level}>${inline(esc(m[2]))}</h${level}>`); continue; }
      const ul = line.match(/^[-*]\s+(.*)$/);
      if (ul) { if (inOl) { html.push('</ol>'); inOl = false; } if (!inUl) { html.push('<ul>'); inUl = true; } html.push(`<li>${inline(esc(ul[1]))}</li>`); continue; }
      const ol = line.match(/^\d+\.\s+(.*)$/);
      if (ol) { if (inUl) { html.push('</ul>'); inUl = false; } if (!inOl) { html.push('<ol>'); inOl = true; } html.push(`<li>${inline(esc(ol[1]))}</li>`); continue; }
      flushLists();
      html.push(`<p>${inline(esc(line))}</p>`);
    }
    flushLists();
    return html.join('\n');
  };

  const html = mdToHtml(content);
  return (
    <Box
      fontSize="sm"
      sx={{
        'h1': { fontSize: 'xl', fontWeight: 'bold', mt: 4, mb: 2 },
        'h2': { fontSize: 'lg', fontWeight: 'bold', mt: 4, mb: 2 },
        'h3': { fontSize: 'md', fontWeight: 'semibold', mt: 3, mb: 2 },
        'p': { mb: 2, lineHeight: 1.7 },
        'ul': { pl: 6, mb: 2, listStyleType: 'disc' },
        'ol': { pl: 6, mb: 2 },
        'li': { mb: 1 },
        'code': { bg: 'gray.50', px: 1, borderRadius: 'sm', fontFamily: 'monospace' },
        'a': { color: 'primary.600', textDecoration: 'underline' },
      }}
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}

