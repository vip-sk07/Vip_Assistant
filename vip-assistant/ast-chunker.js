import path from 'path';

/**
 * AST & Structural Code Chunker
 * Intelligently chunks source code at Function, Class, and Method boundaries.
 */
export function chunkCodeStructurally(content, filePath) {
  const ext = path.extname(filePath).toLowerCase();

  if (['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx'].includes(ext)) {
    return chunkJavaScriptCode(content);
  } else if (ext === '.py') {
    return chunkPythonCode(content);
  }

  // Fallback to sentence/paragraph-aware chunking for text/markdown/json
  return chunkTextByParagraph(content);
}

/**
 * Splits JavaScript / TypeScript files at class, function, and export declarations
 */
function chunkJavaScriptCode(content) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentSymbol = 'module';
  let currentType = 'general';

  // Regular expressions to identify JS/TS block headers
  const symbolRegex = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(function|class|interface|type|const|let|var)\s+([A-Za-z0-9_$]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(symbolRegex);

    if (match && currentChunk.length > 5) {
      // Push previous chunk
      const chunkText = currentChunk.join('\n').trim();
      if (chunkText.length > 30) {
        chunks.push({
          content: chunkText,
          symbolName: currentSymbol,
          symbolType: currentType,
          startLine: i - currentChunk.length + 1,
          endLine: i
        });
      }
      currentChunk = [];
      currentType = match[1];
      currentSymbol = match[2];
    }

    currentChunk.push(line);

    // Hard limit per chunk (~1500 chars)
    if (currentChunk.join('\n').length >= 1500) {
      const chunkText = currentChunk.join('\n').trim();
      chunks.push({
        content: chunkText,
        symbolName: currentSymbol,
        symbolType: currentType,
        startLine: i - currentChunk.length + 1,
        endLine: i
      });
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    const chunkText = currentChunk.join('\n').trim();
    if (chunkText.length > 30) {
      chunks.push({
        content: chunkText,
        symbolName: currentSymbol,
        symbolType: currentType,
        startLine: lines.length - currentChunk.length + 1,
        endLine: lines.length
      });
    }
  }

  return chunks;
}

/**
 * Splits Python files at class and def block boundaries
 */
function chunkPythonCode(content) {
  const lines = content.split('\n');
  const chunks = [];
  let currentChunk = [];
  let currentSymbol = 'module';
  let currentType = 'general';

  const pySymbolRegex = /^(?:async\s+)?(def|class)\s+([A-Za-z0-9_]+)/;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = line.match(pySymbolRegex);

    if (match && currentChunk.length > 5) {
      const chunkText = currentChunk.join('\n').trim();
      if (chunkText.length > 30) {
        chunks.push({
          content: chunkText,
          symbolName: currentSymbol,
          symbolType: currentType,
          startLine: i - currentChunk.length + 1,
          endLine: i
        });
      }
      currentChunk = [];
      currentType = match[1];
      currentSymbol = match[2];
    }

    currentChunk.push(line);

    if (currentChunk.join('\n').length >= 1500) {
      const chunkText = currentChunk.join('\n').trim();
      chunks.push({
        content: chunkText,
        symbolName: currentSymbol,
        symbolType: currentType,
        startLine: i - currentChunk.length + 1,
        endLine: i
      });
      currentChunk = [];
    }
  }

  if (currentChunk.length > 0) {
    const chunkText = currentChunk.join('\n').trim();
    if (chunkText.length > 30) {
      chunks.push({
        content: chunkText,
        symbolName: currentSymbol,
        symbolType: currentType,
        startLine: lines.length - currentChunk.length + 1,
        endLine: lines.length
      });
    }
  }

  return chunks;
}

/**
 * Fallback paragraph/block chunking for text & markdown
 */
function chunkTextByParagraph(content) {
  const chunkSize = 1500;
  const overlap = 200;
  const chunks = [];

  for (let i = 0; i < content.length; i += chunkSize - overlap) {
    const chunkText = content.substring(i, i + chunkSize).trim();
    if (chunkText.length > 30) {
      chunks.push({
        content: chunkText,
        symbolName: 'document',
        symbolType: 'text',
        startLine: 1,
        endLine: chunkText.split('\n').length
      });
    }
    if (i + chunkSize >= content.length || chunks.length >= 15) break;
  }

  return chunks;
}
