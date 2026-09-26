import type { TriggerSampleCatalog } from '../types';

/** Shared workspaces Frink watches. One raw vendor body per catalog event. */
export const MESSAGING_TRIGGER_SAMPLES = {
  notion: {
    event_received: {
      id: 'notion-event-received',
      type: 'page.deleted',
      entity: { id: 'page-1', type: 'page' },
    },
    page_created: {
      id: 'notion-event-page-created',
      type: 'page.created',
      entity: { id: 'page-1', type: 'page' },
    },
    page_updated: {
      id: 'notion-event-page-updated',
      type: 'page.content_updated',
      entity: { id: 'page-1', type: 'page' },
    },
    comment_added: {
      id: 'notion-event-comment-created',
      type: 'comment.created',
      entity: { id: 'comment-1', type: 'comment' },
    },
    database_updated: {
      id: 'notion-event-database-updated',
      type: 'data_source.schema_updated',
      entity: { id: 'database-1', type: 'data_source' },
    },
  },
} satisfies TriggerSampleCatalog;
