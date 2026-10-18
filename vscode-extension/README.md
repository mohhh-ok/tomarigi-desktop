# Tomarigi for VS Code

Lets [Tomarigi](https://github.com/mohhh-ok/tomarigi-desktop) jump to the integrated terminal where an AI coding agent runs, in VS Code, Cursor and other VS Code forks.

Each window writes a small file to `~/.tomarigi/vscode/` with the process ids of its terminals. When you click a bird in Tomarigi, Tomarigi opens a URI addressed to the window that has the agent's terminal, and the extension shows that terminal. The first time, the editor asks whether the extension may open the URI; check "Do not ask me again for this extension" to stop it.
