/**
 * detectLanguage infers a programming language from file path heuristics.
 * It first checks exact filenames (for extensionless names like Dockerfile),
 * then falls back to extension-to-language mapping.
 */
const FILE_EXTENSION_REGEX = /\.[^.]+$/;
const PATH_SEPARATOR_REGEX = /[\\/]/;
const DOCKERFILE_NAME_REGEX = /^dockerfile(?:$|\.)/;

const extensionMap: Record<string, string> = {
  '.ts': 'typescript',
  '.tsx': 'typescript',
  '.js': 'javascript',
  '.jsx': 'javascript',
  '.json': 'json',
  '.md': 'markdown',
  '.mdx': 'markdown',
  '.css': 'css',
  '.scss': 'scss',
  '.less': 'less',
  '.html': 'html',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.py': 'python',
  '.rb': 'ruby',
  '.go': 'go',
  '.rs': 'rust',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',
  '.c': 'c',
  '.cpp': 'cpp',
  '.h': 'c',
  '.hpp': 'cpp',
  '.cs': 'csharp',
  '.php': 'php',
  '.sql': 'sql',
  '.sh': 'shell',
  '.bash': 'shell',
  '.zsh': 'shell',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.dockerfile': 'dockerfile',
  '.gitignore': 'plaintext',
  '.env': 'plaintext',
};

export function detectLanguage(
  filePath: string,
  languageByExtension?: Readonly<Record<string, string>>,
): string {
  const normalizedPath = filePath.toLowerCase();
  const fileName = normalizedPath.split(PATH_SEPARATOR_REGEX).pop() || normalizedPath;

  if (languageByExtension) {
    const extensionWithDot = normalizedPath.match(FILE_EXTENSION_REGEX)?.[0];
    if (extensionWithDot) {
      const extension = extensionWithDot.slice(1);
      const mapped = languageByExtension[extension] ?? languageByExtension[extensionWithDot];
      if (mapped) return mapped;
    }
    return DOCKERFILE_NAME_REGEX.test(fileName) ? 'dockerfile' : 'plaintext';
  }

  if (DOCKERFILE_NAME_REGEX.test(fileName)) {
    return 'dockerfile';
  }

  const ext = normalizedPath.match(FILE_EXTENSION_REGEX)?.[0] || '';
  return extensionMap[ext] || 'plaintext';
}
