import type { TriggerSampleCatalog } from '../types';

/** Where models and sites are authored and shipped. One raw vendor body per catalog event. */
export const CODE_TRIGGER_SAMPLES = {
  huggingface: {
    // `repo` is a real Hugging Face scope no named intent claims, so it lands on the catch-all.
    webhook_received: {
      event: { action: 'update', scope: 'repo' },
      repo: {
        type: 'model',
        name: 'acme/checkout-classifier',
        url: { web: 'https://huggingface.co/acme/checkout-classifier' },
      },
    },
    repo_content_changed: {
      event: { action: 'update', scope: 'repo.content' },
      repo: {
        type: 'model',
        name: 'acme/checkout-classifier',
        headSha: 'd41c9f0',
        url: { web: 'https://huggingface.co/acme/checkout-classifier' },
      },
    },
    discussion_changed: {
      event: { action: 'create', scope: 'discussion' },
      repo: { type: 'model', name: 'acme/checkout-classifier' },
      discussion: {
        num: 12,
        title: 'Add a smaller variant',
        isPullRequest: false,
        url: { web: 'https://huggingface.co/acme/checkout-classifier/discussions/12' },
      },
    },
    discussion_comment: {
      event: { action: 'create', scope: 'discussion.comment' },
      repo: { type: 'model', name: 'acme/checkout-classifier' },
      discussion: { num: 12, title: 'Add a smaller variant' },
      comment: { id: '66d0', content: 'Happy to review this.', author: { id: 'you' } },
    },
  },

  webflow: {
    // A real Webflow trigger no named intent claims, so it lands on the catch-all.
    event_received: {
      triggerType: 'page_created',
      payload: { id: 'pg_7712', siteId: 'st_0091', pageTitle: 'Pricing' },
    },
    form_submitted: {
      triggerType: 'form_submission',
      payload: {
        id: 'fs_4410',
        siteId: 'st_0091',
        name: 'Contact',
        data: { email: 'sam@example.com', message: 'Checkout keeps failing.' },
      },
    },
    site_published: {
      triggerType: 'site_publish',
      payload: {
        id: 'pub_2280',
        siteId: 'st_0091',
        publishedBy: { displayName: 'You' },
        domains: ['acme.com'],
      },
    },
    collection_item_changed: {
      triggerType: 'collection_item_created',
      payload: {
        id: 'ci_5531',
        siteId: 'st_0091',
        collectionId: 'col_12',
        fieldData: { name: 'Autumn sale', slug: 'autumn-sale' },
      },
    },
  },
} satisfies TriggerSampleCatalog;
