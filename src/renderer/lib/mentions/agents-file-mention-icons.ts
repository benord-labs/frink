import type { IconifyIcon } from '@iconify/react/offline';
import astroIcon from '@iconify-icons/vscode-icons/file-type-astro';
import cIcon from '@iconify-icons/vscode-icons/file-type-c';
import cppIcon from '@iconify-icons/vscode-icons/file-type-cpp';
import csharpIcon from '@iconify-icons/vscode-icons/file-type-csharp';
import cssIcon from '@iconify-icons/vscode-icons/file-type-css';
import dockerIcon from '@iconify-icons/vscode-icons/file-type-docker';
import dotenvIcon from '@iconify-icons/vscode-icons/file-type-dotenv';
import gitIcon from '@iconify-icons/vscode-icons/file-type-git';
import goIcon from '@iconify-icons/vscode-icons/file-type-go';
import graphqlIcon from '@iconify-icons/vscode-icons/file-type-graphql';
import htmlIcon from '@iconify-icons/vscode-icons/file-type-html';
import imageIcon from '@iconify-icons/vscode-icons/file-type-image';
import javaIcon from '@iconify-icons/vscode-icons/file-type-java';
import jsIcon from '@iconify-icons/vscode-icons/file-type-js';
import jsonIcon from '@iconify-icons/vscode-icons/file-type-json';
import kotlinIcon from '@iconify-icons/vscode-icons/file-type-kotlin';
import markdownIcon from '@iconify-icons/vscode-icons/file-type-markdown';
import npmIcon from '@iconify-icons/vscode-icons/file-type-npm';
import pdfIcon from '@iconify-icons/vscode-icons/file-type-pdf2';
import phpIcon from '@iconify-icons/vscode-icons/file-type-php';
import prismaIcon from '@iconify-icons/vscode-icons/file-type-prisma';
import pythonIcon from '@iconify-icons/vscode-icons/file-type-python';
import reactIcon from '@iconify-icons/vscode-icons/file-type-reactts';
import rubyIcon from '@iconify-icons/vscode-icons/file-type-ruby';
import rustIcon from '@iconify-icons/vscode-icons/file-type-rust';
import scssIcon from '@iconify-icons/vscode-icons/file-type-scss';
import shellIcon from '@iconify-icons/vscode-icons/file-type-shell';
import sqlIcon from '@iconify-icons/vscode-icons/file-type-sql';
import svelteIcon from '@iconify-icons/vscode-icons/file-type-svelte';
import swiftIcon from '@iconify-icons/vscode-icons/file-type-swift';
import textIcon from '@iconify-icons/vscode-icons/file-type-text';
import tomlIcon from '@iconify-icons/vscode-icons/file-type-toml';
import typescriptIcon from '@iconify-icons/vscode-icons/file-type-typescript';
import vueIcon from '@iconify-icons/vscode-icons/file-type-vue';
import yamlIcon from '@iconify-icons/vscode-icons/file-type-yaml';
import { Files } from 'lucide-react';
import type { ComponentType } from 'react';
import { isImagePath } from '../../../shared/image-extensions';
import { iconifyComponent } from '../utils/iconify-component';

type FileIconComponent = ComponentType<{ className?: string }>;

const MARKDOWN_EXT_REGEX = /\.(md|mdx)$/;

const BASENAME_ICONS = new Map(
  Object.entries({
    dockerfile: dockerIcon,
    '.env': dotenvIcon,
    '.gitignore': gitIcon,
    '.npmrc': npmIcon,
    '.prettierrc': jsonIcon,
  }),
);

const EXTENSION_ICONS = new Map(
  Object.entries({
    pdf: pdfIcon,
    dockerfile: dockerIcon,
    env: dotenvIcon,
    tsx: reactIcon,
    jsx: reactIcon,
    ts: typescriptIcon,
    js: jsIcon,
    mjs: jsIcon,
    cjs: jsIcon,
    py: pythonIcon,
    pyw: pythonIcon,
    pyi: pythonIcon,
    go: goIcon,
    rs: rustIcon,
    md: markdownIcon,
    mdx: markdownIcon,
    css: cssIcon,
    html: htmlIcon,
    htm: htmlIcon,
    scss: scssIcon,
    sass: scssIcon,
    json: jsonIcon,
    jsonc: jsonIcon,
    yaml: yamlIcon,
    yml: yamlIcon,
    sh: shellIcon,
    bash: shellIcon,
    zsh: shellIcon,
    sql: sqlIcon,
    graphql: graphqlIcon,
    gql: graphqlIcon,
    prisma: prismaIcon,
    toml: tomlIcon,
    java: javaIcon,
    c: cIcon,
    h: cIcon,
    cpp: cppIcon,
    cc: cppIcon,
    cxx: cppIcon,
    hpp: cppIcon,
    cs: csharpIcon,
    php: phpIcon,
    rb: rubyIcon,
    kt: kotlinIcon,
    vue: vueIcon,
    svelte: svelteIcon,
    astro: astroIcon,
    swift: swiftIcon,
    txt: textIcon,
  }),
);

function resolveFileIcon(filename: string): IconifyIcon | undefined {
  const basename = filename.toLowerCase().replace(/\\/g, '/').split('/').pop() ?? '';
  if (isImagePath(filename)) return imageIcon;
  if (basename.startsWith('.env.')) return dotenvIcon;
  if (MARKDOWN_EXT_REGEX.test(basename)) return markdownIcon;
  return BASENAME_ICONS.get(basename) ?? EXTENSION_ICONS.get(basename.split('.').pop() ?? '');
}

/** File icon component based on file extension (no mention UI / data fetching). */
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown: true,
): FileIconComponent | null;
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown?: false,
): FileIconComponent;
export function getFileIconByExtension(
  filename: string,
  returnNullForUnknown?: boolean,
): FileIconComponent | null {
  const icon = resolveFileIcon(filename);
  if (icon) return iconifyComponent(icon);
  return returnNullForUnknown === true ? null : Files;
}
