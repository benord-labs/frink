import type { DesktopApi } from './index';

declare global {
  interface Window {
    desktopApi: DesktopApi;
    webUtils?: { getPathForFile: (file: File) => string };
    __FORCE_ANALYTICS__?: boolean;
    __FRINK_QA__?: boolean;
    /** Set by TRPCProvider on QA instances so scripts/perf drivers can invalidate queries. */
    __frinkQaQueryClient?: import('@tanstack/react-query').QueryClient;
  }
}
