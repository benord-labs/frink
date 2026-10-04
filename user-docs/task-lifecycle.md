# Task Lifecycle

When Frink runs an agent on your behalf — whether triggered by a webhook, a Shortcut update, or a manual task — the task moves through a series of states. This guide explains how those states work, what triggers transitions between them, and how you stay in control throughout.

## Task states

Every task in Frink has a status that reflects where it is in its lifecycle.

| Status | What it means |
|--------|--------------|
| **Pending** | The task has been created and is waiting for a machine to pick it up. |
| **Running** | An agent is actively working on the task. A task can also be **Running with a plan already waiting** — see the note below. |
| **Plan Ready** | The agent finished in plan mode and is waiting for you to review and approve the proposed changes. |
| **Needs Attention** | The agent has paused and needs your input before it can continue. A flow step you paused yourself with the chat's **Pause** button also sits here; the work queue marks it *Paused by you*, and it waits until you resume it from its chat. |
| **Ready for review** (`done`) | The agent finished execution; the work waits for you to verify it before final closure. Shown as "Review" in the sidebar. |
| **Completed** | You confirmed the outcome — the task is closed. |
| **Failed** | The run hit an execution-level error and could not complete. |
| **Cancelled** | You stopped the task before it finished. |
| **Interrupted** | An app or machine restart stopped the run mid-step. Recoverable, not an error — see below. |

**A plan can be waiting while the task still reads Running.** When an agent plans while background work of its own is still going (research sub-agents, a long command), it can finish the plan between those wake-ups. Frink shows the plan in the chat straight away rather than discarding it, but the task keeps its **Running** status until that background work ends, because the agent has not finished. The plan's **Approve** button becomes available at the same moment. So if a task has been running a while, open its chat — the plan may already be there waiting for you.

