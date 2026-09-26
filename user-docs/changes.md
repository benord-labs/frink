# Reviewing what the agent changed

The **Changes** panel shows every file the agent has changed in a chat's folder that isn't committed yet. Open it with the **View changes** button in the chat header, or **⌘D**.

The panel only shows changes. It never edits, commits or uploads anything itself. When you want something done with them, you ask the agent.

## Reading the changes

- Each changed file has its own section with the lines that were added (green) and removed (red).
- The row under the header counts the files and the lines added and removed.
- Click a file's name to open it in the editor. Right-click it to reveal it in Finder or copy its path.
- Collapse one file with the arrow next to its name, or all of them with the button at the top.
- Switch between one column and old-and-new side by side with the layout button at the top.
- Select some lines and add them to your message to ask the agent about them.

When you open the panel from a sub-chat's list of edited files, it shows only those files. **Show all** brings the rest back. Clicking an edit in the chat opens the panel on that file.

## Asking the agent to act

The **Ask agent** menu at the top of the panel sends the agent a message with the steps to follow:

| Choose | The agent will |
|--------|----------------|
| **Commit changes** | commit what changed, without uploading it |
| **Create pull request** | commit, push, and open a pull request |
| **Commit and push to PR** | add your latest changes to the open pull request |
| **Review changes** | review the branch's changes and list any problems it finds |
| **Fix merge conflicts** | bring in the latest base branch and resolve the conflicts |
| **Merge pull request** | check the pull request can be merged, then merge it |

The pull request items appear only when they apply: merging and fixing conflicts need an open pull request. While Frink is still checking whether the branch has a pull request, the menu shows **Checking for a pull request…** in their place. The menu waits until the agent has received one request before it accepts the next.

When the window is narrow, the panel fills the window and has no **Ask agent** menu. Go back to the chat to ask.

To undo something, ask the agent, or roll the chat back to an earlier message.

## When the panel is empty

- **"No uncommitted changes"**: everything is committed, or the agent hasn't changed anything yet.
- **"This folder isn't tracked by git"**: the project folder isn't a git repository, so there's nothing to compare against.
