# Plugins

Plugins connect the tools you already use to Frink. Each one gives your chats a set of tools ("search Notion", "look up a Linear issue"), and some also power Flows with triggers and actions.

## Two kinds of plugin

| Kind                                                                                      | What it does                                             | How you connect                                                                                                                                                                                     |
| ----------------------------------------------------------------------------------------- | -------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Flows + chat** (Linear, Shortcut, ClickUp, PostHog and the rest of the trigger catalog) | Triggers and actions for Flows, plus tools in your chats | Connect once, on the plugin page: one sign-in in your browser where the consent screen names "Frink", or a token you paste. The trigger address is made on your Mac, so it needs no sign-in at all. |
| **Chat and actions** (plugins without triggers)                                           | Tools in your chats; some also add ready-made Flow steps | Connect on the plugin page: one sign-in in your browser, where the consent screen names "Frink".                                                                                                    |

Every connected HTTP MCP plugin gets a "Call any … tool" step in the Flow builder under Integrations, which runs any tool the plugin's server offers: pick the tool from a searchable list (tools that only read come first; ones that change data are marked), then fill in its fields. "Edit as JSON" switches the fields to one JSON text when you want to paste or template the whole thing. A plugin step hands the next step what the tool said as `{{previous.text}}` (the full reply is `{{previous.result}}`); a tool that refuses fails the step with its own message. Some plugins also ship ready-made named steps for their everyday jobs; a plugin's page lists the ones it has. Turn off hides them all; Turn on brings them back without another sign-in. A step's structured settings (filters, date ranges) take raw JSON in a text box; settings the form cannot show are listed under the step so nothing is hidden.

Where a service has no sign-in path for chat tools (GitHub), Connect asks you to paste a personal access token instead and checks it with the service before keeping it. Example prompts on a plugin page unlock the same way: a click on a locked prompt runs that plugin's Connect.

## Letting a service tell Frink when something happens

A Flow can start the moment something happens somewhere else. Frink receives those events for you and there is nothing to set up for that; what is left is either **Set up automatically**, where Frink arranges it inside the service, or a short **Set up _Service_ events** panel with numbered steps to follow. The plugin's Triggers card says which, and each service arranges it its own way:

- **Paste an address** (Shortcut, Atlassian and the generic webhook): the setup panel gives you a Frink address and a Frink secret. Copy both into that service's own webhook settings, and the card then shows when it last heard from the service, so you can tell the setup worked. Shortcut and the generic webhook let you make several addresses and turn one off without touching the others.
- **Paste an address, then bring back the service's own secret** (Linear, Sentry, Square, Vercel): paste Frink's address into the service's webhook settings, then copy the signing secret the service shows you into Frink in the setup panel. If Frink set up a Linear webhook for you in an earlier version, delete that one in Linear's webhook settings yourself — Frink no longer manages it.
- **ClickUp** connects its chat tools with one browser sign-in. For triggers, choose **Set up automatically**, enter a ClickUp API token and choose your workspace. Frink creates the webhook and saves its signing secret. Advanced setup also lets you create a webhook through ClickUp's API and paste its returned secret into Frink.

Receiving events is free and best effort. They only arrive while Frink is open and this computer is online: anything a service sends before Frink reconnects is missed, not queued for later.

## Run your own relay or tunnel

A service can only send an event to an address on the internet, and your computer is not one. Frink runs a small address that takes the delivery and passes it straight to this app without keeping a copy; every trigger address hangs off it, and there is nothing to set up for that. It is best effort, and Frink may move it or switch it off.

To use your own copy of Frink's relay, or a tunnel to this computer, set `FRINK_WEBHOOK_BASE_URL` to its `https://` address before starting Frink. Put it somewhere that outlives a restart: Frink reads it every time it starts, and a start without it is a move back to Frink's own address, which changes every trigger address as below.

- **macOS** (the packaged app): `sudo launchctl config user setenv FRINK_WEBHOOK_BASE_URL https://…`, then restart the computer. `launchctl setenv` on its own is forgotten when you log out.
- **Windows**: add it as a user environment variable, then reopen Frink.
- **Linux**: put `FRINK_WEBHOOK_BASE_URL=https://…` in `~/.config/environment.d/frink.conf`, then log out and back in. A shell profile only reaches Frink when you start it from a terminal.

Changing the address to a different one gives every trigger a new address: Frink deletes the webhooks it set up for you, so open those plugins and set them up again, and anywhere you pasted an address into a service yourself, paste the new one in its place.

A blank value, or one Frink refuses, means this computer only — nothing on the internet can reach Frink. That is not a change of address: Frink takes nothing down, so every service keeps sending to the address you had, and whatever was answering there can still read what they send. Turn those triggers off in each plugin while your address is still set, before you retire it. Two services (Cloudflare and Hugging Face) prove who they are by putting the secret in the message itself, so anything in the middle can read it: send those through your own address rather than Frink's.

## What the badges mean

- **Needs connection**: the plugin is ready, but you have not signed in yet.
- **Connected**: every sign-in the plugin needs is done — your chats get its tools, and Flows can use its account if it has one. Until then the badge stays Needs connection and Connect finishes whatever is left.
- **Coming soon**: listed so you can see what is on the way, but not connectable yet. A row stays here only while Frink cannot connect it yet, for example a vendor that has no public sign-in path for apps like Frink. The Coming soon section stays folded at the bottom of the directory.

## What to expect

- New tools reach **new** chats. A chat that is already running keeps the tools it started with until it ends.
- In auto mode, plugin tools are reviewed by your provider like any other tool, so a chat does not stop to ask you.
- With auto mode off, a chat asks the first time it uses each plugin tool. Choosing **Always allow** remembers that one tool, on this machine or in this project.
- Flows follow their own **Auto Mode** setting, which is on unless you turn it off.
- Chat grants (browser sign-ins and pasted tokens) and trigger addresses are stored only on this Mac, so adding a plugin, turning it on or off, and using it all work on this Mac alone. Turn a plugin off to pause its tools without signing out. Remove forgets Frink's copy of the grant — revoke it in the service's own settings if you want it gone entirely.

Package skills and example prompts are visible before you connect. Connecting unlocks their use; it does not change what the plugin contains.