**Interrupted** is a view, not a stored status: underneath it is a cancelled run that carries a restart marker. Frink separates the two because they need opposite things from you — a run you *cancelled* is finished business, while an interrupted one still has a worktree, prior step outputs and (usually) a live agent session waiting to be picked up. It appears under **Active → Needs attention** in the work queue (marked *Interrupted*, alongside runs paused for your input — both are work waiting on you) rather than in History, and opening its chat offers **Re-run step** (or **Resume**, when the agent's session and the run's place in the run queue both survived the interruption and the agent had already received the step). Most interrupted agent steps never need this: after a restart Frink picks every interrupted agent step back up by itself, ahead of queued starts — the agent continues where it stopped if it had started the step, or the step is sent its full instructions if they never reached the agent, so no step is skipped — and the chat reads *Waiting for a free slot to resume this step* until it gets one. (The exception is a run interrupted inside a parallel/fan-out step: those can't be resumed, so they stay in History as *Cancelled*.) It leaves Needs attention when you resume it, or when you choose **Cancel** from its row menu: Cancel turns the interruption into a deliberate stop, so the run moves to History as *Cancelled* (where it can be deleted like any other cancelled row) while the run itself stays under **Flows → Runs** history. Deleting the chat still clears it too. See the Flows guide's *Restart recovery* section for what Resume does.

### Renderer-only recovery

If Frink's window process crashes while a Claude task is running, Frink reloads the window once and keeps the main-owned agent process alive. Before the new window declares recovery complete, it restores the live response, Stop control, pending questions and permission or move-chat prompts. The task should carry on in the same chat without repeating the step.

This protection is deliberately narrow: it covers one recoverable renderer-only crash, not a Frink main-process exit, app quit, machine restart or repeated renderer failure. If the reload cannot restore the task safely, Frink stops that execution and surfaces the interruption instead of leaving an invisible background process.

Closing the Frink window is different from quitting the app. On macOS, a running main-owned task keeps going after you close the window and appears again when you open a new one; quitting Frink stops it. An intentional hard reload still interrupts the active run rather than silently attaching it to a new document.

## How the agent signals completion

Unlike traditional automation that simply runs a script and exits, Frink's agents are intelligent about communicating their progress. Each agent has access to a completion signal tool that lets it explicitly declare the outcome of its work.

### Agent-declared states

When an agent finishes working, it tells Frink exactly what happened:

| Signal | Meaning | Task becomes |
|--------|---------|-------------|
| **Done** | The agent finished, but output should be reviewed/confirmed by you first. | Ready for review |
| **Completed** | The agent finished with no follow-up action needed (for example summaries/lookups). | Completed |
| **Awaiting Input** | The agent has a question and needs your guidance before continuing. | Needs Attention |
| **Blocked** | The agent is stuck on something external — a missing API key, a permission issue, a dependency it can't resolve. | Needs Attention |
| **Partial** | The agent made progress but couldn't finish everything. It's telling you what it accomplished and what remains. | Needs Attention |
| **Failed** | The agent tried but hit an unrecoverable error. | Failed |

This means when you see a task in "Needs Attention," you know the agent is actively waiting for you — not that it crashed or gave up.

**Answering an Awaiting Input task.** When an agent pauses for your input, it can either ask in plain text or present **clickable options**. Either way, the chat always gives you a way to answer in place: option questions appear as clickable buttons, and a plain-text ask (or a Blocked/Partial stop) shows the agent's question with a **reply box** right where the message box normally sits. Pick an option or type a reply — both resume the agent. For Awaiting Input tasks, the task's work-queue card and the flow's Runs tab carry an **Answer →** button that jumps you to that chat; Blocked and Partial steps keep their usual recovery actions (Retry/Skip) instead.

> **A question waits about 9½ minutes.** Answer inside that window and the agent carries straight on, as if it had never paused. Leave it longer and the task parks at **Needs Attention** with your question kept — answer whenever you come back and the run resumes. The agent is never told you refused; it simply stops and waits. This is the same in a plain chat and inside a **Flow**, so an unattended automation pauses cleanly rather than stalling. While a flow is waiting on you, its canvas node shows an **amber border** instead of the running pulse. See the Flows guide.
>
> Your answer always repeats the question back to the agent. When a pop-up question times out, the agent normally keeps it — the run is ended without any reply, and on resume the question simply reads as unanswered. Repeating it costs nothing and pins exactly which question your late answer addresses, so every answer carries it.

### What if a run goes quiet without a signal?

Sometimes an agent's run ends without it explicitly declaring a result. That silence is often deliberate — the agent kicked off long background work (a test suite, a slow build, a helper agent) and is waiting for it to finish. A quiet run keeps its **Running** status: nothing is marked complete or parked while the agent may still be waiting. Only after about **45 minutes with no further activity** does the task park at **Needs Attention** with a "run went quiet" note — reply in the chat to resume the agent, or stop the task. If the agent's background work then finishes and the agent wakes on its own, the park lifts automatically: the task returns to **Running** without a reply.

This layered approach means:

1. If the agent signals explicitly — Frink uses that signal (the most reliable path).
2. If the agent goes quiet — the task keeps running while it may be waiting on background work, and parks at Needs Attention after the idle window so you're always in the loop.

## Stopping a task

You can stop a running agent at any time by clicking the **Stop** button in the chat. The guidance in this section applies to **regular (non-flow) chats**.

> In a **flow chat** the message box is replaced by a status strip while the run is live, with its own controls — and the verbs differ: **Pause** is the resumable park-and-continue control, while the strip's **Stop** *cancels the flow run for good* (it is not a pause). See "Pausing and stopping a flow from the chat" in the Flows guide.

When you stop an agent in a regular chat, the task stays in **Running** status — not failed. This is intentional. Stopping an agent is a normal part of the workflow. You might stop it because you want to give it different instructions, because you realised the task description was wrong, or because you just want to take over manually.

After stopping, you can:

- **Send a follow-up message** to redirect the agent with new instructions. The agent picks up where it left off with your additional context.
- **Leave it for later.** If you don't interact with the task for a while, Frink will eventually move it to Needs Attention so it doesn't sit in Running forever.

Stopping is not a failure — it's a pause.

### Cancel or Delete in the work queue

Each work-queue row offers one way out. **Cancel** stops work that is still going or waiting on you (Running, Plan Ready, Needs Attention, Interrupted, or a Pending task whose chat already exists) and keeps the record in **History**. **Delete** removes a record once nothing is running (Ready for review, Completed, Failed, Cancelled, or a Pending task that never started).

Cancelling a flow's task cancels the whole flow run, because the work queue shows one row per run. Other tasks of that run that were waiting for your input are kept, not removed.

### Deleting or archiving a chat with a live task

Removing a chat can also affect its linked task. How Frink handles this depends on where the task is in its lifecycle:

- **The task is still actively working** (Pending, Running, or Plan Ready) — Frink asks first, since deleting the chat would otherwise leave the task running with nowhere to surface it. You can **stop the task and remove the chat** together, or keep the task running and only remove the chat.
- **The task has finished or is waiting on you** (Ready for review, Needs Attention, Completed, Failed, or Cancelled) — there's nothing actively running to stop, so the chat is removed right away with no prompt. A task waiting on you (Needs Attention) is left as-is so you can still return to it from the work queue.

Those rules apply to regular chats whether you delete or archive them. Archiving is recoverable — restore it from the Archived view.

**The archive shortcut follows the same rules.** Pressing **Archive current agent** (Cmd+Shift+D by default; you can change it in Settings → Keyboard) archives the chat you are looking at. If its linked task is still actively working, Frink asks first, exactly as above. Otherwise the chat is archived straight away, and its running replies, flow runs, and terminals are stopped. The shortcut only works while a chat is on screen on desktop; it does nothing in Work Queue, Flows, or Settings.

Flow chats follow the Flow lifecycle instead. Permanently deleting a flow chat stops its linked run and removes that chat's work-queue tasks, including Needs Attention rows. Archiving keeps parked work available so you can restore the chat and continue.

## How runtime errors map to status

Frink classifies runtime errors into two buckets:

- **Execution-level failure -> Failed**
  - Example: `API Error: 400 ... tool_use ids were found without tool_result blocks ...`
  - Why: the run payload is invalid for continuation, so this attempt is terminal.
- **Recoverable/transient -> Needs Attention**
  - Examples: network disconnects, machine offline, auth/session issues, provider rate limits.
  - Why: these are usually retriable or require user/environment action rather than a hard execution failure.

This is why not every API/provider error is "Failed." If the error is transient or environmental, Frink keeps the task actionable in **Needs Attention**.

## Following up on a failed task

When a task genuinely fails — the run hit an execution-level error or unrecoverable problem — you have two options:

**Retry** — Click the Retry button to re-run the original task from scratch. This creates a fresh attempt as if you'd just triggered it. Use this when the failure was transient (a network blip, a temporary service outage) and the original instructions are still correct.

**Send a follow-up message** — Type a message in the chat to continue working on the problem with additional context. The agent picks up the conversation with everything it learned from the failed attempt, plus your new guidance. The task moves back to Running. Use this when you want to course-correct ("try a different approach" or "here's the missing information you needed").

Both actions are intentional — the task won't change state on its own. If you don't interact with a failed task, it stays failed.

## Completion signals in trigger rules

When you create an automation rule (Settings > Automations), you configure how the task should behave when the agent finishes. This is the **Completion Signal** setting on the trigger rule.

### Agent Signal (recommended)

The agent uses its completion signal tool to declare the outcome. This is the most reliable option because the agent communicates exactly what happened — whether it succeeded, needs your input, or hit a problem.

If the agent's run ends without it calling the signal tool, the task keeps running — the agent may be waiting on background work — and parks at Needs Attention only after about 45 minutes with no further activity. A park like that lifts on its own if the agent wakes and continues.

### Manual

The task always moves to Needs Attention when the agent finishes, regardless of what the agent reports. You must manually mark the task as complete. Use this for high-stakes automations where you always want to review the output before considering it done.

## Task states at a glance

Here's how tasks flow through the system:

```
Trigger fires
    |
    v
 Pending ──── Machine claims it ───> Running
                                        |
                 ┌──────────────────────┼───────────────────────┬───────────────────┐
                 |                      |                       |                   |
                 v                      v                       v                   v
            Plan Ready          Ready for review          Needs Attention        Failed
          (plan-mode review)   (work needs review)  (awaiting input/blocked/    (genuine error)
                 |                      |             partial/missing signal)          |
                 v                      v                       |                  ┌───┴───┐
          You approve plan      You mark complete               v                  |       |
                 |                      |                 You respond            Retry  Follow-up
                 v                      v                 Back to Running        (fresh) (continue)
              Running -------------> Completed
```

Note: After approving a plan, the subsequent execution moves to Ready for review / Completed (not back to Plan Ready).

For tasks started in **plan mode**, a successful completion goes to **Plan Ready** instead of Completed, so you can review the proposed changes before they're applied.

### Marking work complete

A task in **Ready for review** stays there until you accept it — sending follow-up messages to the agent doesn't close it. You can mark it complete from any of three places:

- **In the chat** — a "Ready for review" bar appears above the message box with **Mark complete** and **Complete & Archive** buttons. *Complete & Archive* accepts the result and clears the chat from your sidebar in one step — handy for closing out finished parallel runs. Archiving is recoverable: restore the chat from the Archived view.
- **In the work queue** — open the task menu and choose **Mark complete**. Completed and cancelled work appears in **History**, where the **All**, **Completed**, and **Cancelled** filters narrow the loaded rows.
- **In the sidebar** — open the chat's row menu and choose **Mark complete**.

Accepting a flow's task accepts the whole run. For flow tasks, the accept options only appear once the run has **completed** — its final node finished. If the run was cancelled or failed partway, its tasks can't be accepted: the partial work stays reviewable in the chat and diff, and the flow can be re-run, but unfinished work is never marked complete. Flows can also skip the review gate entirely with the **Auto-accept completed runs** setting — see the Flows guide.

## Tips

- **Check Needs Attention regularly.** This is where agents are waiting for you. A quick answer can unblock an agent and let it finish the job.
- **Use follow-up messages for context.** If an agent is stuck or failed, sending a message with more information is often faster than retrying from scratch.
- **Manual completion signal is your safety net.** For important automations (deploying to production, modifying shared infrastructure), set the completion signal to Manual so you always review the output.
- **Stopping is free.** Don't hesitate to stop an agent if it's going in the wrong direction. You can always redirect it with a follow-up message.
