/** Curated example prompts per provider, each scoped to that provider's own capabilities. */
const PLUGIN_PROMPTS = new Map<string, readonly string[]>(
  Object.entries({
    shortcut: [
      'What is assigned to me in Shortcut right now? Rank it by what to tackle first',
      'Summarize the Shortcut stories that moved this week and what is still blocked',
      'Write a Shortcut story for the bug I am about to describe, with acceptance criteria',
    ],
    github: [
      'Which of my GitHub pull requests are waiting on review, and what is blocking the rest?',
      'Summarize what merged in GitHub this week and flag anything risky',
      'Draft a review summary for the oldest open pull request I should look at',
    ],
    clickup: [
      'What is overdue in ClickUp this week, and who owns each item?',
      'Summarize my ClickUp tasks for today and suggest an order to do them',
      'Create a ClickUp task from the notes I am about to paste',
    ],
    linear: [
      'What is in my Linear queue today? Flag anything that slipped its cycle',
      'Summarize this cycle’s progress in Linear and what is at risk',
      'Write a Linear issue for the bug I am about to describe',
    ],
    notion: [
      'Find the Notion page where we decided on this and summarize the decision',
      'Turn my notes below into a tidy Notion page in the right database',
      'What changed in Notion this week across the pages I own?',
    ],
    sentry: [
      'Which Sentry issues spiked in the last 24 hours, and what do they have in common?',
      'Walk me through the newest unresolved Sentry issue and suggest a fix',
      'Summarize the Sentry issues assigned to me by impact',
    ],
    neon: [
      'List my Neon projects and branches and flag any branch older than a week',
      'Show the schema of the main Neon database and explain the biggest tables',
      'Find the slowest queries on my Neon database and suggest indexes',
    ],
    vercel: [
      'Read the build logs for my failed Vercel deployment and suggest a fix',
      'Deploy this project to a Vercel preview and give me the link',
      'Use the Vercel AI SDK to add streaming chat to this app',
    ],
    atlassian: [
      'What Jira issues are assigned to me this sprint, ordered by priority?',
      'Summarize the Confluence page I am about to link and list its open questions',
      'Draft a Jira bug from the notes I am about to paste',
    ],
    cloudflare: [
      'List my Cloudflare Workers and explain what the Worker I choose does',
      'Show the R2 buckets and D1 databases available in my Cloudflare account',
      'Check the Cloudflare docs and help me add a KV binding to this Worker',
    ],
    posthog: [
      'What are my top PostHog events this week compared with last week?',
      'Summarize the PostHog feature flags that are on and who they target',
      'Find the PostHog funnel with the biggest drop-off and explain it',
    ],
    amplemarket: [
      'Find people in Amplemarket who match the role and company profile I describe',
      'Research this company in Amplemarket and summarize what we know',
      'List my Amplemarket outreach sequences and explain what each is for',
    ],
    asana: [
      'What is due this week in my Asana projects, and who owns it?',
      'Summarize progress on the Asana project I choose',
      'Find my overdue Asana tasks and help me prioritize them',
    ],
    ashby: [
      'Show my upcoming Ashby interviews and help me prepare',
      'Summarize the hiring pipeline for the Ashby job I choose',
      'Read this Ashby candidate’s profile and draft questions for the interview',
    ],
    canva: [
      'Find my Canva presentation and summarize its content',
      'Check this Canva design against our brand guidelines',
      'Resize this Canva design for the social channels I choose',
    ],
    circleback: [
      'Summarize the decisions from my latest Circleback meeting',
      'Find open action items from this week’s Circleback meetings',
      'Find where we discussed this topic in Circleback and summarize the outcome',
    ],
    clay: [
      'Enrich this company in Clay and summarize the results',
      'Research this person in Clay using the profile I provide',
      'Use Clay to research the company behind this website',
    ],
    docusign: [
      'Check whether this Docusign agreement is waiting for a signature',
      'Summarize the status of the Docusign envelopes I choose',
      'Help me prepare a Docusign envelope from this template',
    ],
    figma: [
      'Read this Figma frame and explain its layout and components',
      'List the design tokens used in the Figma file I share',
      'Turn this Figma frame into an implementation plan for this app',
    ],
    gong: [
      'Summarize this Gong call and list the agreed next steps',
      'Prepare a brief on this account using Gong',
      'Review this Gong deal and summarize the customer’s open questions',
    ],
    'google-calendar': [
      'What is on my Google Calendar today?',
      'Find a free hour on my Google Calendar for focused work this week',
      'Help me find a meeting time using my Google Calendar',
    ],
    'google-drive': [
      'Find the Google Drive document about the topic I describe',
      'Summarize this Google Drive document and list its action items',
      'Find the files related to this project in Google Drive',
    ],
    hubspot: [
      'Summarize the HubSpot deal I choose and its next steps',
      'Find this company in HubSpot and show its associated contacts',
      'Help me update this HubSpot contact with the details I provide',
    ],
    huggingface: [
      'Find Hugging Face models for the task I describe and compare their model cards',
      'Build a Gradio demo for this model and tell me what it needs to run',
      'Inspect this Hugging Face dataset and suggest a training data preparation plan',
    ],
    intercom: [
      'Find Intercom conversations about this issue and summarize the common problems',
      'Read this Intercom conversation and draft a helpful reply',
      'Find the Intercom help article that answers this customer’s question',
    ],
    juicebox: [
      'Summarize the candidates on this Juicebox project’s shortlist',
      'Read this Juicebox candidate’s profile and compare it with the role requirements',
      'Show which recruiting metrics I can report on in Juicebox',
    ],
    navan: [
      'Summarize my upcoming Navan travel bookings',
      'Help me understand the Navan expense policy for this trip',
      'Review my Navan expenses and flag anything that needs my attention',
    ],
    outreach: [
      'Summarize the Outreach sequences I choose',
      'Find the next steps from this Kaia meeting in Outreach',
      'Review this Outreach prospect and help me prepare a follow-up',
    ],
    paypal: [
      'List my unpaid PayPal invoices and show which are overdue',
      'Summarize my PayPal transactions for the month I choose',
      'Draft a PayPal invoice from the line items I provide',
    ],
    playwright: [
      'Open this page and take a screenshot at desktop and mobile sizes',
      'Use Playwright to check that this page’s navigation links work',
      'Walk through this form in the browser and report any validation problems',
    ],
    profound: [
      'Show how often AI answers mention my brand in Profound',
      'Summarize the sources cited about my brand in Profound',
      'Compare the answers to my tracked Profound prompts and flag recurring themes',
    ],
    square: [
      'Summarize the recent orders in my Square account',
      'Find the Square catalog items matching the products I describe',
      'Look up this Square payment and explain its status',
    ],
    supabase: [
      'Review this SQL for Postgres performance and safety before I run it',
      'Help me add Supabase authentication to this app',
      'Help me design row-level security policies for this Supabase schema',
    ],
    webflow: [
      'List the pages on my Webflow site and summarize their content',
      'Show the CMS collections on my Webflow site and explain their schemas',
      'Find the Webflow CMS items matching the topic I describe',
    ],
    x: [
      'Summarize the X timeline I choose',
      'Find posts on X about the topic I describe',
      'Review my X bookmarks and group them by topic',
    ],
    zoom: [
      'Summarize this Zoom meeting transcript and list the decisions',
      'Find the action items from the Zoom meeting I choose',
      'Turn this Zoom transcript into a concise meeting brief',
    ],
    context7: [
      'Look up the current API for the library I name and show a minimal example',
      'Check the docs before answering: how do I configure this framework option?',
      'Compare the latest versions of these two libraries for the feature I describe',
    ],
  }),
);

/** Empty for providers without curated prompts — the band simply omits the rows. */
export function promptsFor(pluginId: string): readonly string[] {
  return PLUGIN_PROMPTS.get(pluginId) ?? [];
}
