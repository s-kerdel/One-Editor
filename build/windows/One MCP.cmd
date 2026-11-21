@echo off
setlocal DisableDelayedExpansion
rem One's MCP server over stdio, for MCP clients (LM Studio, Codex CLI, Claude) and for WSL:
rem   cmd.exe /c "C:\Apps\One\One MCP.cmd"
rem It prints nothing itself: stdout belongs to the protocol. Switch it on first: One - Settings - MCP server.
rem Extra arguments pass through, e.g.  "One MCP.cmd" --folder notes --read-only
rem Uses One.exe in Node mode - no Node.js install needed.
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0One.exe" "%~dp0resources\app.asar.unpacked\dist\mcp\cli.mjs" --stdio %*
