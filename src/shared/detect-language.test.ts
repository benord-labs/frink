import { describe, expect, it } from 'vitest';
import { detectLanguage } from './detect-language';

describe('detectLanguage', () => {
  it('detects Dockerfile variants by filename', () => {
    expect(detectLanguage('Dockerfile')).toBe('dockerfile');
    expect(detectLanguage('dockerfile')).toBe('dockerfile');
    expect(detectLanguage('DockerFile')).toBe('dockerfile');
    expect(detectLanguage('Dockerfile.dev')).toBe('dockerfile');
    expect(detectLanguage('dockerfile.dev')).toBe('dockerfile');
    expect(detectLanguage('/tmp/project/Dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('/tmp/project/dockerfile.prod')).toBe('dockerfile');
    expect(detectLanguage('/tmp/project/DockerFile.prod')).toBe('dockerfile');
    expect(detectLanguage('C:\\repo\\Dockerfile.local')).toBe('dockerfile');
    expect(detectLanguage('my-dockerfile')).not.toBe('dockerfile');
    expect(detectLanguage('notDockerfile')).not.toBe('dockerfile');
    expect(detectLanguage('/tmp/dockerfile_backup.txt')).not.toBe('dockerfile');
    expect(detectLanguage('C:\\repo\\project-dockerfile.txt')).not.toBe('dockerfile');
    expect(detectLanguage('dockerfiletest.txt')).toBe('plaintext');
    expect(detectLanguage('dockerfiles.json')).toBe('json');
    expect(detectLanguage('dockerfile-override')).toBe('plaintext');
    expect(detectLanguage('dockerfile.v1')).toBe('dockerfile');
  });

  it('falls back to extension mapping for non-docker files', () => {
    expect(detectLanguage('src/index.ts')).toBe('typescript');
    expect(detectLanguage('README.md')).toBe('markdown');
    expect(detectLanguage('unknown.customext')).toBe('plaintext');
  });

  it('uses caller-provided language IDs without changing their aliases', () => {
    const languageByExtension = {
      '.mjs': 'javascript',
      js: 'javascript',
      tsx: 'tsx',
      sh: 'bash',
    };

    expect(detectLanguage('RUN.MJS', languageByExtension)).toBe('javascript');
    expect(detectLanguage('App.TSX', languageByExtension)).toBe('tsx');
    expect(detectLanguage('script.sh', languageByExtension)).toBe('bash');
    expect(detectLanguage('README.md', languageByExtension)).toBe('plaintext');
    expect(detectLanguage('tsx', languageByExtension)).toBe('plaintext');
    expect(detectLanguage('Dockerfile', languageByExtension)).toBe('dockerfile');
    expect(detectLanguage('dockerfile.js', languageByExtension)).toBe('javascript');
    expect(detectLanguage('Dockerfile.md', { md: 'markdown' })).toBe('markdown');
    expect(detectLanguage('Dockerfile.prod', languageByExtension)).toBe('dockerfile');
  });
});
